use std::{collections::HashSet, fs, path::Path};

use serde::Deserialize;
use subtle::ConstantTimeEq;
use tonic::{Status, metadata::MetadataMap};

use crate::Result;

/// Binds a collector credential to a project, source and permitted hosts.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub project_id: String,
    pub source_id: String,
    pub token_sha256: String,
    pub hosts: Vec<String>,
    #[serde(default = "yes")]
    pub require_host_id: bool,
    #[serde(default = "submission_age")]
    pub maximum_submission_age: u64,
    #[serde(default = "clock_skew")]
    pub allowed_clock_skew: u64,
}

fn yes() -> bool {
    true
}
fn submission_age() -> u64 {
    3600
}
fn clock_skew() -> u64 {
    60
}

/// Validated enrollment policies loaded separately from telemetry storage.
pub struct Sources(Vec<Source>);

impl Sources {
    pub fn load(path: &Path) -> Result<Self> {
        Self::parse(&fs::read_to_string(path)?)
    }

    pub fn parse(json: &str) -> Result<Self> {
        let sources: Vec<Source> = serde_json::from_str(json)?;
        let mut ids = HashSet::new();
        let mut tokens = HashSet::new();
        if sources.is_empty() {
            return Err("At least one source must be configured".into());
        }
        for source in &sources {
            if !identifier(&source.project_id)
                || !identifier(&source.source_id)
                || !ids.insert((&source.project_id, &source.source_id))
                || source.token_sha256.len() != 64
                || !source
                    .token_sha256
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                || !tokens.insert(&source.token_sha256)
                || source.hosts.iter().any(|v| !identifier(v))
                || (source.require_host_id && source.hosts.is_empty())
                || !(1..=86_400).contains(&source.maximum_submission_age)
                || !(1..=3600).contains(&source.allowed_clock_skew)
            {
                return Err("Invalid or duplicate source policy".into());
            }
        }
        Ok(Self(sources))
    }

    pub fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status> {
        let value = one(metadata, "authorization")?
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| {
                (32..=512).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
            })
            .ok_or_else(|| Status::unauthenticated("A source bearer token is required"))?;
        let hash = crate::envelope::digest(value.as_bytes());
        self.0
            .iter()
            .find(|source| bool::from(source.token_sha256.as_bytes().ct_eq(hash.as_bytes())))
            .cloned()
            .ok_or_else(|| Status::unauthenticated("Invalid source credentials"))
    }
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

pub fn one<'a>(
    metadata: &'a MetadataMap,
    key: &'static str,
) -> std::result::Result<Option<&'a str>, Status> {
    let mut values = metadata.get_all(key).iter();
    let value = values.next();
    if values.next().is_some() {
        return Err(Status::invalid_argument("Repeated request metadata"));
    }
    value
        .map(|v| {
            v.to_str()
                .map_err(|_| Status::invalid_argument("Invalid request metadata"))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authentication_uses_enrollment_not_payload_identity() {
        let token = "test-token-with-at-least-32-characters";
        let json = serde_json::json!([{"project_id":"project", "source_id":"source", "token_sha256":crate::envelope::digest(token.as_bytes()), "hosts":["node"]}]).to_string();
        let sources = Sources::parse(&json).unwrap();
        let mut metadata = MetadataMap::new();
        assert_eq!(
            sources.authenticate(&metadata).err().unwrap().code(),
            tonic::Code::Unauthenticated
        );
        metadata.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert_eq!(
            sources.authenticate(&metadata).unwrap().project_id,
            "project"
        );
        metadata.append("authorization", format!("Bearer {token}").parse().unwrap());
        assert!(sources.authenticate(&metadata).is_err());
        assert!(Sources::parse(&json.replace("\"source\"", "\"\"")).is_err());
    }
}
