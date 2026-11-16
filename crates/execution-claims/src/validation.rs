use crate::{ExecutionMetadata, LocalExecutionClaim, process_exit::Outcome};
use prost::Message;
use recount_telemetry_schema::execution::*;
use std::io;
use uuid::Uuid;

pub(crate) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(crate) fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn text(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(char::is_control)
}

fn label(value: &str, max: usize) -> bool {
    !value.is_empty() && value.trim() == value && text(value, max)
}

fn parameter_key(value: &str) -> bool {
    value.len() <= MAX_PARAMETER_KEY_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

/// Validate explicit metadata, including sorted, unique parameter keys.
pub fn validate_metadata(metadata: &ExecutionMetadata) -> io::Result<()> {
    if metadata
        .name
        .as_deref()
        .is_some_and(|s| !label(s, MAX_NAME_BYTES))
        || metadata
            .workload_version
            .as_deref()
            .is_some_and(|s| !label(s, MAX_WORKLOAD_VERSION_BYTES))
        || metadata.parameters.len() > MAX_PARAMETERS
    {
        return Err(invalid("invalid execution metadata"));
    }
    let mut previous: Option<&str> = None;
    for parameter in &metadata.parameters {
        if !parameter_key(&parameter.key)
            || !text(&parameter.value, MAX_PARAMETER_VALUE_BYTES)
            || previous.is_some_and(|key| key >= parameter.key.as_str())
        {
            return Err(invalid(
                "invalid, duplicate or unsorted execution parameter",
            ));
        }
        previous = Some(&parameter.key);
    }
    Ok(())
}

/// Validate a local snapshot. The collector verifies live kernel identities
/// and member UIDs; no cgroup identity is supplied by the launcher.
pub fn validate(claim: &LocalExecutionClaim) -> io::Result<()> {
    if claim.encoded_len() > MAX_CLAIM_BYTES {
        return Err(invalid("oversized local claim"));
    }
    if !uuid(&claim.claim_id)
        || !uuid(&claim.boot_id)
        || claim.revision == 0
        || claim.execution_key.len() > MAX_EXECUTION_KEY_BYTES
        || !claim
            .execution_key
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !claim
            .execution_key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("invalid claim identity or execution key"));
    }
    let subject = claim
        .subject
        .as_ref()
        .ok_or_else(|| invalid("missing local subject"))?;
    let process = subject
        .process
        .as_ref()
        .ok_or_else(|| invalid("missing launched root"))?;
    if process.pid == 0 || process.pid > i32::MAX as u32 {
        return Err(invalid("invalid root PID"));
    }
    if claim.first_seen_unix_nano == 0
        || claim.last_seen_unix_nano < claim.first_seen_unix_nano
        || claim
            .ended_unix_nano
            .is_some_and(|end| end <= claim.last_seen_unix_nano)
    {
        return Err(invalid("invalid snapshot times"));
    }
    if let Some(exit) = &claim.exit {
        if claim.ended_unix_nano.is_none() {
            return Err(invalid("terminal local claim requires a root end"));
        }
        if exit.time_unix_nano < claim.first_seen_unix_nano {
            return Err(invalid("exit precedes launch"));
        }
        match exit.outcome {
            Some(Outcome::Code(0..=255) | Outcome::Signal(1..=64)) => {}
            _ => return Err(invalid("invalid exit outcome")),
        }
    }
    if let Some(metadata) = &claim.metadata {
        validate_metadata(metadata)?;
    }
    Ok(())
}
