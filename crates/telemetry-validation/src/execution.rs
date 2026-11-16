use crate::{
    Category, Issue,
    authority::identifier,
    linux_adapter::{IdentifierKind, ProcessIdentity, parse_identifier},
};
use prost::Message;
use recount_telemetry_schema::{
    execution::*,
    identity::{TypedHash, local_resource_id},
    wire::{
        AnalyticalParticipant, ExecutionMetadata, ParticipantFact, ParticipantFactKind,
        ParticipantOrigin, ProcessIncarnation, ResourceKind, process_exit::Outcome,
    },
};
use uuid::Uuid;

fn invalid(reason: &'static str) -> Issue {
    Issue::new(Category::Invalid, "participant", reason)
}
fn limit(reason: &'static str) -> Issue {
    Issue::new(Category::Limit, "participant", reason)
}
fn bounded(value: &str, maximum: usize) -> Result<(), Issue> {
    if value.len() > maximum {
        return Err(limit("String byte limit exceeded"));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid("Control characters are not permitted"));
    }
    Ok(())
}
pub fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}
fn parameter_key(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn process(value: &ProcessIncarnation) -> Result<(), Issue> {
    bounded(&value.namespace_id, MAX_NAMESPACE_BYTES)?;
    if !identifier(&value.namespace_id) || value.pid == 0 || value.pid > i32::MAX as u32 {
        return Err(invalid("Invalid process incarnation"));
    }
    Ok(())
}
fn metadata(value: &ExecutionMetadata) -> Result<(), Issue> {
    for (text, maximum) in [
        (value.name.as_deref(), MAX_NAME_BYTES),
        (
            value.workload_version.as_deref(),
            MAX_WORKLOAD_VERSION_BYTES,
        ),
    ] {
        if let Some(text) = text {
            bounded(text, maximum)?;
            if text.is_empty() || text.trim() != text {
                return Err(invalid("Invalid execution metadata"));
            }
        }
    }
    if value.parameters.len() > MAX_PARAMETERS {
        return Err(limit("Parameter count limit exceeded"));
    }
    let mut previous: Option<&str> = None;
    for parameter in &value.parameters {
        bounded(&parameter.key, MAX_PARAMETER_KEY_BYTES)?;
        bounded(&parameter.value, MAX_PARAMETER_VALUE_BYTES)?;
        if !parameter_key(&parameter.key) || previous.is_some_and(|p| p >= parameter.key.as_str()) {
            return Err(invalid("Parameter keys must be unique and sorted"));
        }
        previous = Some(&parameter.key);
    }
    Ok(())
}
pub fn validate(fact: &ParticipantFact) -> Result<(), Issue> {
    if fact.encoded_len() > MAX_CLAIM_BYTES {
        return Err(limit("Claim byte limit exceeded"));
    }
    if ![
        &fact.project_id,
        &fact.node_id,
        &fact.participant_id,
        &fact.fact_id,
    ]
    .into_iter()
    .all(|id| uuid(id))
        || !identifier(&fact.host_id)
        || fact.host_id.starts_with("recount.local.")
        || parse_identifier(&fact.boot_id, IdentifierKind::Boot) != Some(fact.boot_id.as_str())
        || fact.revision == 0
    {
        return Err(invalid("Invalid participant identity"));
    }
    bounded(&fact.execution_key, MAX_EXECUTION_KEY_BYTES)?;
    if !fact
        .execution_key
        .bytes()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        || !fact
            .execution_key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("Invalid execution key"));
    }
    let kind =
        ParticipantFactKind::try_from(fact.kind).map_err(|_| invalid("Unknown fact kind"))?;
    if kind == ParticipantFactKind::ParticipantFactUnknown
        || (kind == ParticipantFactKind::ParticipantLifecycle
            && fact.fact_id != fact.participant_id)
    {
        return Err(invalid("Invalid lifecycle identity"));
    }
    let subject = fact
        .subject
        .as_ref()
        .ok_or_else(|| invalid("Missing subject"))?;
    if subject.process.is_none() && subject.cgroup.is_none() {
        return Err(invalid("Empty subject"));
    }
    if kind == ParticipantFactKind::ProcessMembership
        && (subject.process.is_none()
            || fact.metadata.is_some()
            || fact.fact_id == fact.participant_id)
    {
        return Err(invalid("Invalid process membership"));
    }
    if let Some(value) = &subject.process {
        process(value)?;
    }
    if let Some(group) = &subject.cgroup {
        bounded(&group.namespace_id, MAX_NAMESPACE_BYTES)?;
        bounded(&group.path, MAX_CGROUP_PATH_BYTES)?;
        if !identifier(&group.namespace_id)
            || group.inode == 0
            || !uuid(&group.incarnation_id)
            || !group.path.starts_with('/')
            || group.path[1..]
                .split('/')
                .any(|c| c.is_empty() || c == "." || c == "..")
        {
            return Err(invalid("Invalid cgroup incarnation"));
        }
    }
    let provenance = fact
        .provenance
        .as_ref()
        .ok_or_else(|| invalid("Missing provenance"))?;
    if provenance
        .launcher_claim_id
        .as_deref()
        .is_some_and(|id| !uuid(id))
    {
        return Err(invalid("Invalid launcher reference"));
    }
    match ParticipantOrigin::try_from(provenance.origin) {
        Ok(ParticipantOrigin::Launcher)
            if provenance.launcher_claim_id.is_some()
                && fact.owner_uid.is_some()
                && provenance.adapter.is_none()
                && provenance.ancestry_root.is_none()
                && provenance.parent.is_none() => {}
        Ok(ParticipantOrigin::SchedulerAdapter)
            if subject.cgroup.is_some()
                && provenance.launcher_claim_id.is_none()
                && provenance.ancestry_root.is_none()
                && provenance.parent.is_none() =>
        {
            let adapter = provenance
                .adapter
                .as_deref()
                .ok_or_else(|| invalid("Missing adapter"))?;
            bounded(adapter, MAX_ADAPTER_BYTES)?;
            if !parameter_key(adapter) {
                return Err(invalid("Invalid adapter"));
            }
        }
        Ok(ParticipantOrigin::Ancestry)
            if subject.cgroup.is_none()
                && kind == ParticipantFactKind::ProcessMembership
                && provenance.launcher_claim_id.is_some()
                && provenance.adapter.is_none() =>
        {
            process(
                provenance
                    .ancestry_root
                    .as_ref()
                    .ok_or_else(|| invalid("Missing ancestry root"))?,
            )?;
            process(
                provenance
                    .parent
                    .as_ref()
                    .ok_or_else(|| invalid("Missing parent"))?,
            )?;
        }
        _ => return Err(invalid("Invalid participant provenance")),
    }
    if fact.first_seen_unix_nano == 0
        || fact.first_seen_unix_nano > fact.last_seen_unix_nano
        || fact
            .ended_unix_nano
            .is_some_and(|end| end <= fact.last_seen_unix_nano)
    {
        return Err(invalid("Invalid participant interval"));
    }
    if let Some(exit) = &fact.exit
        && (subject.process.is_none()
            || exit.time_unix_nano < fact.first_seen_unix_nano
            || !matches!(
                exit.outcome,
                Some(Outcome::Code(0..=255) | Outcome::Signal(1..=64))
            ))
    {
        return Err(invalid("Invalid process exit"));
    }
    if let Some(value) = &fact.metadata {
        metadata(value)?;
    }
    Ok(())
}

