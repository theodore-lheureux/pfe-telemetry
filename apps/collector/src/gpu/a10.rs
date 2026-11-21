#[path = "../../../../tests/fixtures/gpu/a10/fixture.rs"]
mod fixture;

use super::{
    export,
    tests::{UUID, attributes},
};
use opentelemetry_proto::tonic::metrics::v1::{
    NumberDataPoint, ResourceMetrics, metric::Data, number_data_point::Value as Number,
};
use recount_nvidia_dcgm::{Device, Error, FIELDS, Reading, Value};
use recount_telemetry_schema::point::string_attribute;
use recount_telemetry_validation::{catalogue as c, validate};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

fn recorded_device(sample: &fixture::Sample, time_ns: u64) -> Device {
    let offered: BTreeSet<_> = fixture::groups()
        .into_iter()
        .flat_map(|(_, _, fields)| fields)
        .collect();
    let readings = FIELDS
        .iter()
        .map(|field| {
            let value = if field.profiling() && !offered.contains(&(*field as u16)) {
                Err(Error::Unsupported)
            } else if let Some((id, text)) =
                sample.fields.iter().find(|(id, _)| *id == *field as u16)
            {
                if *id == 155 || (1001..=1008).contains(id) {
                    Ok(Value::Double(text.parse().unwrap()))
                } else {
                    Ok(Value::Integer(text.parse().unwrap()))
                }
            } else {
                Err(Error::Unavailable)
            };
            Reading {
                field: *field,
                time_ns,
                value,
            }
        })
        .collect();
    Device {
        uuid: UUID.into(),
        parent_uuid: None,
        readings,
        profiling: Ok(()),
        multiplexed: true,
    }
}

fn points<'a>(resource: &'a ResourceMetrics, metric: &str) -> Vec<&'a NumberDataPoint> {
    resource
        .scope_metrics
        .iter()
        .flat_map(|scope| &scope.metrics)
        .filter(|reading| reading.name == metric)
        .filter_map(|reading| match &reading.data {
            Some(Data::Gauge(gauge)) => Some(gauge),
            _ => None,
        })
        .flat_map(|gauge| &gauge.data_points)
        .collect()
}

