use super::{GPU_PARENT_UUID, GPU_UUID, Scope};
use recount_telemetry_schema::{common::KeyValue, point::string_attribute};

/// Physical and current MIG UUIDs, not recycled device/GI/CI ordinals.
pub fn gpu_uuid(value: &str) -> bool {
    let raw = value
        .strip_prefix("GPU-")
        .or_else(|| value.strip_prefix("MIG-"));
    raw.is_some_and(|raw| {
        uuid::Uuid::parse_str(raw).is_ok_and(|id| !id.is_nil() && id.to_string() == raw)
    })
}

pub(super) fn identity(attrs: &[KeyValue], scope: Scope) -> Result<Option<&str>, crate::Issue> {
    if scope != Scope::Gpu {
        return Ok(None);
    }
    let invalid = || {
        crate::Issue::new(
            crate::Category::Invalid,
            "resource.attributes",
            "Missing or invalid Linux GPU identity",
        )
    };
    let uuid = string_attribute(attrs, GPU_UUID)
        .filter(|uuid| gpu_uuid(uuid))
        .ok_or_else(invalid)?;
    let parent = string_attribute(attrs, GPU_PARENT_UUID);
    if attrs
        .iter()
        .any(|attribute| attribute.key == GPU_PARENT_UUID)
        && parent.is_none()
    {
        return Err(invalid());
    }
    if let Some(parent) = parent
        && (!uuid.starts_with("MIG-") || !parent.starts_with("GPU-") || !gpu_uuid(parent))
    {
        return Err(invalid());
    }
    if uuid.starts_with("MIG-") && parent.is_none() {
        return Err(invalid());
    }
    Ok(Some(uuid))
}
