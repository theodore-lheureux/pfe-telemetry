use self::AttributeError::{Invalid, Limit};
use crate::{
    common::{AnyValue, KeyValue, any_value::Value},
    wire::{Position, RawRecord, SecurityScope},
};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct TypedHash(Sha256);
impl TypedHash {
    pub fn new(domain: &str) -> Self {
        let mut h = Self(Sha256::new());
        h.field(domain.as_bytes());
        h
    }
    pub fn field(&mut self, bytes: &[u8]) {
        self.0.update((bytes.len() as u64).to_be_bytes());
        self.0.update(bytes);
    }
    pub fn u64(&mut self, value: u64) {
        self.field(&value.to_be_bytes());
    }
    pub fn finish(self) -> [u8; 32] {
        self.0.finalize().into()
    }
}

pub fn sample_id(raw: &RawRecord, position: &Position) -> Result<[u8; 32], &'static str> {
    let scope = raw.security.as_ref().ok_or("missing trusted scope")?;
    let mut h = TypedHash::new("recount.sample");
    security(&mut h, scope);
    h.u64(raw.payload_kind as u64);
    match &raw.batch {
        Some(batch) if !batch.client_id.is_empty() => {
            h.field(b"client");
            h.field(batch.client_id.as_bytes());
        }
        Some(_) => return Err("empty client identity"),
        None if !raw.record_id.is_empty() => {
            h.field(b"record");
            h.field(raw.record_id.as_bytes());
        }
        None => return Err("missing record identity"),
    }
    for p in [
        position.resource,
        position.scope,
        position.metric,
        position.point,
    ] {
        h.u64(p.into());
    }
    Ok(h.finish())
}

pub fn security(h: &mut TypedHash, scope: &SecurityScope) {
    h.field(scope.project_id.as_bytes());
    h.field(scope.source_id.as_bytes());
}

pub const LOCAL_RESOURCE_PREFIX: &str = "recount.local.";

pub fn local_resource_id(
    project: &str,
    root: &str,
    kind: crate::wire::ResourceKind,
    local_incarnation: &str,
) -> Result<String, &'static str> {
    if [project, root, local_incarnation]
        .iter()
        .any(|id| id.is_empty() || id.len() > 128)
        || root.starts_with(LOCAL_RESOURCE_PREFIX)
    {
        return Err("invalid local identity inputs");
    }
    let mut hash = TypedHash::new("recount.local-resource");
    hash.field(project.as_bytes());
    hash.field(root.as_bytes());
    hash.u64(kind as u64);
    hash.field(local_incarnation.as_bytes());
    Ok(format!("{LOCAL_RESOURCE_PREFIX}{}", hex(&hash.finish())))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttributeError {
    Invalid(&'static str),
    Limit(&'static str),
}

pub fn canonical_attributes(attrs: &[KeyValue]) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    visit_attributes::<true>(attrs, None, &mut bytes, &mut Vec::new()).map_err(attribute_reason)?;
    Ok(bytes)
}

pub fn bounded_attributes(attrs: &[KeyValue], max_nodes: usize) -> Result<(), AttributeError> {
    visit_attributes::<true>(attrs, Some(max_nodes), &mut Vec::new(), &mut Vec::new())
}

pub(crate) fn check_projected_attributes<'a>(
    attrs: &'a [KeyValue],
    order: &mut Vec<&'a KeyValue>,
) -> Result<(), &'static str> {
    visit_attributes::<false>(attrs, None, &mut Vec::new(), order).map_err(attribute_reason)
}

fn attribute_reason(error: AttributeError) -> &'static str {
    match error {
        AttributeError::Invalid(reason) | AttributeError::Limit(reason) => reason,
    }
}

