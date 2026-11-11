use crate::{
    common::{AnyValue, KeyValue, any_value::Value},
    identity,
    wire::{AnalyticalPoint, AttributeNode},
};
use prost::Message;

pub(crate) struct PreparedAttributes {
    pub canonical: Vec<u8>,
    pub nodes: Vec<AttributeNode>,
}

impl PreparedAttributes {
    pub fn new(attrs: &[KeyValue]) -> Result<Self, &'static str> {
        let canonical = identity::canonical_attributes(attrs)?;
        let mut nodes = Vec::new();
        for kv in attrs {
            walk(
                &mut nodes,
                format!("/{}", escape(&kv.key)),
                kv.value.as_ref(),
            );
        }
        Ok(Self { canonical, nodes })
    }
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

// Paths retain container type and array position; node order retains map order.
// Absent map values still form projected nodes, even without an AnyValue.
fn walk(out: &mut Vec<AttributeNode>, path: String, value: Option<&AnyValue>) {
    let mut node = AttributeNode {
        path: path.clone(),
        ..Default::default()
    };
    match value.map(|v| &v.value) {
        None => {}
        Some(None) => node.kind = 1,
        Some(Some(Value::StringValue(v))) => {
            node.kind = 2;
            node.string_value = Some(v.clone());
        }
        Some(Some(Value::IntValue(v))) => {
            node.kind = 3;
            node.int_value = Some(*v);
        }
        Some(Some(Value::DoubleValue(v))) => {
            node.kind = 4;
            node.double_value = Some(*v);
        }
        Some(Some(Value::BoolValue(v))) => {
            node.kind = 5;
            node.bool_value = Some(*v);
        }
        Some(Some(Value::BytesValue(v))) => {
            node.kind = 6;
            node.bytes_value = Some(v.clone());
        }
        Some(Some(Value::ArrayValue(_))) => node.kind = 7,
        Some(Some(Value::KvlistValue(_))) => node.kind = 8,
        Some(Some(Value::StringValueStrindex(_))) => unreachable!("validated metric attributes"),
    }
    out.push(node);
    match value.and_then(|v| v.value.as_ref()) {
        Some(Value::ArrayValue(v)) => {
            for (i, value) in v.values.iter().enumerate() {
                walk(out, format!("{path}/{i}"), Some(value));
            }
        }
        Some(Value::KvlistValue(v)) => {
            for kv in &v.values {
                walk(
                    out,
                    format!("{path}/{}", escape(&kv.key)),
                    kv.value.as_ref(),
                );
            }
        }
        _ => {}
    }
}

pub fn attributes(attrs: &[KeyValue]) -> Result<Vec<AttributeNode>, &'static str> {
    Ok(PreparedAttributes::new(attrs)?.nodes)
}

// Kafka carries one bare message, consumed by ClickHouse ProtobufSingle.
pub fn serialize(row: &AnalyticalPoint) -> Vec<u8> {
    row.encode_to_vec()
}
