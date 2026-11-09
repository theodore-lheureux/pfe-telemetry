use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::{KeyValue, any_value::Value},
    identity::local_resource_id,
    point::string_attribute,
    wire::{
        BoundScope, LocalResource, ResourceAccess, ResourceBinding, ResourceContext, ResourceKind,
        ResourceRef, RootScope, resource_access::Scope,
    },
};
use recount_telemetry_validation::{
    metadata::{self, Profile},
    validate::Limits,
};
use tonic::Status;

use crate::{auth::Source, status};

fn required<'a>(attrs: &'a [KeyValue], key: &str) -> std::result::Result<&'a str, Status> {
    string_attribute(attrs, key)
        .filter(|v| crate::auth::identifier(v))
        .ok_or_else(|| Status::invalid_argument("Missing or invalid Linux resource identity"))
}

fn integer(attrs: &[KeyValue], key: &str) -> std::result::Result<i64, Status> {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match v.value {
            Some(Value::IntValue(v)) if v > 0 => Some(v),
            _ => None,
        })
        .ok_or_else(|| Status::invalid_argument("Missing or invalid Linux process identity"))
}

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
                let host = required(attrs, "host.id")?;
                let boot = required(attrs, "recount.host.boot_id")?;
                if uuid::Uuid::parse_str(boot).is_err() {
                    return Err(Status::invalid_argument("Invalid Linux boot identity"));
                }
                let scope = required(attrs, "recount.collection.scope")?;
                if !matches!(scope, "node" | "process" | "collector") {
                    return Err(Status::failed_precondition(
                        "Unsupported Linux collection scope",
                    ));
                }
                required(attrs, "recount.collection.epoch_id")?;
                let process = scope == "process";
                for metric in rm.scope_metrics.iter().flat_map(|s| &s.metrics) {
                    recount_telemetry_validation::catalogue::validate_collector_metric(metric)
                        .map_err(status)?;
                }
                if claim.is_some() {
                    return Err(Status::invalid_argument(
                        "Linux adapter resource claims must use native identity",
                    ));
                }
                if process {
                    let pid = integer(attrs, "process.pid")?;
                    let ticks = required(attrs, "recount.process.start_time_ticks")?
                        .parse::<u64>()
                        .map_err(|_| Status::invalid_argument("Invalid process start ticks"))?;
                    let namespace = required(attrs, "recount.process.namespace_id")?;
                    let mut hash =
                        recount_telemetry_schema::identity::TypedHash::new("recount.linux-process");
                    hash.field(boot.as_bytes());
                    hash.field(namespace.as_bytes());
                    hash.u64(pid as u64);
                    hash.u64(ticks);
                    let incarnation = recount_telemetry_schema::identity::hex(&hash.finish());
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
                            adapter: "linux".into(),
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
