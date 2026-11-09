pub mod config;
pub mod kafka;
pub mod runtime;

use prost::Message;
use recount_telemetry_schema::{identity, point, wire::RawRecord};
use recount_telemetry_validation::{
    Category, Issue,
    validate::{self, Limits},
};

/// Revalidate accepted context without refreshing authority or submission age.
pub fn prepare(
    payload: &[u8],
    key: Option<&[u8]>,
    partitions: u32,
    limits: Limits,
) -> Result<Vec<point::RoutedRecord>, Issue> {
    let limits = limits.validate()?;
    let poison = |reason| Issue::new(Category::Poison, "raw", reason);
    if payload.len() > limits.decoded_bytes {
        return Err(poison("raw record byte limit"));
    }
    let raw = RawRecord::decode(payload).map_err(|_| poison("invalid raw encoding"))?;
    if key != Some(identity::raw_routing_key(&raw).map_err(poison)?.as_slice()) {
        return Err(poison("raw routing key mismatch"));
    }
    let points = validate::retained_raw(&raw, limits)?;
    point::kafka_records(&points, partitions, limits.normalized_record_bytes).map_err(poison)
}