pub fn routing_key(project_id: &str, execution_key: &str) -> [u8; 32] {
    let mut hash = TypedHash::new("recount.execution-route");
    hash.field(project_id.as_bytes());
    hash.field(execution_key.as_bytes());
    hash.finish()
}

pub fn process_resource(
    fact: &ParticipantFact,
    process: &ProcessIncarnation,
) -> Result<String, Issue> {
    let incarnation = ProcessIdentity {
        boot: &fact.boot_id,
        namespace: &process.namespace_id,
        pid: process.pid.into(),
        start_ticks: process.start_time_ticks,
    }
    .incarnation();
    local_resource_id(
        &fact.project_id,
        &fact.host_id,
        ResourceKind::Process,
        &incarnation,
    )
    .map_err(invalid)
}

pub fn project(
    fact: &ParticipantFact,
    record_id: &str,
    received_unix_nano: u64,
) -> Result<AnalyticalParticipant, Issue> {
    validate(fact)?;
    if !uuid(record_id) || received_unix_nano == 0 {
        return Err(invalid("Invalid admission context"));
    }
    let subject = fact.subject.as_ref().unwrap();
    let process = subject.process.as_ref();
    let group = subject.cgroup.as_ref();
    let provenance = fact.provenance.as_ref().unwrap();
    let process_id = |process| process_resource(fact, process);
    let row = AnalyticalParticipant {
        project_id: fact.project_id.clone(),
        node_id: fact.node_id.clone(),
        host_id: fact.host_id.clone(),
        boot_id: fact.boot_id.clone(),
        execution_key: fact.execution_key.clone(),
        participant_id: fact.participant_id.clone(),
        fact_id: fact.fact_id.clone(),
        revision: fact.revision,
        kind: fact.kind,
        process_resource_id: process.map(process_id).transpose()?,
        process_namespace_id: process.map(|p| p.namespace_id.clone()),
        process_pid: process.map(|p| p.pid),
        process_start_time_ticks: process.map(|p| p.start_time_ticks),
        cgroup_incarnation_id: group.map(|g| g.incarnation_id.clone()),
        cgroup_namespace_id: group.map(|g| g.namespace_id.clone()),
        cgroup_path: group.map(|g| g.path.clone()),
        cgroup_inode: group.map(|g| g.inode),
        origin: provenance.origin,
        launcher_claim_id: provenance.launcher_claim_id.clone(),
        adapter: provenance.adapter.clone(),
        ancestry_root_resource_id: provenance
            .ancestry_root
            .as_ref()
            .map(process_id)
            .transpose()?,
        parent_resource_id: provenance.parent.as_ref().map(process_id).transpose()?,
        owner_uid: fact.owner_uid,
        first_seen_unix_nano: fact.first_seen_unix_nano,
        last_seen_unix_nano: fact.last_seen_unix_nano,
        ended_unix_nano: fact.ended_unix_nano,
        exit_unix_nano: fact.exit.as_ref().map(|e| e.time_unix_nano),
        exit_code: fact.exit.as_ref().and_then(|e| match e.outcome {
            Some(Outcome::Code(c)) => Some(c),
            _ => None,
        }),
        exit_signal: fact.exit.as_ref().and_then(|e| match e.outcome {
            Some(Outcome::Signal(s)) => Some(s),
            _ => None,
        }),
        retracted: fact.retracted,
        provenance: provenance.encode_to_vec(),
        execution_name: fact.metadata.as_ref().and_then(|m| m.name.clone()),
        workload_version: fact
            .metadata
            .as_ref()
            .and_then(|m| m.workload_version.clone()),
        parameters: fact
            .metadata
            .as_ref()
            .map(|m| m.parameters.clone())
            .unwrap_or_default(),
        record_id: record_id.to_owned(),
        received_unix_nano,
    };
    if row.encoded_len() > MAX_ANALYTICAL_RECORD_BYTES {
        return Err(limit("Analytical participant byte limit exceeded"));
    }
    Ok(row)
}
