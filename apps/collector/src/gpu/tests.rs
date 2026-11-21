use super::{Gpu, export, mapping};
use crate::{
    metrics::{integer, string},
    point_count,
};
use opentelemetry_proto::tonic::{
    common::v1::KeyValue,
    metrics::v1::{metric::Data, number_data_point::Value as Number},
};
use recount_nvidia_dcgm::{Device, Error, Field, Reading, Value};
use recount_telemetry_validation::{catalogue, linux_adapter as adapter};
use std::{
    collections::BTreeMap,
    sync::mpsc::sync_channel,
    time::{Duration, Instant},
};

pub(super) const UUID: &str = "GPU-5fd15f35-e148-2992-4ecb-9825e534f253";
const NOW: u64 = 1_700_000_000_000_000_000;

pub(super) fn attributes() -> Vec<KeyValue> {
    vec![
        string(adapter::HOST_ID, "test-host"),
        string(adapter::BOOT_ID, "01234567-89ab-cdef-0123-456789abcdef"),
        string(adapter::EPOCH_ID, "epoch"),
        string(adapter::SCOPE, "gpu"),
        integer(adapter::INTERVAL_NS, 1_000_000_000),
    ]
}

fn device() -> Device {
    Device {
        uuid: UUID.into(),
        parent_uuid: None,
        multiplexed: true,
        profiling: Ok(()),
        readings: vec![
            Reading {
                field: Field::Tensor,
                time_ns: NOW,
                value: Ok(Value::Double(0.928)),
            },
            Reading {
                field: Field::Fp32,
                time_ns: NOW,
                value: Ok(Value::Double(0.0)),
            },
            Reading {
                field: Field::Fp64,
                time_ns: NOW,
                value: Err(Error::Unsupported),
            },
            Reading {
                field: Field::MemoryUsed,
                time_ns: NOW,
                value: Ok(Value::Integer(1024)),
            },
        ],
    }
}

#[test]
fn profiling_is_catalogued_ratios_with_pipe_dimensions_and_native_time() {
    let resources = export::resources(
        &[device()],
        &mut BTreeMap::new(),
        attributes(),
        NOW,
        Duration::from_secs(1),
        None,
    );
    assert_eq!(resources.len(), 1);
    let request = opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest {
        resource_metrics: resources.clone(),
    };
    assert_eq!(
        recount_telemetry_validation::validate::request(
            &request,
            recount_telemetry_validation::validate::Limits::default()
        )
        .unwrap() as u64,
        point_count(&resources)
    );
    let identity =
        adapter::resource_identity(&resources[0].resource.as_ref().unwrap().attributes).unwrap();
    assert_eq!(identity.gpu, Some(UUID));
    let scope = &resources[0].scope_metrics[0];
    assert_eq!(scope.scope.as_ref().unwrap().name, "recount.collector.dcgm");
    let mut ratios = vec![];
    for metric in &scope.metrics {
        catalogue::validate_adapter_metric(metric, catalogue::Adapter::Linux).unwrap();
        let Some(Data::Gauge(gauge)) = &metric.data else {
            panic!("Gauge expected")
        };
        if metric.name == catalogue::GPU_PIPE_ACTIVITY.name {
            assert_eq!(metric.unit, "1");
            ratios.extend(gauge.data_points.iter().map(|point| {
                assert_eq!(point.start_time_unix_nano, 0);
                assert_eq!(point.time_unix_nano, NOW);
                assert!(point.attributes.iter().any(|a| a.key == "gpu.pipe"));
                point.value
            }));
        }
        if metric.name == catalogue::GPU_MEMORY_USED.name {
            assert_eq!(
                gauge.data_points[0].value,
                Some(Number::AsInt(1_073_741_824))
            );
        }
    }
    assert_eq!(
        ratios,
        [Some(Number::AsDouble(0.928)), Some(Number::AsDouble(0.0))]
    );
}

#[test]
fn repeated_or_stale_samples_have_only_unavailable_status_not_fresh_zero() {
    let mut seen = BTreeMap::new();
    let devices = [device()];
    export::resources(
        &devices,
        &mut seen,
        attributes(),
        NOW,
        Duration::from_secs(1),
        None,
    );
    let repeated = export::resources(
        &devices,
        &mut seen,
        attributes(),
        NOW + 1,
        Duration::from_secs(1),
        None,
    );
    assert!(
        repeated[0].scope_metrics[0]
            .metrics
            .iter()
            .all(|m| m.name == catalogue::READ_STATUS.name)
    );
    let stale = export::resources(
        &devices,
        &mut BTreeMap::new(),
        attributes(),
        NOW + 4_000_000_000,
        Duration::from_secs(1),
        None,
    );
    assert!(
        stale[0].scope_metrics[0]
            .metrics
            .iter()
            .all(|m| m.name == catalogue::READ_STATUS.name)
    );
}

#[test]
fn no_gpu_and_a_hung_optional_source_do_not_add_points_or_wait() {
    assert!(
        export::resources(
            &[],
            &mut BTreeMap::new(),
            attributes(),
            NOW,
            Duration::from_secs(1),
            None,
        )
        .is_empty()
    );
    let (requests, _owned_receiver) = sync_channel(1);
    let (_owned_sender, responses) = sync_channel(1);
    let mut gpu = Gpu {
        requests,
        responses,
        pending: false,
        generation: 0,
        disabled: false,
        interval: Duration::from_secs(1),
        next_request: Instant::now(),
        last_response: Instant::now(),
        seen: BTreeMap::new(),
        known: vec![],
        discovery: None,
        processes: vec![],
        process_status: None,
    };
    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(
            point_count(&gpu.sample(attributes(), NOW, super::ProcessContext::default)),
            0
        );
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(gpu.discovery.is_none());
}

