use super::{source, string};
use crate::resources::resolve;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    metrics::{
        Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric, number_data_point,
    },
    resource::Resource,
    wire::{RawRecord, ResourceKind},
};
use recount_telemetry_validation::{
    metadata::Profile,
    policy::{self, RootGrant},
    validate::Limits,
};
use std::collections::BTreeSet;

fn request(uuid: &str) -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(Resource {
                attributes: vec![
                    string("host.id", "host"),
                    string(
                        "recount.host.boot_id",
                        "01234567-89ab-cdef-0123-456789abcdef",
                    ),
                    string("recount.collection.epoch_id", "epoch"),
                    string("recount.collection.scope", "gpu"),
                    string("gpu.uuid", uuid),
                ],
                ..Default::default()
            }),
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![Metric {
                    name: "recount.gpu.pipe.activity".into(),
                    unit: "1".into(),
                    data: Some(metric::Data::Gauge(Gauge {
                        data_points: vec![NumberDataPoint {
                            value: Some(number_data_point::Value::AsDouble(0.25)),
                            time_unix_nano: 100,
                            ..Default::default()
                        }],
                    })),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}

#[test]
fn gpu_native_identity_is_local_stable_and_independently_granted() {
    let source = source();
    let request = request("GPU-5fd15f35-e148-2992-4ecb-9825e534f253");
    let bindings = resolve(&request, &source, Profile::Linux, Limits::default()).unwrap();
    let context = bindings[0].context.as_ref().unwrap();
    assert_eq!(
        context.resource.as_ref().unwrap().kind,
        ResourceKind::Gpu as i32
    );
    assert_eq!(context.host_id.as_deref(), Some("host"));
    assert_ne!(context.resource.as_ref().unwrap().id, "host");
    let raw = RawRecord {
        security: Some(source.security.clone()),
        bindings,
        ..Default::default()
    };
    for (kinds, allowed) in [
        (BTreeSet::from([ResourceKind::Gpu]), true),
        (BTreeSet::new(), false),
    ] {
        let grant = RootGrant {
            security: source.security.clone(),
            root: source.root.clone(),
            adapter: "linux".into(),
            allowed_local_kinds: kinds,
        };
        assert_eq!(
            policy::authorize(&source.security, &raw, &[grant], &[], 1).is_ok(),
            allowed
        );
    }
    let mut reordered = request;
    reordered.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .reverse();
    assert_eq!(
        resolve(&reordered, &source, Profile::Linux, Limits::default()).unwrap(),
        raw.bindings
    );
}

#[test]
fn ordinals_invalid_uuids_missing_mig_parent_and_unbounded_ratios_are_rejected() {
    let source = source();
    for invalid in [
        "0",
        "GPU-7",
        "MIG-GPU-5fd15f35-e148-2992-4ecb-9825e534f253/1/0",
        "MIG-01234567-89ab-cdef-0123-456789abcdef",
    ] {
        assert!(
            resolve(
                &request(invalid),
                &source,
                Profile::Linux,
                Limits::default()
            )
            .is_err()
        );
    }
    let mut request = request("GPU-5fd15f35-e148-2992-4ecb-9825e534f253");
    let Some(metric::Data::Gauge(gauge)) =
        &mut request.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!("Gauge expected");
    };
    gauge.data_points[0].value = Some(number_data_point::Value::AsDouble(25.0));
    assert!(resolve(&request, &source, Profile::Linux, Limits::default()).is_err());
}
