// Synthetic NVML transcripts exercise lifetime checks; not hardware recordings.
use super::{
    acquire::{Batch, Memory},
    attach,
    window::Window,
};
use crate::{
    diagnostics::ReadStatus,
    metrics::{integer, resource, string},
};
use nvml_wrapper::struct_wrappers::device::ProcessUtilizationSample;
use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value;
use recount_telemetry_validation::{catalogue as c, linux_adapter as adapter};
use std::{collections::BTreeMap, time::Duration};

const NOW: u64 = 1_700_000_000_000_000_000;
const UUID: &str = "GPU-5fd15f35-e148-2992-4ecb-9825e534f253";

fn batch(time_ns: u64, pids: &[i32]) -> Batch {
    Batch {
        uuid: UUID.into(),
        memory: pids
            .iter()
            .map(|pid| {
                (
                    *pid,
                    Memory {
                        bytes: Ok(4096),
                        time_ns,
                    },
                )
            })
            .collect(),
        utilization: Ok(pids
            .iter()
            .map(|pid| ProcessUtilizationSample {
                pid: *pid as u32,
                timestamp: time_ns / 1000,
                sm_util: 50,
                mem_util: 25,
                enc_util: 0,
                dec_util: 0,
            })
            .collect()),
        finished_ns: time_ns,
        discovery: ReadStatus::Read,
    }
}

#[test]
fn bootstrap_is_not_attributed_and_equal_timestamps_do_not_drop_other_pids() {
    let ids = BTreeMap::from([(42, 10), (43, 20)]);
    let mut window = Window::default();
    window.begin(&ids, NOW);
    let initial = window.resolve(batch(NOW, &[42, 43]), &ids, &ids, Duration::from_secs(1));
    assert!(
        initial
            .iter()
            .filter(|r| r.metric.name == c::PROCESS_GPU_UTILIZATION.name)
            .all(|r| r.value == Err(ReadStatus::Unavailable))
    );
    window.begin(&ids, NOW + 3_000_000_000);
    let readings = window.resolve(
        batch(NOW + 3_000_000_000, &[42, 43]),
        &ids,
        &ids,
        Duration::from_secs(1),
    );
    let sm: Vec<_> = readings
        .iter()
        .filter(|r| r.metric.name == c::PROCESS_GPU_UTILIZATION.name)
        .collect();
    assert_eq!(sm.len(), 2);
    assert!(sm.iter().all(|r| r.value == Ok(Value::AsDouble(0.5))));
    assert_eq!(window.cursor(UUID), (NOW + 3_000_000_000) / 1000);
    let repeated = window.resolve(
        batch(NOW + 3_000_000_000, &[42, 43]),
        &ids,
        &ids,
        Duration::from_secs(1),
    );
    assert!(
        repeated
            .iter()
            .filter(|r| r.metric.name == c::PROCESS_GPU_UTILIZATION.name)
            .all(|r| r.value.is_err())
    );
}

#[test]
fn pid_reuse_races_unknown_identities_and_invalid_clocks_never_receive_old_usage() {
    let old = BTreeMap::from([(42, 10)]);
    let current = BTreeMap::from([(42, 11)]);
    let changed = BTreeMap::from([(42, 12)]);
    let mut window = Window::default();
    window.begin(&old, NOW);
    window.resolve(batch(NOW, &[42]), &old, &old, Duration::from_secs(1));
    window.begin(&current, NOW + 3_000_000_000);
    let mut reused = batch(NOW + 3_000_000_000, &[42]);
    reused.utilization.as_mut().unwrap()[0].timestamp = (NOW + 2_000_000_000) / 1000;
    let readings = window.resolve(reused, &current, &current, Duration::from_secs(1));
    assert!(
        readings
            .iter()
            .filter(|r| r.metric.name == c::PROCESS_GPU_UTILIZATION.name)
            .all(|r| r.value.is_err())
    );
    assert!(
        window
            .resolve(
                batch(NOW + 4_000_000_000, &[42]),
                &current,
                &changed,
                Duration::from_secs(1)
            )
            .is_empty()
    );
    assert!(
        window
            .resolve(
                batch(NOW + 4_000_000_000, &[99]),
                &current,
                &current,
                Duration::from_secs(1)
            )
            .is_empty()
    );
    let cursor = window.cursor(UUID);
    let mut invalid = batch(NOW + 4_000_000_000, &[42]);
    invalid.utilization.as_mut().unwrap()[0].timestamp = u64::MAX;
    let readings = window.resolve(invalid, &current, &current, Duration::from_secs(1));
    assert_eq!(window.cursor(UUID), cursor);
    assert!(
        readings
            .iter()
            .filter(|r| r.metric.name == c::PROCESS_GPU_UTILIZATION.name)
            .all(|r| r.value == Err(ReadStatus::OutOfRange))
    );
}

#[test]
fn process_gpu_resources_reuse_cpu_identity_keep_device_on_points_and_validate_as_otlp() {
    let attrs = vec![
        string(adapter::HOST_ID, "host"),
        string(adapter::BOOT_ID, "01234567-89ab-cdef-0123-456789abcdef"),
        string(adapter::EPOCH_ID, "epoch"),
        string(adapter::SCOPE, "process"),
        string(adapter::NAMESPACE_ID, "host"),
        string(adapter::START_TICKS, "10"),
        integer(adapter::PID, 42),
        integer(adapter::REAL_USER_ID, 1001),
        integer(adapter::SLURM_JOB_ID, 12345),
        integer(adapter::INTERVAL_NS, 100_000_000),
        string("recount.collection.source", "rust-procfs"),
    ];
    let cpu = resource(attrs.clone(), vec![]);
    let original = adapter::resource_identity(&attrs)
        .unwrap()
        .process
        .unwrap()
        .incarnation();
    let ids = BTreeMap::from([(42, 10)]);
    let mut window = Window::default();
    window.begin(&ids, NOW);
    let mut captured = batch(NOW, &[42]);
    captured.memory.get_mut(&42).unwrap().bytes = Err(ReadStatus::PermissionDenied);
    let readings = window.resolve(captured, &ids, &ids, Duration::from_secs(1));
    let resources = attach::attach(
        std::slice::from_ref(&cpu),
        readings,
        NOW,
        Duration::from_millis(100),
    );
    assert_eq!(resources.len(), 1);
    let gpu_attrs = &resources[0].resource.as_ref().unwrap().attributes;
    for key in [adapter::REAL_USER_ID, adapter::SLURM_JOB_ID] {
        assert_eq!(
            gpu_attrs.iter().find(|attr| attr.key == key),
            attrs.iter().find(|attr| attr.key == key)
        );
    }
    assert_eq!(
        adapter::resource_identity(gpu_attrs)
            .unwrap()
            .process
            .unwrap()
            .incarnation(),
        original
    );
    assert!(
        !gpu_attrs
            .iter()
            .any(|a| a.key == adapter::GPU_UUID || a.key.contains("execution"))
    );
    assert_eq!(cpu.resource.as_ref().unwrap().attributes, attrs);
    let request = opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest {
        resource_metrics: resources,
    };
    recount_telemetry_validation::validate::request(&request, Default::default()).unwrap();
    let metrics = &request.resource_metrics[0].scope_metrics[0].metrics;
    assert!(
        metrics
            .iter()
            .all(|metric| metric.name == c::READ_STATUS.name)
    );
}
