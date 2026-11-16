use std::{collections::BTreeMap, fmt, io::Read};

use recount_telemetry_schema::{
    execution::{MAX_ENVIRONMENT_BYTES, MAX_PARAMETERS},
    wire::{ExecutionMetadata, ExecutionParameter},
};
use recount_telemetry_validation::execution;
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};

#[derive(Clone, PartialEq)]
pub(super) struct Label {
    pub key: String,
    pub variable: String,
    pub metadata: Option<ExecutionMetadata>,
}

/// Errors deliberately carry no environment bytes, variable names or parser diagnostics.
pub(super) fn read(reader: impl Read, schedulers: &BTreeMap<String, String>) -> Option<Label> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_ENVIRONMENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    parse(&bytes, schedulers)
}

fn parse(bytes: &[u8], schedulers: &BTreeMap<String, String>) -> Option<Label> {
    if bytes.is_empty() || bytes.len() > MAX_ENVIRONMENT_BYTES || bytes.last() != Some(&0) {
        return None;
    }
    let mut selected = BTreeMap::new();
    for entry in bytes[..bytes.len() - 1].split(|&b| b == 0) {
        let equals = entry.iter().position(|&b| b == b'=')?;
        if equals == 0 {
            return None;
        }
        let (name, value) = (&entry[..equals], &entry[equals + 1..]);
        // Compare raw names before decoding; unrelated environment values may be non-UTF-8.
        let explicit = matches!(
            name,
            b"RECOUNT_EXECUTION"
                | b"RECOUNT_EXECUTION_NAME"
                | b"RECOUNT_EXECUTION_VERSION"
                | b"RECOUNT_EXECUTION_PARAMETERS"
        );
        let scheduler = schedulers.keys().find(|key| key.as_bytes() == name);
        if explicit || scheduler.is_some() {
            let name = std::str::from_utf8(name).ok()?;
            if selected.insert(name, value).is_some() {
                return None;
            }
        }
    }
    if let Some(key) = selected.get("RECOUNT_EXECUTION") {
        let key = std::str::from_utf8(key).ok()?;
        execution::execution_key(key).ok()?;
        let text = |name| {
            selected
                .get(name)
                .map(|v| std::str::from_utf8(v).map(str::to_owned))
                .transpose()
                .ok()
        };
        let parameters = selected
            .get("RECOUNT_EXECUTION_PARAMETERS")
            .map(|bytes| serde_json::from_slice::<Parameters>(bytes))
            .transpose()
            .ok()?
            .map(|p| p.0)
            .unwrap_or_default();
        let metadata = ExecutionMetadata {
            name: text("RECOUNT_EXECUTION_NAME")?,
            workload_version: text("RECOUNT_EXECUTION_VERSION")?,
            parameters: parameters
                .into_iter()
                .map(|(key, value)| ExecutionParameter { key, value })
                .collect(),
        };
        execution::metadata(&metadata).ok()?;
        return Some(Label {
            key: key.into(),
            variable: "RECOUNT_EXECUTION".into(),
            metadata: Some(metadata),
        });
    }
    for (variable, prefix) in schedulers {
        if let Some(value) = selected.get(variable.as_str()) {
            let key = format!("{prefix}:{}", std::str::from_utf8(value).ok()?);
            execution::execution_key(&key).ok()?;
            return Some(Label {
                key,
                variable: variable.clone(),
                metadata: None,
            });
        }
    }
    None
}

struct Parameters(BTreeMap<String, String>);

impl<'de> Deserialize<'de> for Parameters {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Unique;
        impl<'de> Visitor<'de> for Unique {
            type Value = Parameters;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("unique string parameters")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut parameters = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if parameters.insert(key, value).is_some() || parameters.len() > MAX_PARAMETERS
                    {
                        return Err(serde::de::Error::custom("Invalid parameters"));
                    }
                }
                Ok(Parameters(parameters))
            }
        }
        deserializer.deserialize_map(Unique)
    }
}

#[cfg(test)]
mod tests;
