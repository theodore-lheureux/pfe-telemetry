use recount_telemetry_schema::{
    common::{AnyValue, KeyValue, any_value::Value as Attribute},
    identity::local_resource_id,
    wire::{
        BoundScope, LocalResource, RawRecord, ResourceAccess, ResourceBinding, ResourceContext,
        ResourceKind, ResourceRef, RootScope, SecurityScope, resource_access::Scope,
    },
};
use recount_telemetry_validation::{
    linux_adapter,
    policy::{self, BoundGrant, RootGrant},
};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/credential-authority.json"
    ))
    .unwrap()
}

fn security() -> SecurityScope {
    SecurityScope {
        project_id: "project".into(),
        source_id: "source".into(),
    }
}

fn context(id: &str, kind: i32, scope: Scope) -> ResourceContext {
    ResourceContext {
        resource: Some(ResourceRef {
            id: id.into(),
            kind,
        }),
        access: Some(ResourceAccess { scope: Some(scope) }),
        ..Default::default()
    }
}

fn raw(context: ResourceContext) -> RawRecord {
    RawRecord {
        security: Some(security()),
        bindings: vec![ResourceBinding {
            context: Some(context),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn root(kind: i32) -> RootGrant {
    RootGrant {
        security: security(),
        root: ResourceRef {
            id: "root".into(),
            kind,
        },
        adapter: "linux".into(),
        allowed_local_kinds: Default::default(),
    }
}

fn local(kind: ResourceKind) -> ResourceContext {
    let incarnation = "incarnation";
    let id = local_resource_id(&security().project_id, "root", kind, incarnation).unwrap();
    context(
        &id,
        kind as i32,
        Scope::Local(LocalResource {
            root_id: "root".into(),
            adapter: "linux".into(),
            local_incarnation: incarnation.into(),
        }),
    )
}

#[test]
fn linux_resource_identifiers_consume_the_shared_boundary_vectors() {
    let string = |key: &str, value: &str| KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(Attribute::StringValue(value.into())),
        }),
        ..Default::default()
    };
    for vector in vectors()["identifiers"].as_array().unwrap() {
        for key in [linux_adapter::HOST_ID, linux_adapter::NAMESPACE_ID] {
            let mut attributes = vec![
                string(linux_adapter::HOST_ID, "root"),
                string(
                    linux_adapter::BOOT_ID,
                    "01234567-89ab-cdef-0123-456789abcdef",
                ),
                string(linux_adapter::SCOPE, "process"),
                string(linux_adapter::EPOCH_ID, "epoch"),
                string(linux_adapter::NAMESPACE_ID, "namespace"),
                string(linux_adapter::START_TICKS, "100"),
                KeyValue {
                    key: linux_adapter::PID.into(),
                    value: Some(AnyValue {
                        value: Some(Attribute::IntValue(42)),
                    }),
                    ..Default::default()
                },
            ];
            *attributes
                .iter_mut()
                .find(|attribute| attribute.key == key)
                .unwrap() = string(key, vector["value"].as_str().unwrap());
            assert_eq!(
                linux_adapter::resource_identity(&attributes).is_ok(),
                vector["valid"].as_bool().unwrap(),
                "{key}, {}",
                vector["name"],
            );
        }
    }
}

#[test]
fn enrolled_resource_ids_keep_the_local_namespace_reserved() {
    // Malformed credential identifiers are rejected by authentication/enrollment,
    // not reinterpreted as enrollment-policy inputs at the trusted-grant boundary.
    for vector in vectors()["identifiers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["valid"].as_bool().unwrap())
    {
        let id = vector["value"].as_str().unwrap();
        let expected = vector["enrolledResource"].as_bool().unwrap();
        let mut grant = root(ResourceKind::Host as i32);
        grant.root.id = id.into();
        let root_record = raw(context(
            id,
            ResourceKind::Host as i32,
            Scope::Root(RootScope {}),
        ));
        assert_eq!(
            policy::authorize(&security(), &root_record, &[grant], &[], 1).is_ok(),
            expected,
            "{}",
            vector["name"]
        );
        let bound_record = raw(context(
            id,
            ResourceKind::Host as i32,
            Scope::Bound(BoundScope {}),
        ));
        let grant = BoundGrant {
            security: security(),
            resource: bound_record.bindings[0]
                .context
                .as_ref()
                .unwrap()
                .resource
                .clone()
                .unwrap(),
        };
        assert_eq!(
            policy::authorize(&security(), &bound_record, &[], &[grant], 1).is_ok(),
            expected,
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn resource_kind_vectors_apply_at_root_bound_and_local_authorization() {
    for vector in vectors()["kinds"].as_array().unwrap() {
        let kind = i32::try_from(vector["value"].as_i64().unwrap()).unwrap();
        let expected = vector["valid"].as_bool().unwrap();
        let root_record = raw(context("root", kind, Scope::Root(RootScope {})));
        assert_eq!(
            policy::authorize(&security(), &root_record, &[root(kind)], &[], 1).is_ok(),
            expected,
            "{vector}"
        );
        let bound_record = raw(context("bound", kind, Scope::Bound(BoundScope {})));
        let grant = BoundGrant {
            security: security(),
            resource: ResourceRef {
                id: "bound".into(),
                kind,
            },
        };
        assert_eq!(
            policy::authorize(&security(), &bound_record, &[], &[grant], 1).is_ok(),
            expected,
            "{vector}"
        );

        if let Ok(kind) = ResourceKind::try_from(kind) {
            let context = local(kind);
            let expected = vector["local"].as_bool().unwrap();
            assert_eq!(
                policy::validate_context(&security().project_id, &context).is_ok(),
                expected,
                "{vector}"
            );
            if expected {
                let record = raw(context);
                let mut grant = root(ResourceKind::Host as i32);
                grant.allowed_local_kinds.insert(kind);
                policy::authorize(&security(), &record, std::slice::from_ref(&grant), &[], 1)
                    .unwrap();
                grant.allowed_local_kinds.clear();
                assert!(
                    policy::authorize(&security(), &record, &[grant], &[], 1).is_err(),
                    "{vector}"
                );
            }
        }
    }
}

#[test]
fn valid_enrolled_policies_bound_linux_local_grants() {
    let vectors = vectors();
    // Web validation and SQL reject invalid enrollment policies. Authorization
    // consumes trusted grants and enforces their exact adapter/kind scope instead.
    for vector in vectors["rootPolicies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["valid"].as_bool().unwrap())
    {
        let mut grant = root(ResourceKind::Host as i32);
        grant.adapter = vector["adapter"].as_str().unwrap().into();
        grant.allowed_local_kinds = vector["allowedLocalKinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|kind| {
                ResourceKind::try_from(i32::try_from(kind.as_i64().unwrap()).unwrap()).unwrap()
            })
            .collect();
        let root_record = raw(context(
            "root",
            ResourceKind::Host as i32,
            Scope::Root(RootScope {}),
        ));
        policy::authorize(
            &security(),
            &root_record,
            std::slice::from_ref(&grant),
            &[],
            1,
        )
        .unwrap();
        for kind_vector in vectors["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["local"].as_bool().unwrap())
        {
            let kind = ResourceKind::try_from(
                i32::try_from(kind_vector["value"].as_i64().unwrap()).unwrap(),
            )
            .unwrap();
            let mut record = raw(local(kind));
            let expected = grant.allowed_local_kinds.contains(&kind);
            assert_eq!(
                policy::authorize(&security(), &record, std::slice::from_ref(&grant), &[], 1)
                    .is_ok(),
                expected,
                "{vector}, {kind:?}"
            );
            if expected {
                let Some(Scope::Local(local)) = record.bindings[0]
                    .context
                    .as_mut()
                    .unwrap()
                    .access
                    .as_mut()
                    .unwrap()
                    .scope
                    .as_mut()
                else {
                    unreachable!()
                };
                local.adapter = "standard".into();
                assert!(
                    policy::authorize(&security(), &record, std::slice::from_ref(&grant), &[], 1)
                        .is_err(),
                    "{vector}, {kind:?}"
                );
            }
        }
    }
}
