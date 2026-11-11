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
    encode_attributes(attrs, None).map_err(|error| match error {
        AttributeError::Invalid(reason) | AttributeError::Limit(reason) => reason,
    })
}

pub fn bounded_attributes(attrs: &[KeyValue], max_nodes: usize) -> Result<(), AttributeError> {
    encode_attributes(attrs, Some(max_nodes)).map(|_| ())
}

fn encode_attributes(
    attrs: &[KeyValue],
    max_nodes: Option<usize>,
) -> Result<Vec<u8>, AttributeError> {
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
    fn value(
        out: &mut Vec<u8>,
        v: &AnyValue,
        depth: usize,
        budget: &mut Budget,
    ) -> Result<(), AttributeError> {
        budget.node(depth)?;
        match &v.value {
            None => out.push(0),
            Some(Value::StringValue(v)) => {
                budget.bytes(v.len(), 65536, "attribute string byte limit")?;
                out.push(1);
                block(out, v.as_bytes());
            }
            Some(Value::BoolValue(v)) => {
                out.push(2);
                out.push(u8::from(*v));
            }
            Some(Value::IntValue(v)) => {
                out.push(3);
                out.extend_from_slice(&v.to_be_bytes());
            }
            Some(Value::DoubleValue(v)) if v.is_finite() => {
                out.push(4);
                out.extend_from_slice(&v.to_bits().to_be_bytes());
            }
            Some(Value::DoubleValue(_)) => return Err(Invalid("nonfinite attribute")),
            Some(Value::ArrayValue(v)) => {
                out.push(5);
                out.extend_from_slice(&(v.values.len() as u64).to_be_bytes());
                for v in &v.values {
                    value(out, v, depth + 1, budget)?;
                }
            }
            Some(Value::KvlistValue(v)) => {
                out.push(6);
                attributes(out, &v.values, depth + 1, budget)?;
            }
            Some(Value::BytesValue(v)) => {
                budget.bytes(v.len(), 65536, "attribute bytes limit")?;
                out.push(7);
                block(out, v);
            }
            Some(Value::StringValueStrindex(_)) => {
                return Err(Invalid("dictionary strings are not admitted for metrics"));
            }
        }
        Ok(())
    }
    fn attributes(
        out: &mut Vec<u8>,
        attrs: &[KeyValue],
        depth: usize,
        budget: &mut Budget,
    ) -> Result<(), AttributeError> {
        if budget
            .max_nodes
            .is_some_and(|max| attrs.len() > max.saturating_sub(budget.nodes))
        {
            return Err(Limit("recursive attribute node limit"));
        }
        let mut ordered: Vec<_> = attrs.iter().collect();
        ordered.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        if ordered.windows(2).any(|v| v[0].key == v[1].key) {
            return Err(Invalid("duplicate attribute key"));
        }
        out.extend_from_slice(&(ordered.len() as u64).to_be_bytes());
        for kv in ordered {
            budget.bytes(kv.key.len(), 128, "attribute key byte limit")?;
            if kv.key_strindex != 0 {
                return Err(Invalid("dictionary keys are not admitted for metrics"));
            }
            if kv.key.is_empty() {
                return Err(Invalid("empty attribute key"));
            }
            block(out, kv.key.as_bytes());
            match &kv.value {
                Some(v) => {
                    out.push(1);
                    value(out, v, depth, budget)?;
                }
                None => {
                    budget.node(depth)?;
                    out.push(0);
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    attributes(
        &mut out,
        attrs,
        0,
        &mut Budget {
            max_nodes,
            nodes: 0,
        },
    )?;
    Ok(out)
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
    // One bounded original request per record preserves its acknowledgement and positions.
    let mut h = TypedHash::new("recount.raw-route");
    h.field(&sample_id(raw, &Position::default())?);
    Ok(h.finish())
}
