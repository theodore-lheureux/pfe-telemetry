use std::{collections::BTreeSet, time::Duration};

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use recount_telemetry_schema::wire::{ResourceKind, ResourceRef, SecurityScope};
use recount_telemetry_validation::policy::{BoundGrant, RequestedAuthorities, RootGrant};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio_postgres::{Row, config::SslMode};
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::{Status, metadata::MetadataMap};
use uuid::Uuid;

use crate::Result;

#[derive(Clone)]
pub struct Source {
    pub credential_id: Uuid,
    pub security: SecurityScope,
    pub root: ResourceRef,
    pub maximum_age_ns: u64,
    pub skew_ns: u64,
    pub(crate) digest: String,
}

#[tonic::async_trait]
pub trait Authority: Send + Sync {
    async fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status>;
    async fn grants(
        &self,
        source: &Source,
        requested: &RequestedAuthorities,
    ) -> std::result::Result<(Vec<RootGrant>, Vec<BoundGrant>), Status>;
    async fn ready(&self) -> bool;
}

pub struct Credentials {
    pool: Pool,
}

const LOOKUP: &str = "SELECT id, project_id, source_id, token_sha256, root_id, root_kind,
    maximum_submission_age, allowed_clock_skew FROM ingestion.collector_credential
    WHERE id = $1 AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > statement_timestamp())";

const GRANTS: &str = "SELECT g.resource_id, g.resource_kind, g.adapter,
    g.allowed_local_kinds, true AS is_root
    FROM ingestion.collector_root_grant g JOIN ingestion.collector_credential c
      ON (c.id,c.project_id,c.organization_id)=(g.credential_id,g.project_id,g.organization_id)
    WHERE c.id=$1 AND c.project_id=$2 AND c.token_sha256=$3 AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > statement_timestamp())
      AND g.resource_id=ANY($4)
    UNION ALL SELECT g.resource_id, g.resource_kind, ''::text AS adapter,
    ARRAY[]::integer[] AS allowed_local_kinds, false AS is_root
    FROM ingestion.collector_resource_grant g JOIN ingestion.collector_credential c
      ON (c.id,c.project_id,c.organization_id)=(g.credential_id,g.project_id,g.organization_id)
    WHERE c.id=$1 AND c.project_id=$2 AND c.token_sha256=$3 AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > statement_timestamp())
      AND g.resource_id=ANY($5)";

fn unavailable() -> Status {
    Status::unavailable("Credential authority is unavailable")
}

impl Credentials {
    pub fn new(database_url: &str) -> Result<Self> {
        let mut config: tokio_postgres::Config = database_url
            .parse()
            .map_err(|_| "Invalid credential database configuration")?;
        if config.get_ssl_mode() != SslMode::Disable {
            config.ssl_mode(SslMode::Require);
        }
        config
            .application_name("recount-ingestion-api")
            .connect_timeout(Duration::from_secs(1))
            .options(
                "-c statement_timeout=1000 -c lock_timeout=500 -c default_transaction_read_only=on",
            );
        let manager = Manager::from_config(
            config,
            MakeRustlsConnect::with_webpki_roots(),
            ManagerConfig {
                recycling_method: RecyclingMethod::Verified,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(4)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(Duration::from_millis(500)))
            .create_timeout(Some(Duration::from_secs(1)))
            .recycle_timeout(Some(Duration::from_millis(500)))
            .build()
            .map_err(|_| "Invalid credential pool configuration")?;
        Ok(Self { pool })
    }

    async fn query(
        &self,
        sql: &str,
        parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> std::result::Result<Vec<Row>, Status> {
        let client = tokio::time::timeout(Duration::from_secs(1), self.pool.get())
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        match tokio::time::timeout(Duration::from_secs(1), client.query(sql, parameters)).await {
            Ok(result) => result.map_err(|_| unavailable()),
            Err(_) => {
                drop(deadpool_postgres::Object::take(client));
                Err(unavailable())
            }
        }
    }
}

#[tonic::async_trait]
impl Authority for Credentials {
    async fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status> {
        let token = one(metadata, "authorization")?
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| Status::unauthenticated("A collector bearer token is required"))?;
        let id = credential_id(token)
            .ok_or_else(|| Status::unauthenticated("Invalid collector credentials"))?;
        let rows = self.query(LOOKUP, &[&id]).await?;
        let row = rows
            .first()
            .ok_or_else(|| Status::unauthenticated("Invalid collector credentials"))?;
        let stored: String = row.try_get("token_sha256").map_err(|_| unavailable())?;
        if stored.len() != 64
            || !stored
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(unavailable());
        }
        let digest = digest(token.as_bytes());
        if !bool::from(stored.as_bytes().ct_eq(digest.as_bytes())) {
            return Err(Status::unauthenticated("Invalid collector credentials"));
        }
        source(row, digest).map_err(|_| unavailable())
    }

