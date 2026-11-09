use crate::{Category, Issue};
use recount_telemetry_schema::{
    identity::{LOCAL_RESOURCE_PREFIX, local_resource_id},
    wire::{
        RawRecord, ResourceContext, ResourceKind, ResourceRef, SecurityScope,
        resource_access::Scope,
    },
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct RootGrant {
    pub security: SecurityScope,
    pub root: ResourceRef,
    pub adapter: String,
    pub allowed_local_kinds: BTreeSet<ResourceKind>,
}
#[derive(Clone, Debug)]
pub struct BoundGrant {
    pub security: SecurityScope,
    pub resource: ResourceRef,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RequestedAuthorities {
    pub roots: BTreeSet<String>,
    pub independent: BTreeSet<String>,
}

fn forbidden(reason: &'static str) -> Issue {
    Issue::new(Category::Forbidden, "bindings", reason)
}
fn identifier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128
}
fn local_kind(kind: ResourceKind) -> bool {
    matches!(
        kind,
        ResourceKind::Cpu
            | ResourceKind::Gpu
            | ResourceKind::Process
            | ResourceKind::Container
            | ResourceKind::Sensor
    )
}

// Shape/identity check only. Accepted replay must not refresh credential grants.
pub fn validate_context(project: &str, context: &ResourceContext) -> Result<(), Issue> {
    let reference = context
        .resource
        .as_ref()
        .ok_or_else(|| forbidden("missing resource reference"))?;
    let kind =
        ResourceKind::try_from(reference.kind).map_err(|_| forbidden("unknown resource kind"))?;
    if !identifier(&reference.id) {
        return Err(forbidden("invalid resource identity"));
    }
    match context
        .access
        .as_ref()
        .and_then(|a| a.scope.as_ref())
        .ok_or_else(|| forbidden("missing resolved resource scope"))?
    {
        Scope::Root(_) | Scope::Bound(_) => {
            if reference.id.starts_with(LOCAL_RESOURCE_PREFIX) {
                return Err(forbidden(
                    "local identity cannot claim an enrolled root or independent binding",
                ));
            }
        }
        Scope::Local(local) => {
            if !local_kind(kind) || !identifier(&local.adapter) {
                return Err(forbidden("unsupported local resource kind or adapter"));
            }
            let expected =
                local_resource_id(project, &local.root_id, kind, &local.local_incarnation)
                    .map_err(forbidden)?;
            if reference.id != expected {
                return Err(forbidden(
                    "local resource identity disagrees with its root scope",
                ));
            }
        }
    }
    Ok(())
}

// Query only these distinct authority keys after live credential authentication;
// local PID/core/device count does not multiply authority database lookups.
pub fn requested_authorities(
    raw: &RawRecord,
    max_distinct: usize,
) -> Result<RequestedAuthorities, Issue> {
    if max_distinct == 0 {
        return Err(Issue::new(
            Category::Invalid,
            "limits",
            "positive authority bound required",
        ));
    }
    let security = raw
        .security
        .as_ref()
        .ok_or_else(|| forbidden("missing trusted scope"))?;
    let mut requested = RequestedAuthorities::default();
    for binding in &raw.bindings {
        let context = binding
            .context
            .as_ref()
            .ok_or_else(|| forbidden("missing context"))?;
        validate_context(&security.project_id, context)?;
        let reference = context.resource.as_ref().unwrap();
        match context.access.as_ref().unwrap().scope.as_ref().unwrap() {
            Scope::Root(_) => {
                requested.roots.insert(reference.id.clone());
            }
            Scope::Local(local) => {
                requested.roots.insert(local.root_id.clone());
            }
            Scope::Bound(_) => {
                requested.independent.insert(reference.id.clone());
            }
        }
        if requested.roots.len() + requested.independent.len() > max_distinct {
            return Err(Issue::new(
                Category::Limit,
                "bindings",
                "distinct root/binding limit",
            ));
        }
    }
    Ok(requested)
}

pub fn authorize(
    scope: &SecurityScope,
    raw: &RawRecord,
    roots: &[RootGrant],
    independent: &[BoundGrant],
    max_distinct: usize,
) -> Result<(), Issue> {
    if raw.security.as_ref() != Some(scope)
        || !identifier(&scope.project_id)
        || !identifier(&scope.source_id)
    {
        return Err(forbidden("trusted scope mismatch"));
    }
    let requested = requested_authorities(raw, max_distinct)?;
    if roots.len() + independent.len() > max_distinct {
        return Err(forbidden("grant result exceeds request authority bound"));
    }
    let mut root_map = BTreeMap::new();
    let mut bound_map = BTreeMap::new();
    for grant in roots {
        if grant.security != *scope
            || !identifier(&grant.root.id)
            || grant.root.id.starts_with(LOCAL_RESOURCE_PREFIX)
            || ResourceKind::try_from(grant.root.kind).is_err()
            || !identifier(&grant.adapter)
            || grant
                .allowed_local_kinds
                .iter()
                .any(|kind| !local_kind(*kind))
            || root_map.insert(grant.root.id.clone(), grant).is_some()
        {
            return Err(forbidden("invalid enrolled root grant"));
        }
    }
    for grant in independent {
        if grant.security != *scope
            || !identifier(&grant.resource.id)
            || grant.resource.id.starts_with(LOCAL_RESOURCE_PREFIX)
            || ResourceKind::try_from(grant.resource.kind).is_err()
            || bound_map.insert(grant.resource.id.clone(), grant).is_some()
        {
            return Err(forbidden("invalid independent resource grant"));
        }
    }
    if root_map.keys().cloned().collect::<BTreeSet<_>>() != requested.roots
        || bound_map.keys().cloned().collect::<BTreeSet<_>>() != requested.independent
    {
        return Err(forbidden(
            "explicit grants must cover exactly the requested roots and bindings",
        ));
    }
    for binding in &raw.bindings {
        let context = binding.context.as_ref().unwrap();
        let reference = context.resource.as_ref().unwrap();
        match context.access.as_ref().unwrap().scope.as_ref().unwrap() {
            Scope::Root(_) => {
                if root_map[&reference.id].root != *reference {
                    return Err(forbidden("enrolled root reference mismatch"));
                }
            }
            Scope::Bound(_) => {
                if bound_map[&reference.id].resource != *reference {
                    return Err(forbidden("independent resource reference mismatch"));
                }
            }
            Scope::Local(local) => {
                let grant = root_map[&local.root_id];
                let kind = ResourceKind::try_from(reference.kind).unwrap();
                if local.adapter != grant.adapter || !grant.allowed_local_kinds.contains(&kind) {
                    return Err(forbidden(
                        "adapter or local kind is outside enrolled root scope",
                    ));
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct FlushLimits {
    pub max_rows: usize,
    pub max_bytes: usize,
    pub max_delay_ns: u64,
}
impl FlushLimits {
    pub fn validate(self) -> Result<Self, Issue> {
        if self.max_rows == 0 || self.max_bytes == 0 || self.max_delay_ns == 0 {
            Err(Issue::new(
                Category::Invalid,
                "flush",
                "positive bounded flush limits required",
            ))
        } else {
            Ok(self)
        }
    }
    // Adapter uses a monotonic timer and starts it with the first buffered row.
    pub fn due(self, rows: usize, bytes: usize, elapsed_ns: u64) -> bool {
        rows > 0
            && (rows >= self.max_rows || bytes >= self.max_bytes || elapsed_ns >= self.max_delay_ns)
    }
}

pub fn disposition(category: Category) -> &'static str {
    match category {
        Category::Outage => "retry unchanged with backpressure",
        Category::Poison => "halt affected partition; do not commit",
        Category::RetentionGap => "halt and report unrecoverable gap",
        _ => "reject whole request before publication",
    }
}
