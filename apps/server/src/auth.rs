use std::time::Duration;

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use subtle::ConstantTimeEq;
use tokio_postgres::{Row, config::SslMode};
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::{Status, metadata::MetadataMap};
use uuid::Uuid;

use crate::Result;

/// Authoritative project, source and host policy for one submission.
#[derive(Clone)]
pub struct Source {
    pub project_id: String,
    pub source_id: String,
    pub hosts: Vec<String>,
    pub require_host_id: bool,
    pub maximum_submission_age: u64,
    pub allowed_clock_skew: u64,
}

pub struct Credentials {
    pool: Pool,
}

const LOOKUP: &str = "SELECT project_id, source_id, token_sha256, hosts, require_host_id,
    maximum_submission_age, allowed_clock_skew FROM ingestion.collector_credential
    WHERE id = $1 AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > statement_timestamp())";

fn unavailable() -> Status {
    Status::unavailable("Credential authority is unavailable")
}

impl Credentials {
    pub fn new(database_url: &str) -> Result<Self> {
        let mut config: tokio_postgres::Config = database_url
            .parse()
            .map_err(|_| "Invalid credential database configuration")?;
        // Plaintext must be an explicit local-deployment choice, never a TLS fallback.
        if config.get_ssl_mode() != SslMode::Disable {
            config.ssl_mode(SslMode::Require);
        }
        config
            .application_name("pfe-ingestion")
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
            .map_err(|_| "Invalid credential database pool configuration")?;
        Ok(Self { pool })
    }

    async fn lookup(&self, id: Uuid) -> std::result::Result<Option<Row>, Status> {
        // The outer deadline also bounds wait + connection creation/recycling together.
        let client = tokio::time::timeout(Duration::from_secs(1), self.pool.get())
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        match tokio::time::timeout(Duration::from_secs(1), client.query_opt(LOOKUP, &[&id])).await {
            Ok(result) => result.map_err(|_| unavailable()),
            Err(_) => {
                // A cancelled query must not keep running on a returned pooled connection.
                drop(deadpool_postgres::Object::take(client));
                Err(unavailable())
            }
        }
    }

    pub async fn ready(&self) -> bool {
        self.lookup(Uuid::nil()).await.is_ok()
    }

    pub async fn authenticate(
        &self,
        metadata: &MetadataMap,
    ) -> std::result::Result<Source, Status> {
        let token = one(metadata, "authorization")?
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| Status::unauthenticated("A collector bearer token is required"))?;
        let id = credential_id(token)
            .ok_or_else(|| Status::unauthenticated("Invalid collector credentials"))?;
        let row = self
            .lookup(id)
            .await?
            .ok_or_else(|| Status::unauthenticated("Invalid collector credentials"))?;
        let stored: String = row.try_get("token_sha256").map_err(|_| unavailable())?;
        if stored.len() != 64
            || !stored
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        {
            return Err(unavailable());
        }
        let hash = crate::envelope::digest(token.as_bytes());
        if !bool::from(stored.as_bytes().ct_eq(hash.as_bytes())) {
            return Err(Status::unauthenticated("Invalid collector credentials"));
        }
        source(&row).map_err(|_| unavailable())
    }
}

fn source(row: &Row) -> Result<Source> {
    let project_id: Uuid = row.try_get("project_id")?;
    let source_id: String = row.try_get("source_id")?;
    let hosts: Vec<String> = row.try_get("hosts")?;
    let require_host_id: bool = row.try_get("require_host_id")?;
    let maximum_submission_age: i32 = row.try_get("maximum_submission_age")?;
    let allowed_clock_skew: i32 = row.try_get("allowed_clock_skew")?;
    if !identifier(&source_id)
        || hosts.len() > 256
        || hosts.iter().any(|v| !identifier(v))
        || (require_host_id && hosts.is_empty())
        || !(1..=86_400).contains(&maximum_submission_age)
        || !(1..=3600).contains(&allowed_clock_skew)
    {
        return Err("Invalid credential policy".into());
    }
    Ok(Source {
        project_id: project_id.to_string(),
        source_id,
        hosts,
        require_host_id,
        maximum_submission_age: maximum_submission_age as u64,
        allowed_clock_skew: allowed_clock_skew as u64,
    })
}

fn credential_id(token: &str) -> Option<Uuid> {
    let bytes = token.as_bytes();
    if bytes.len() != 84
        || !bytes.starts_with(b"pfe_")
        || bytes[40] != b'_'
        || !bytes[41..]
            .iter()
            .all(|v| v.is_ascii_alphanumeric() || *v == b'_' || *v == b'-')
    {
        return None;
    }
    let id = Uuid::parse_str(token.get(4..40)?).ok()?;
    (id.to_string() == token[4..40]).then_some(id)
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
    fn tokens_require_the_canonical_public_id_and_exact_secret_shape() {
        let token =
            "pfe_019a4790-d1da-7000-8000-000000000001_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(credential_id(token).unwrap().to_string(), &token[4..40]);
        for invalid in [
            token.to_uppercase(),
            token.replace("pfe_", ""),
            token.replace("d1da", "D1DA"),
            format!("{token}="),
            token[..83].to_owned(),
            token.replace('A', "/"),
            "é".repeat(42),
        ] {
            assert!(credential_id(&invalid).is_none());
        }
    }
}