#[test]
fn mig_never_receives_board_metrics_or_an_unverified_identity() {
    let mut mig = device();
    mig.uuid = "MIG-01234567-89ab-cdef-0123-456789abcdef".into();
    assert!(
        export::resources(
            &[mig.clone()],
            &mut BTreeMap::new(),
            attributes(),
            NOW,
            Duration::from_secs(1),
            None,
        )
        .is_empty()
    );
    mig.parent_uuid = Some(UUID.into());
    mig.readings = vec![Reading {
        field: Field::Power,
        time_ns: NOW,
        value: Ok(Value::Double(70.0)),
    }];
    let resources = export::resources(
        &[mig],
        &mut BTreeMap::new(),
        attributes(),
        NOW,
        Duration::from_secs(1),
        None,
    );
    assert!(
        resources[0].scope_metrics[0]
            .metrics
            .iter()
            .all(|m| m.name == catalogue::READ_STATUS.name)
    );
    assert_eq!(
        mapping::value(Field::NvlinkRx, &Value::Integer((1 << 53) + 1)),
        Err(Error::OutOfRange)
    );
}

#[test]
fn a_clock_epoch_change_discards_inflight_gpu_results_and_old_diagnostics() {
    let (requests, _request_receiver) = sync_channel(1);
    let (sender, responses) = sync_channel(1);
    let mut gpu = Gpu {
        requests,
        responses,
        pending: false,
        generation: 0,
        disabled: false,
        interval: Duration::from_secs(1),
        next_request: Instant::now(),
        last_response: Instant::now(),
        seen: BTreeMap::new(),
        known: vec![],
        discovery: Some(Error::PermissionDenied),
        processes: vec![],
        process_status: None,
    };
    gpu.sample(attributes(), NOW, super::ProcessContext::default);
    gpu.invalidate();
    assert!(gpu.discovery.is_none());
    sender
        .send((
            0,
            Instant::now(),
            super::Frame {
                devices: Ok(recount_nvidia_dcgm::Snapshot {
                    devices: vec![device()],
                    discovery: Ok(()),
                }),
                processes: super::process::Frame::default(),
                completed_ns: Some(NOW),
            },
        ))
        .unwrap();
    assert!(
        gpu.sample(attributes(), NOW, super::ProcessContext::default)
            .is_empty()
    );
    assert!(gpu.known.is_empty());
}

#[test]
fn distributions_use_only_fresh_physical_board_values_once_per_signal() {
    let mut first = device();
    first.readings.push(Reading {
        field: Field::Utilization,
        time_ns: NOW,
        value: Ok(Value::Integer(50)),
    });
    first.readings.push(Reading {
        field: Field::Power,
        time_ns: NOW,
        value: Ok(Value::Double(75.0)),
    });
    let mut second = first.clone();
    second.uuid = "GPU-01234567-89ab-cdef-0123-456789abcdef".into();
    second.readings.retain(|r| r.field == Field::MemoryUsed);
    second.readings[0].value = Ok(Value::Integer(0));
    let mut mig = first.clone();
    mig.uuid = "MIG-01234567-89ab-cdef-0123-456789abcdef".into();
    mig.parent_uuid = Some(first.uuid.clone());
    let devices = [first.clone(), first, second, mig];
    let mut seen = BTreeMap::new();
    let frame = |seen: &mut _| {
        export::resources(
            &devices,
            seen,
            attributes(),
            NOW + 10,
            Duration::from_secs(1),
            Some(NOW + 5),
        )
    };
    let resources = frame(&mut seen);
    let node = resources.last().unwrap();
    let identity = adapter::resource_identity(&node.resource.as_ref().unwrap().attributes).unwrap();
    assert_eq!(identity.scope, adapter::Scope::Node);
    assert!(identity.gpu.is_none());
    let mut histograms = BTreeMap::new();
    for metric in &node.scope_metrics[0].metrics {
        catalogue::validate_adapter_metric(metric, catalogue::Adapter::Linux).unwrap();
        if let Some(Data::Histogram(h)) = &metric.data {
            let p = &h.data_points[0];
            assert_eq!(p.time_unix_nano, NOW + 5);
            assert_eq!(p.start_time_unix_nano, 0);
            assert_eq!(p.count, p.bucket_counts.iter().sum::<u64>());
            histograms.insert(metric.name.as_str(), (p.count, p.sum, p.min, p.max));
        }
    }
    assert_eq!(histograms.len(), 3);
    assert_eq!(
        histograms[catalogue::NODE_GPU_UTILIZATION_DISTRIBUTION.name],
        (1, Some(0.5), Some(0.5), Some(0.5))
    );
    assert_eq!(
        histograms[catalogue::NODE_GPU_MEMORY_DISTRIBUTION.name],
        (2, Some(1_073_741_824.), Some(0.), Some(1_073_741_824.))
    );
    assert_eq!(
        histograms[catalogue::NODE_GPU_POWER_DISTRIBUTION.name],
        (1, Some(75.), Some(75.), Some(75.))
    );
    assert!(
        frame(&mut seen).last().unwrap().scope_metrics[0]
            .metrics
            .iter()
            .all(|m| m.name == catalogue::GPU_COVERAGE.name)
    );
}