    async fn grants(
        &self,
        source: &Source,
        requested: &RequestedAuthorities,
    ) -> std::result::Result<(Vec<RootGrant>, Vec<BoundGrant>), Status> {
        let project = Uuid::parse_str(&source.security.project_id).map_err(|_| unavailable())?;
        let roots: Vec<_> = requested.roots.iter().cloned().collect();
        let independent: Vec<_> = requested.independent.iter().cloned().collect();
        let rows = self
            .query(
                GRANTS,
                &[
                    &source.credential_id,
                    &project,
                    &source.digest,
                    &roots,
                    &independent,
                ],
            )
            .await?;
        if rows.len() > roots.len() + independent.len() {
            return Err(unavailable());
        }
        let mut root_grants = Vec::new();
        let mut bound_grants = Vec::new();
        for row in rows {
            let reference = ResourceRef {
                id: row.try_get("resource_id").map_err(|_| unavailable())?,
                kind: row.try_get("resource_kind").map_err(|_| unavailable())?,
            };
            if row
                .try_get::<_, bool>("is_root")
                .map_err(|_| unavailable())?
            {
                let kinds: Vec<i32> = row
                    .try_get("allowed_local_kinds")
                    .map_err(|_| unavailable())?;
                let kinds = kinds
                    .into_iter()
                    .map(ResourceKind::try_from)
                    .collect::<std::result::Result<BTreeSet<_>, _>>()
                    .map_err(|_| unavailable())?;
                root_grants.push(RootGrant {
                    security: source.security.clone(),
                    root: reference,
                    adapter: row.try_get("adapter").map_err(|_| unavailable())?,
                    allowed_local_kinds: kinds,
                });
            } else {
                bound_grants.push(BoundGrant {
                    security: source.security.clone(),
                    resource: reference,
                });
            }
        }
        Ok((root_grants, bound_grants))
    }

    async fn ready(&self) -> bool {
        // Probe all required tables, including grants, with the deployed role.
        self.query("SELECT c.id FROM ingestion.collector_credential c LEFT JOIN ingestion.collector_root_grant r ON false LEFT JOIN ingestion.collector_resource_grant b ON false LIMIT 0", &[]).await.is_ok()
    }
}

fn source(row: &Row, digest: String) -> Result<Source> {
    let project: Uuid = row.try_get("project_id")?;
    let source_id: String = row.try_get("source_id")?;
    let root_id: String = row.try_get("root_id")?;
    let kind: i32 = row.try_get("root_kind")?;
    let age: i64 = row.try_get("maximum_submission_age")?;
    let skew: i64 = row.try_get("allowed_clock_skew")?;
    let (maximum_age_ns, skew_ns) = policy_nanos(age, skew).ok_or("Invalid credential policy")?;
    if !identifier(&source_id)
        || !identifier(&root_id)
        || root_id.starts_with("recount.local.")
        || ResourceKind::try_from(kind).is_err()
    {
        return Err("Invalid credential policy".into());
    }
    Ok(Source {
        credential_id: row.try_get("id")?,
        security: SecurityScope {
            project_id: project.to_string(),
            source_id,
        },
        root: ResourceRef { id: root_id, kind },
        maximum_age_ns,
        skew_ns,
        digest,
    })
}

pub fn policy_nanos(age: i64, skew: i64) -> Option<(u64, u64)> {
    let age = u64::try_from(age).ok()?.checked_mul(1_000_000_000)?;
    let skew = u64::try_from(skew).ok()?.checked_mul(1_000_000_000)?;
    (age > 0 && age.checked_add(skew).is_some()).then_some((age, skew))
}

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn credential_id(token: &str) -> Option<Uuid> {
    let bytes = token.as_bytes();
    if bytes.len() != 88
        || !bytes.starts_with(b"recount_")
        || bytes[44] != b'_'
        || !bytes[45..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(b))
    {
        return None;
    }
    let id = Uuid::parse_str(token.get(8..44)?).ok()?;
    (id.to_string() == token[8..44]).then_some(id)
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

pub fn one<'a>(
    metadata: &'a MetadataMap,
    key: &'static str,
) -> std::result::Result<Option<&'a str>, Status> {
    let mut values = metadata.get_all(key).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(Status::invalid_argument("Repeated request metadata"));
    }
    first
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
    fn token_shape_and_duration_overflow_fail_closed() {
        let token = "recount_019a4790-d1da-7000-8000-000000000001_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert!(credential_id(token).is_some());
        for value in [
            token.replace("recount_", "pfe_"),
            token.to_uppercase(),
            format!("{token}="),
            token.replace('A', "/"),
        ] {
            assert!(credential_id(&value).is_none());
        }
        assert_eq!(policy_nanos(7 * 86400, 0), Some((604800000000000, 0)));
        assert!(policy_nanos(0, 0).is_none());
        assert!(policy_nanos(1, -1).is_none());
        assert!(policy_nanos(18446744073, 1).is_none());
        assert!(policy_nanos(i64::MAX, 0).is_none());
    }
}
