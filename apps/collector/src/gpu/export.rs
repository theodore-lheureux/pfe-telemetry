use std::{collections::BTreeMap, time::Duration};

use opentelemetry_proto::tonic::{
    common::v1::{InstrumentationScope, KeyValue},
    metrics::v1::{ResourceMetrics, number_data_point::Value},
};
use recount_nvidia_dcgm::{Device, Error, Field};
use recount_telemetry_validation::{catalogue, linux_adapter as adapter};

use super::mapping;
use crate::{
    diagnostics::ReadStatus,
    metrics::{Distribution, gauge, histogram, integer, point, resource, string},
};

pub(super) fn resources(
    devices: &[Device],
    seen: &mut BTreeMap<(String, Field), u64>,
    attributes: Vec<KeyValue>,
    now: u64,
    interval: Duration,
    completed_ns: Option<u64>,
) -> Vec<ResourceMetrics> {
    let age_ns =
        u64::try_from((interval.max(Duration::from_secs(1)) * 3).as_nanos()).unwrap_or(u64::MAX);
    let mut physical = BTreeMap::new();
    let mut resources: Vec<_> = devices
        .iter()
        .filter(|device| {
            adapter::gpu_uuid(&device.uuid)
                && device.parent_uuid.as_ref().is_none_or(|parent| {
                    device.uuid.starts_with("MIG-")
                        && parent.starts_with("GPU-")
                        && adapter::gpu_uuid(parent)
                })
                && (!device.uuid.starts_with("MIG-") || device.parent_uuid.is_some())
        })
        .map(|device| {
            let mut board = (completed_ns.is_some() && device.parent_uuid.is_none())
                .then(|| physical.entry(device.uuid.as_str()).or_insert([None; 3]));
            let mut metrics = vec![];
            let mut statuses = vec![];
            for reading in &device.readings {
                let (definition, dimensions) = mapping::definition(reading.field);
                let result = reading.value.as_ref().map_err(|e| *e).and_then(|value| {
                    if device.parent_uuid.is_some() && !reading.field.instance_scoped() {
                        return Err(Error::Unsupported);
                    }
                    if reading.time_ns == 0
                        || reading.time_ns > now
                        || now.saturating_sub(reading.time_ns) > age_ns
                    {
                        return Err(Error::Unavailable);
                    }
                    let key = (device.uuid.clone(), reading.field);
                    if seen.get(&key).is_some_and(|last| *last >= reading.time_ns) {
                        return Err(Error::Unavailable);
                    }
                    let converted = mapping::value(reading.field, value)?;
                    seen.insert(key, reading.time_ns);
                    Ok(converted)
                });
                let status = match result {
                    Ok(value) => {
                        if let Some(board) = &mut board {
                            observe_board(board, reading.field, value);
                        }
                        metrics.push(gauge(
                            definition,
                            vec![point(value, reading.time_ns, 0, dimensions.clone())],
                        ));
                        ReadStatus::Read
                    }
                    Err(error) => mapping::status(error),
                };
                let mut labels = dimensions;
                labels.push(string("recount.metric.name", definition.name));
                statuses.push(point(Value::AsInt(status as i64), now, 0, labels));
            }
            metrics.push(gauge(&catalogue::READ_STATUS, statuses));
            let mut attrs = dcgm_attributes(attributes.clone(), interval);
            attrs.push(string(adapter::GPU_UUID, &device.uuid));
            if let Some(parent) = &device.parent_uuid {
                attrs.push(string(adapter::GPU_PARENT_UUID, parent));
            }
            dcgm_resource(
                attrs,
                metrics,
                vec![integer(
                    "gpu.profiling.multiplexing_possible",
                    i64::from(device.multiplexed),
                )],
            )
        })
        .collect();
    if let Some(time) = completed_ns
        && !physical.is_empty()
    {
        let mut attrs = dcgm_attributes(attributes, interval);
        attrs.retain(|a| a.key != adapter::SCOPE);
        attrs.push(string(adapter::SCOPE, adapter::Scope::Node.as_str()));
        resources.push(board_distributions(attrs, physical.into_values(), time));
    }
    resources
}

fn observe_board(board: &mut [Option<f64>; 3], field: Field, value: Value) {
    let (index, value) = match (field, value) {
        (Field::Utilization, Value::AsDouble(v)) if (0.0..=1.0).contains(&v) => (0, v),
        (Field::MemoryUsed, Value::AsInt(v)) if v >= 0 => (1, v as f64),
        (Field::Power, Value::AsDouble(v)) if v.is_finite() && v >= 0.0 => (2, v),
        _ => return,
    };
    board[index] = Some(value);
}

fn board_distributions(
    attrs: Vec<KeyValue>,
    boards: impl Iterator<Item = [Option<f64>; 3]>,
    time: u64,
) -> ResourceMetrics {
    let mut distributions = [
        Distribution::new((0..=10).map(|i| f64::from(i) / 10.0).collect()),
        Distribution::new(
            std::iter::once(0.0)
                .chain((20..=38).map(|i| (1_u64 << i) as f64))
                .collect(),
        ),
        Distribution::new(vec![
            0., 25., 50., 100., 150., 200., 300., 400., 600., 1000.,
        ]),
    ];
    for board in boards {
        for (dist, value) in distributions.iter_mut().zip(board) {
            if let Some(value) = value {
                dist.observe(value);
            }
        }
    }
    let mut metrics = Vec::new();
    let mut coverage = Vec::new();
    for (definition, dist) in [
        &catalogue::NODE_GPU_UTILIZATION_DISTRIBUTION,
        &catalogue::NODE_GPU_MEMORY_DISTRIBUTION,
        &catalogue::NODE_GPU_POWER_DISTRIBUTION,
    ]
    .into_iter()
    .zip(distributions)
    {
        coverage.push(point(
            Value::AsInt(dist.count() as i64),
            time,
            0,
            vec![string("recount.metric.name", definition.name)],
        ));
        if let Some(point) = dist.finish(time, vec![]) {
            metrics.push(histogram(definition, vec![point]));
        }
    }
    metrics.push(gauge(&catalogue::GPU_COVERAGE, coverage));
    dcgm_resource(attrs, metrics, vec![])
}

fn dcgm_attributes(mut attrs: Vec<KeyValue>, interval: Duration) -> Vec<KeyValue> {
    attrs.retain(|a| a.key != "recount.collection.source" && a.key != adapter::INTERVAL_NS);
    attrs.push(string("recount.collection.source", "dcgm"));
    attrs.push(integer(
        adapter::INTERVAL_NS,
        i64::try_from(interval.max(Duration::from_secs(1)).as_nanos()).unwrap_or(i64::MAX),
    ));
    attrs
}

fn dcgm_resource(
    attrs: Vec<KeyValue>,
    metrics: Vec<opentelemetry_proto::tonic::metrics::v1::Metric>,
    scope_attrs: Vec<KeyValue>,
) -> ResourceMetrics {
    let mut resource = resource(attrs, metrics);
    resource.scope_metrics[0].scope = Some(InstrumentationScope {
        name: "recount.collector.dcgm".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        attributes: scope_attrs,
        ..Default::default()
    });
    resource
}