#[test]
fn a10_recorded_phases_keep_native_meanings_units_and_unavailable_fp64() {
    let mut phases = BTreeSet::new();
    for (index, sample) in fixture::samples().iter().enumerate() {
        phases.insert(sample.phase);
        // The CLI supplied no native timestamps; this replay clock is synthetic.
        let now = 1_000_000_000 + index as u64 * 1_000_000_000;
        let resources = export::resources(
            &[recorded_device(sample, now)],
            &mut BTreeMap::new(),
            attributes(),
            now,
            Duration::from_secs(1),
            None,
        );
        assert_eq!(resources.len(), 1);
        let resource = &resources[0];
        for metric in &resource.scope_metrics[0].metrics {
            c::validate_adapter_metric(metric, c::Adapter::Linux).unwrap();
        }
        let request =
            opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest {
                resource_metrics: resources.clone(),
            };
        validate::request(&request, Default::default()).unwrap();

        let pipe = points(resource, c::GPU_PIPE_ACTIVITY.name);
        assert_eq!(pipe.len(), 3);
        for (name, field) in [("tensor", 1004), ("fp32", 1007), ("fp16", 1008)] {
            let actual = pipe
                .iter()
                .find(|point| string_attribute(&point.attributes, "gpu.pipe") == Some(name))
                .unwrap();
            assert_eq!(
                actual.value,
                Some(Number::AsDouble(sample.value(field).parse().unwrap())),
                "{} source line {} pipe {name}",
                sample.phase,
                sample.source_line
            );
        }
        assert!(
            !pipe
                .iter()
                .any(|point| string_attribute(&point.attributes, "gpu.pipe") == Some("fp64"))
        );
        let status = points(resource, c::READ_STATUS.name);
        let unsupported = status
            .iter()
            .find(|point| string_attribute(&point.attributes, "gpu.pipe") == Some("fp64"))
            .unwrap();
        assert_eq!(unsupported.value, Some(Number::AsInt(1)));
        assert!(points(resource, c::GPU_NVLINK_THROUGHPUT.name).is_empty());
        assert!(
            status
                .iter()
                .filter(
                    |point| string_attribute(&point.attributes, "recount.metric.name")
                        == Some(c::GPU_NVLINK_THROUGHPUT.name)
                )
                .all(|point| point.value == Some(Number::AsInt(6)))
        );

        assert_eq!(
            points(resource, c::GPU_UTILIZATION.name)[0].value,
            Some(Number::AsDouble(if sample.phase == "idle" {
                0.0
            } else {
                1.0
            }))
        );
        assert_eq!(
            points(resource, c::GPU_MEMORY_USED.name)[0].value,
            Some(Number::AsInt(
                sample.value(252).parse::<i64>().unwrap() * 1_048_576
            ))
        );
        assert_eq!(
            points(resource, c::GPU_MEMORY_ACTIVITY.name)[0].value,
            Some(Number::AsDouble(
                sample.value(204).parse::<f64>().unwrap() / 100.0
            ))
        );
        for (direction, field) in [("tx", 1009), ("rx", 1010)] {
            let rates = points(resource, c::GPU_PCIE_THROUGHPUT.name);
            let rate = rates
                .iter()
                .find(|point| {
                    string_attribute(&point.attributes, "gpu.io.direction") == Some(direction)
                })
                .unwrap();
            assert_eq!(
                rate.value,
                Some(Number::AsDouble(sample.value(field).parse().unwrap()))
            );
        }
        assert_eq!(
            points(resource, c::GPU_POWER.name)[0].value,
            Some(Number::AsDouble(sample.value(155).parse().unwrap()))
        );
        assert_eq!(
            points(resource, c::GPU_TEMPERATURE.name)[0].value,
            Some(Number::AsInt(sample.value(150).parse().unwrap()))
        );
        for (domain, field) in [("sm", 100), ("memory", 101)] {
            let clocks = points(resource, c::GPU_CLOCK.name);
            let clock = clocks
                .iter()
                .find(|point| {
                    string_attribute(&point.attributes, "gpu.clock.domain") == Some(domain)
                })
                .unwrap();
            assert_eq!(
                clock.value,
                Some(Number::AsInt(
                    sample.value(field).parse::<i64>().unwrap() * 1_000_000
                ))
            );
        }
    }
    assert_eq!(
        phases,
        BTreeSet::from(["idle", "tensor", "fp32", "fp16", "sm"])
    );
}

#[test]
fn equally_saturated_conventional_utilization_is_not_a_pipe_or_sm_proxy() {
    let samples = fixture::samples();
    let phase = |name| samples.iter().find(|sample| sample.phase == name).unwrap();
    for name in ["tensor", "fp32", "fp16", "sm"] {
        assert_eq!(phase(name).value(203), "100");
    }
    assert_eq!(phase("tensor").value(1004), "0.927");
    assert_eq!(phase("tensor").value(1007), "0.000");
    assert_eq!(phase("fp32").value(1004), "0.000");
    assert_eq!(phase("fp32").value(1007), "0.568");
    assert_eq!(phase("fp16").value(1007), "0.000");
    assert_eq!(phase("fp16").value(1008), "0.878");
    let sm: Vec<_> = samples
        .iter()
        .filter(|sample| sample.phase == "sm")
        .collect();
    assert_eq!(sm.len(), 3);
    assert_eq!(
        sm.iter()
            .map(|sample| sample.value(1002))
            .collect::<Vec<_>>(),
        ["0.052", "0.430", "0.940"]
    );
    assert_eq!(
        sm.iter()
            .map(|sample| sample.value(1003))
            .collect::<Vec<_>>(),
        ["0.001", "0.009", "0.020"]
    );
}
