use crate::{Category, Issue};
use recount_telemetry_schema::{
    common::KeyValue,
    identity,
    point::string_attribute,
    wire::{BatchIdentity, ResourceKind, ResourceRef},
};

pub const BATCH_ID: &str = "recount-batch-id";
pub const BATCH_CREATED: &str = "recount-batch-created-unix-nano";
pub const PROFILE: &str = "recount-collection-profile";

pub fn resource_claim(attributes: &[KeyValue]) -> Result<Option<ResourceRef>, Issue> {
    identity::canonical_attributes(attributes)
        .map_err(|e| Issue::new(Category::Invalid, "resource.attributes", e))?;
    let get = |key: &'static str| -> Result<Option<&str>, Issue> {
        let value = string_attribute(attributes, key);
        if attributes.iter().any(|a| a.key == key)
            && value.is_none_or(|v| v.is_empty() || v.len() > 128)
        {
            return Err(Issue::new(
                Category::Invalid,
                "resource.attributes",
                "resource reference must be a bounded nonempty string",
            ));
        }
        Ok(value)
    };
    let id = get("recount.resource.id")?;
    let kind = get("recount.resource.kind")?;
    let kind = match kind {
        None | Some("unknown") => ResourceKind::ResourceUnknown,
        Some("host") => ResourceKind::Host,
        Some("cpu") => ResourceKind::Cpu,
        Some("gpu") => ResourceKind::Gpu,
        Some("process") => ResourceKind::Process,
        Some("vm") => ResourceKind::Vm,
        Some("container") => ResourceKind::Container,
        Some("gateway") => ResourceKind::Gateway,
        Some("sensor") => ResourceKind::Sensor,
        _ => {
            return Err(Issue::new(
                Category::Unsupported,
                "resource.attributes",
                "unsupported resource kind",
            ));
        }
    };
    match id {
        Some(id) => Ok(Some(ResourceRef {
            id: id.into(),
            kind: kind as i32,
        })),
        None if kind == ResourceKind::ResourceUnknown => Ok(None),
        None => Err(Issue::new(
            Category::Invalid,
            "resource.attributes",
            "resource kind requires explicit resource ID",
        )),
    }
}

pub fn headers(values: &[(&str, &str)]) -> Result<(Profile, Option<BatchIdentity>), Issue> {
    fn one<'a>(values: &[(&str, &'a str)], name: &'static str) -> Result<Option<&'a str>, Issue> {
        let mut selected = values
            .iter()
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| *value);
        let first = selected.next();
        if selected.next().is_some() {
            return Err(Issue::new(Category::Invalid, name, "duplicate metadata"));
        }
        Ok(first)
    }
    let profile = profile(one(values, PROFILE)?)?;
    let batch = batch(one(values, BATCH_ID)?, one(values, BATCH_CREATED)?)?;
    if profile == Profile::Linux && batch.is_none() {
        return Err(Issue::new(
            Category::Invalid,
            BATCH_ID,
            "Recount Linux collector requires durable batch identity",
        ));
    }
    Ok((profile, batch))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Standard,
    Linux,
}
pub fn profile(value: Option<&str>) -> Result<Profile, Issue> {
    match value {
        None | Some("standard") => Ok(Profile::Standard),
        Some("linux") => Ok(Profile::Linux),
        _ => Err(Issue::new(
            Category::Unsupported,
            PROFILE,
            "unsupported collection profile",
        )),
    }
}
pub fn batch(id: Option<&str>, created: Option<&str>) -> Result<Option<BatchIdentity>, Issue> {
    match (id, created) {
        (None, None) => Ok(None),
        (Some(id), Some(created))
            if !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)) =>
        {
            let time = if created.len() <= 20 && created.bytes().all(|b| b.is_ascii_digit()) {
                created.parse::<u64>().ok().filter(|v| *v > 0)
            } else {
                None
            };
            Ok(Some(BatchIdentity {
                client_id: id.into(),
                created_unix_nano: time.ok_or_else(|| {
                    Issue::new(
                        Category::Invalid,
                        BATCH_CREATED,
                        "expected positive UInt64 nanoseconds",
                    )
                })?,
            }))
        }
        _ => Err(Issue::new(
            Category::Invalid,
            BATCH_ID,
            "batch identity and time required together; ID is a bounded ASCII token",
        )),
    }
}
pub fn age(
    batch: &BatchIdentity,
    received: u64,
    maximum_age_ns: u64,
    skew_ns: u64,
) -> Result<(), Issue> {
    if maximum_age_ns == 0 || maximum_age_ns.checked_add(skew_ns).is_none() {
        return Err(Issue::new(
            Category::Invalid,
            "admission",
            "positive upload age and nonoverflowing age plus skew required",
        ));
    }
    if batch.created_unix_nano > received.saturating_add(skew_ns) {
        return Err(Issue::new(
            Category::Invalid,
            BATCH_CREATED,
            "creation time exceeds allowed future skew",
        ));
    }
    if received.saturating_sub(batch.created_unix_nano) > maximum_age_ns.saturating_add(skew_ns) {
        return Err(Issue::new(
            Category::Expired,
            BATCH_CREATED,
            "submission expired",
        ));
    }
    Ok(())
}
