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
        ParticipantOrigin, ProcessIncarnation, ResourceKind,
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
pub fn metadata(value: &ExecutionMetadata) -> Result<(), Issue> {
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
    execution_key(&fact.execution_key)?;
    let kind =
        ParticipantFactKind::try_from(fact.kind).map_err(|_| invalid("Unknown fact kind"))?;
    if kind == ParticipantFactKind::ParticipantFactUnknown
        || (kind == ParticipantFactKind::ParticipantLifecycle
            && fact.fact_id != fact.participant_id)
    {
        return Err(invalid("Invalid lifecycle identity"));
    }
    if kind == ParticipantFactKind::ParticipantLifecycle && fact.subject.is_some() {
        return Err(invalid("Lifecycle must not have a process subject"));
    }
    let member = fact.subject.as_ref().and_then(|s| s.process.as_ref());
    if kind == ParticipantFactKind::ProcessMembership
        && (member.is_none() || fact.metadata.is_some() || fact.fact_id == fact.participant_id)
    {
        return Err(invalid("Invalid process membership"));
    }
    if let Some(value) = member {
        process(value)?;
    }
    let provenance = fact
        .provenance
        .as_ref()
        .ok_or_else(|| invalid("Missing provenance"))?;
    bounded(
        &provenance.environment_variable,
        MAX_ENVIRONMENT_VARIABLE_BYTES,
    )?;
    if provenance.origin != ParticipantOrigin::Environment as i32
        || !environment_variable(&provenance.environment_variable)
    {
        return Err(invalid("Invalid environment provenance"));
    }
    if fact.first_seen_unix_nano == 0
        || fact.first_seen_unix_nano > fact.last_seen_unix_nano
        || fact
            .ended_unix_nano
            .is_some_and(|end| end <= fact.last_seen_unix_nano)
    {
        return Err(invalid("Invalid participant interval"));
    }
    if let Some(value) = &fact.metadata {
        metadata(value)?;
    }
    Ok(())
}

pub fn execution_key(value: &str) -> Result<(), Issue> {
    bounded(value, MAX_EXECUTION_KEY_BYTES)?;
    if !value
        .bytes()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("Invalid execution key"));
    }
    Ok(())
}

fn environment_variable(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
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
    let process = fact.subject.as_ref().and_then(|s| s.process.as_ref());
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
        origin: provenance.origin,
        environment_variable: provenance.environment_variable.clone(),
        owner_uid: fact.owner_uid,
        first_seen_unix_nano: fact.first_seen_unix_nano,
        last_seen_unix_nano: fact.last_seen_unix_nano,
        ended_unix_nano: fact.ended_unix_nano,
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
