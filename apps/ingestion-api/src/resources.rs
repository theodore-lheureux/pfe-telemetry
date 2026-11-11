use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    identity::local_resource_id,
    wire::{
        BoundScope, LocalResource, ResourceAccess, ResourceBinding, ResourceContext, ResourceKind,
        ResourceRef, RootScope, resource_access::Scope,
    },
};
use recount_telemetry_validation::{
    catalogue::{self, Adapter},
    linux_adapter::{self, resource_identity},
    metadata::{self, Profile},
    validate::Limits,
};
use tonic::Status;

use crate::{auth::Source, status};

pub fn resolve(
    request: &ExportMetricsServiceRequest,
    source: &Source,
    profile: Profile,
    limits: Limits,
) -> std::result::Result<Vec<ResourceBinding>, Status> {
    if request.resource_metrics.len() > limits.expanded_items {
        return Err(Status::resource_exhausted("Resource context limit"));
    }
    request
        .resource_metrics
        .iter()
        .enumerate()
        .map(|(index, rm)| {
            let attrs = rm
                .resource
                .as_ref()
                .map(|r| r.attributes.as_slice())
                .unwrap_or_default();
            let claim = metadata::resource_claim(attrs).map_err(status)?;
            let (resource, scope, host_id) = if profile == Profile::Linux {
                let identity = resource_identity(attrs).map_err(status)?;
                let host = identity.host;
                for metric in rm.scope_metrics.iter().flat_map(|s| &s.metrics) {
                    catalogue::validate_adapter_metric(metric, Adapter::Linux).map_err(status)?;
                }
                if claim.is_some() {
                    return Err(Status::invalid_argument(
                        "Linux adapter resource claims must use native identity",
                    ));
                }
                if let Some(process) = identity.process {
                    let incarnation = process.incarnation();
                    let id = local_resource_id(
                        &source.security.project_id,
                        host,
                        ResourceKind::Process,
                        &incarnation,
                    )
                    .map_err(|_| Status::invalid_argument("Invalid local resource incarnation"))?;
                    (
                        ResourceRef {
                            id,
                            kind: ResourceKind::Process as i32,
                        },
                        Scope::Local(LocalResource {
                            root_id: host.into(),
                            adapter: linux_adapter::ADAPTER.into(),
                            local_incarnation: incarnation,
                        }),
                        Some(host.to_owned()),
                    )
                } else {
                    let root_kind = if host == source.root.id {
                        source.root.kind
                    } else {
                        ResourceKind::Host as i32
                    };
                    (
                        ResourceRef {
                            id: host.into(),
                            kind: root_kind,
                        },
                        Scope::Root(RootScope {}),
                        Some(host.to_owned()),
                    )
                }
            } else {
                match claim {
                    None => (
                        source.root.clone(),
                        Scope::Root(RootScope {}),
                        (source.root.kind == ResourceKind::Host as i32)
                            .then(|| source.root.id.clone()),
                    ),
                    Some(reference) if reference == source.root => (
                        reference,
                        Scope::Root(RootScope {}),
                        (source.root.kind == ResourceKind::Host as i32)
                            .then(|| source.root.id.clone()),
                    ),
                    Some(reference) => (reference, Scope::Bound(BoundScope {}), None),
                }
            };
            Ok(ResourceBinding {
                original_resource: index
                    .try_into()
                    .map_err(|_| Status::resource_exhausted("Resource index limit"))?,
                context: Some(ResourceContext {
                    resource: Some(resource),
                    host_id,
                    device_id: None,
                    relationships: vec![],
                    access: Some(ResourceAccess { scope: Some(scope) }),
                }),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_schema::{
        common::{AnyValue, KeyValue, any_value::Value},
        metrics::{
            Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric,
            number_data_point,
        },
        resource::Resource,
        wire::SecurityScope,
    };

    fn string(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.into(),
            value: Some(AnyValue {
                value: Some(Value::StringValue(value.into())),
            }),
            ..Default::default()
        }
    }

    fn source() -> Source {
        Source {
            node_id: uuid::Uuid::nil(),
            security: SecurityScope {
                project_id: "project".into(),
                source_id: "source".into(),
            },
            root: ResourceRef {
                id: "host".into(),
                kind: ResourceKind::Host as i32,
            },
            maximum_age_ns: 1,
            skew_ns: 0,
            adapter: "linux".into(),
            local_kinds: [ResourceKind::Process].into(),
        }
    }

    fn linux_node() -> ResourceMetrics {
        ResourceMetrics {
            resource: Some(Resource {
                attributes: vec![
                    string("host.id", "host"),
                    string(
                        "recount.host.boot_id",
                        "01234567-89ab-cdef-0123-456789abcdef",
                    ),
                    string("recount.collection.epoch_id", "epoch"),
                    string("recount.collection.scope", "node"),
                ],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn linux_bindings_follow_resource_positions_not_resource_or_attribute_order() {
        let node = linux_node();
        let mut process = node.clone();
        let attrs = &mut process.resource.as_mut().unwrap().attributes;
        *attrs
            .iter_mut()
            .find(|a| a.key == "recount.collection.scope")
            .unwrap() = string("recount.collection.scope", "process");
        attrs.extend([
            string("recount.process.namespace_id", "namespace"),
            string("recount.process.start_time_ticks", "100"),
            // A descriptive incarnation claim cannot override native identity.
            string("recount.process.incarnation_id", "forged"),
            KeyValue {
                key: "process.pid".into(),
                value: Some(AnyValue {
                    value: Some(Value::IntValue(42)),
                }),
                ..Default::default()
            },
        ]);
        let source = source();
        let mut request = ExportMetricsServiceRequest {
            resource_metrics: vec![node, process],
        };
        let original = resolve(&request, &source, Profile::Linux, Limits::default()).unwrap();
        assert!(matches!(
            original[0]
                .context
                .as_ref()
                .unwrap()
                .access
                .as_ref()
                .unwrap()
                .scope,
            Some(Scope::Root(_))
        ));
        let Some(Scope::Local(local)) = &original[1]
            .context
            .as_ref()
            .unwrap()
            .access
            .as_ref()
            .unwrap()
            .scope
        else {
            panic!("Process must resolve locally");
        };
        assert_eq!(local.root_id, "host");
        assert_eq!(local.adapter, "linux");
        assert_ne!(local.local_incarnation, "forged");
        request.resource_metrics.reverse();
        for resource in &mut request.resource_metrics {
            resource.resource.as_mut().unwrap().attributes.reverse();
        }
        let reordered = resolve(&request, &source, Profile::Linux, Limits::default()).unwrap();
        assert_eq!(reordered[0].original_resource, 0);
        assert_eq!(reordered[1].original_resource, 1);
        assert_eq!(reordered[0].context, original[1].context);
        assert_eq!(reordered[1].context, original[0].context);
    }

    #[test]
    fn linux_boundary_rejects_dcgm_without_restricting_standard_otlp() {
        let mut resource = linux_node();
        resource.scope_metrics.push(ScopeMetrics {
            metrics: vec![Metric {
                name: "DCGM_FI_PROF_SM_ACTIVE".into(),
                unit: "1".into(),
                data: Some(metric::Data::Gauge(Gauge {
                    data_points: vec![NumberDataPoint {
                        time_unix_nano: 200,
                        value: Some(number_data_point::Value::AsDouble(0.5)),
                        ..Default::default()
                    }],
                })),
                ..Default::default()
            }],
            ..Default::default()
        });
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![resource],
        };
        let source = source();
        let status = resolve(&request, &source, Profile::Linux, Limits::default()).unwrap_err();
        assert_eq!(status.code(), tonic::Code::FailedPrecondition);
        resolve(&request, &source, Profile::Standard, Limits::default()).unwrap();
    }

    #[test]
    fn standard_resources_need_no_linux_identity_or_metric_allowlist() {
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![
                        string("recount.collection.scope", "application"),
                        string("recount.host.boot_id", "not-linux"),
                    ],
                    ..Default::default()
                }),
                scope_metrics: vec![ScopeMetrics {
                    metrics: vec![Metric {
                        name: "application.custom".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        let source = source();
        let bindings = resolve(&request, &source, Profile::Standard, Limits::default()).unwrap();
        assert_eq!(
            bindings[0].context.as_ref().unwrap().resource.as_ref(),
            Some(&source.root)
        );
        assert!(resolve(&request, &source, Profile::Linux, Limits::default()).is_err());
    }
}