fn visit_attributes<'a, const ENCODE: bool>(
    attrs: &'a [KeyValue],
    max_nodes: Option<usize>,
    out: &mut Vec<u8>,
    order: &mut Vec<&'a KeyValue>,
) -> Result<(), AttributeError> {
    struct Budget {
        max_nodes: Option<usize>,
        nodes: usize,
    }
    impl Budget {
        fn node(&mut self, depth: usize) -> Result<(), AttributeError> {
            if depth > 16 {
                return Err(if self.max_nodes.is_some() {
                    Limit("attribute depth limit")
                } else {
                    Invalid("attribute nesting limit")
                });
            }
            self.nodes += 1;
            if self.max_nodes.is_some_and(|max| self.nodes > max) {
                return Err(Limit("recursive attribute node limit"));
            }
            Ok(())
        }
        fn bytes(
            &self,
            len: usize,
            max: usize,
            reason: &'static str,
        ) -> Result<(), AttributeError> {
            if self.max_nodes.is_some() && len > max {
                Err(Limit(reason))
            } else {
                Ok(())
            }
        }
    }
    fn block(out: &mut Vec<u8>, b: &[u8]) {
        out.extend_from_slice(&(b.len() as u64).to_be_bytes());
        out.extend_from_slice(b);
    }
    fn value<'a, const ENCODE: bool>(
        out: &mut Vec<u8>,
        order: &mut Vec<&'a KeyValue>,
        v: &'a AnyValue,
        depth: usize,
        budget: &mut Budget,
    ) -> Result<(), AttributeError> {
        budget.node(depth)?;
        match &v.value {
            None => {
                if ENCODE {
                    out.push(0);
                }
            }
            Some(Value::StringValue(v)) => {
                budget.bytes(v.len(), 65536, "attribute string byte limit")?;
                if ENCODE {
                    out.push(1);
                    block(out, v.as_bytes());
                }
            }
            Some(Value::BoolValue(v)) => {
                if ENCODE {
                    out.push(2);
                    out.push(u8::from(*v));
                }
            }
            Some(Value::IntValue(v)) => {
                if ENCODE {
                    out.push(3);
                    out.extend_from_slice(&v.to_be_bytes());
                }
            }
            Some(Value::DoubleValue(v)) if v.is_finite() => {
                if ENCODE {
                    out.push(4);
                    out.extend_from_slice(&v.to_bits().to_be_bytes());
                }
            }
            Some(Value::DoubleValue(_)) => return Err(Invalid("nonfinite attribute")),
            Some(Value::ArrayValue(v)) => {
                if ENCODE {
                    out.push(5);
                    out.extend_from_slice(&(v.values.len() as u64).to_be_bytes());
                }
                for v in &v.values {
                    value::<ENCODE>(out, order, v, depth + 1, budget)?;
                }
            }
            Some(Value::KvlistValue(v)) => {
                if ENCODE {
                    out.push(6);
                }
                attributes::<ENCODE>(out, order, &v.values, depth + 1, budget)?;
            }
            Some(Value::BytesValue(v)) => {
                budget.bytes(v.len(), 65536, "attribute bytes limit")?;
                if ENCODE {
                    out.push(7);
                    block(out, v);
                }
            }
            Some(Value::StringValueStrindex(_)) => {
                return Err(Invalid("dictionary strings are not admitted for metrics"));
            }
        }
        Ok(())
    }
    fn attributes<'a, const ENCODE: bool>(
        out: &mut Vec<u8>,
        order: &mut Vec<&'a KeyValue>,
        attrs: &'a [KeyValue],
        depth: usize,
        budget: &mut Budget,
    ) -> Result<(), AttributeError> {
        if budget
            .max_nodes
            .is_some_and(|max| attrs.len() > max.saturating_sub(budget.nodes))
        {
            return Err(Limit("recursive attribute node limit"));
        }
        let start = order.len();
        order.extend(attrs);
        let ordered = &mut order[start..];
        ordered.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        if ordered.windows(2).any(|v| v[0].key == v[1].key) {
            return Err(Invalid("duplicate attribute key"));
        }
        if ENCODE {
            out.extend_from_slice(&(attrs.len() as u64).to_be_bytes());
        }
        for i in start..start + attrs.len() {
            let kv = order[i];
            budget.bytes(kv.key.len(), 128, "attribute key byte limit")?;
            if kv.key_strindex != 0 {
                return Err(Invalid("dictionary keys are not admitted for metrics"));
            }
            if kv.key.is_empty() {
                return Err(Invalid("empty attribute key"));
            }
            if ENCODE {
                block(out, kv.key.as_bytes());
            }
            match &kv.value {
                Some(v) => {
                    if ENCODE {
                        out.push(1);
                    }
                    value::<ENCODE>(out, order, v, depth, budget)?;
                }
                None => {
                    budget.node(depth)?;
                    if ENCODE {
                        out.push(0);
                    }
                }
            }
        }
        order.truncate(start);
        Ok(())
    }
    attributes::<ENCODE>(
        out,
        order,
        attrs,
        0,
        &mut Budget {
            max_nodes,
            nodes: 0,
        },
    )
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

// The initial fixed-count operational policy supplies affinity, not global
// event order. Resizing requires an explicit routing/ordering policy.
pub fn partition(key: &[u8; 32], partitions: u32) -> Option<u32> {
    (partitions > 0)
        .then(|| (u64::from_be_bytes(key[..8].try_into().unwrap()) % u64::from(partitions)) as u32)
}

pub fn raw_routing_key(raw: &RawRecord) -> Result<[u8; 32], &'static str> {
    let scope = raw.security.as_ref().ok_or("missing trusted scope")?;
    let mut h = TypedHash::new("recount.raw-source");
    security(&mut h, scope);
    Ok(h.finish())
}
