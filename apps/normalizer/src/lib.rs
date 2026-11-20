pub mod config;
pub mod kafka;
pub mod retention;
pub mod runtime;

use prost::Message;
use recount_telemetry_schema::{
    identity,
    identity_cache::IdentityCache,
    point,
    series::PreparedPoint,
    wire::{AnalyticalPoint, RawRecord},
};
use recount_telemetry_validation::{
    Category, Issue,
    validate::{self, Limits},
};

/// Revalidate accepted context and encode self-contained singleton frames.
pub fn prepare(
    payload: &[u8],
    key: Option<&[u8]>,
    partitions: u32,
    limits: Limits,
) -> Result<Vec<point::RoutedRecord>, Issue> {
    let rows = prepare_rows(payload, key, limits)?;
    runtime::packing::pack(
        rows,
        partitions,
        0,
        limits.normalized_record_bytes + recount_telemetry_validation::transport::FRAMING_RESERVE,
        false,
    )
    .map_err(|reason| Issue::new(Category::Poison, "raw", reason))
}

fn prepare_rows(
    payload: &[u8],
    key: Option<&[u8]>,
    limits: Limits,
) -> Result<Vec<AnalyticalPoint>, Issue> {
    let raw = decode_raw(payload, key, limits)?;
    validate::retained_delivery(&raw, limits)
}

fn prepare_cached_rows(
    payload: &[u8],
    key: Option<&[u8]>,
    limits: Limits,
    cache: &IdentityCache,
) -> Result<Vec<PreparedPoint>, Issue> {
    let raw = decode_raw(payload, key, limits)?;
    validate::retained_cached_delivery(&raw, limits, cache)
}

fn decode_raw(payload: &[u8], key: Option<&[u8]>, limits: Limits) -> Result<RawRecord, Issue> {
    let limits = limits.validate()?;
    let poison = |reason| Issue::new(Category::Poison, "raw", reason);
    if payload.len() > limits.decoded_bytes {
        return Err(poison("raw record byte limit"));
    }
    let raw = RawRecord::decode(payload).map_err(|_| poison("invalid raw encoding"))?;
    if key != Some(identity::raw_routing_key(&raw).map_err(poison)?.as_slice()) {
        return Err(poison("raw routing key mismatch"));
    }
    Ok(raw)
}
