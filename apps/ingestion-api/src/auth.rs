use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use ed25519_dalek::{Signature, VerifyingKey};
use recount_telemetry_schema::wire::{ResourceKind, ResourceRef, SecurityScope};
use recount_telemetry_validation::{
    authority::identifier,
    policy::{BoundGrant, RequestedAuthorities, RootGrant},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;
use tonic::{Status, metadata::MetadataMap};
use uuid::Uuid;

use crate::Result;

const AUDIENCE: &str = "recount-ingestion";
const ISSUER: &str = "recount";
/// Tolerance for issue times slightly ahead of this service's clock.
const ISSUED_AT_SKEW_SECONDS: u64 = 60;
const REVOCATION_POLL: Duration = Duration::from_secs(30);
/// Readiness fails once the revocation list is this old.
const REVOCATION_STALE: Duration = Duration::from_secs(300);
/// Covers the one-hour token lifetime with margin; older revocations have no live tokens.
const REVOKED: &str = "SELECT id FROM ingestion.collector_node
    WHERE revoked_at IS NOT NULL AND revoked_at > statement_timestamp() - interval '2 hours'";

#[derive(Clone, Debug)]
pub struct Source {
    pub node_id: Uuid,
    pub security: SecurityScope,
    pub root: ResourceRef,
    pub adapter: String,
    pub local_kinds: BTreeSet<ResourceKind>,
    pub maximum_age_ns: u64,
    pub skew_ns: u64,
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

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claims {
    sub: String,
    project: String,
    root: String,
    root_kind: i32,
    adapter: String,
    local_kinds: Vec<i32>,
    max_age: i64,
    skew: i64,
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
}

#[derive(Default)]
struct Revocations {
    nodes: HashSet<Uuid>,
    loaded_at: Option<Instant>,
}

/// Verifies node access tokens signed by the web application. Signatures and claims are
/// checked in memory; the database is read only to refresh the revocation list.
pub struct NodeTokens {
    keys: HashMap<String, VerifyingKey>,
    pool: Pool,
    revocations: RwLock<Revocations>,
}

fn unavailable() -> Status {
    Status::unavailable("Collector authority is unavailable")
}

fn rejected() -> Status {
    Status::unauthenticated("Invalid collector credentials")
}

/// The key ID the web application publishes: the first 16 characters of the base64url
/// SHA-256 of the base64url public key.
pub fn key_id(public_key: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_key.as_bytes()))[..16].to_string()
}

pub fn parse_public_keys(values: &[String]) -> Result<HashMap<String, VerifyingKey>> {
    let mut keys = HashMap::new();
    for value in values {
        let value = value.trim();
        let bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("Collector public keys must be base64url Ed25519 keys")?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| "Collector public keys must be base64url Ed25519 keys")?;
        keys.insert(key_id(value), key);
    }
    if keys.is_empty() {
        return Err("At least one collector public key is required".into());
    }
    Ok(keys)
}

impl NodeTokens {
    pub fn new(database_url: &str, public_keys: &[String]) -> Result<Self> {
        let mut config: tokio_postgres::Config = database_url
            .parse()
            .map_err(|_| "Invalid collector authority database configuration")?;
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
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(Duration::from_millis(500)))
            .create_timeout(Some(Duration::from_secs(1)))
            .recycle_timeout(Some(Duration::from_millis(500)))
            .build()
            .map_err(|_| "Invalid collector authority pool configuration")?;
        Ok(Self {
            keys: parse_public_keys(public_keys)?,
            pool,
            revocations: RwLock::default(),
        })
    }

    /// Loads revoked node IDs once. A failure keeps the previous list.
    pub async fn refresh_revocations(&self) -> bool {
        let rows = async {
            let client = tokio::time::timeout(Duration::from_secs(1), self.pool.get())
                .await
                .ok()?
                .ok()?;
            tokio::time::timeout(Duration::from_secs(2), client.query(REVOKED, &[]))
                .await
                .ok()?
                .ok()
        }
        .await;
        let Some(rows) = rows else { return false };
        let nodes = rows
            .iter()
            .filter_map(|row| row.try_get::<_, Uuid>("id").ok())
            .collect();
        let Ok(mut revocations) = self.revocations.write() else {
            return false;
        };
        *revocations = Revocations {
            nodes,
            loaded_at: Some(Instant::now()),
        };
        true
    }

    /// Keeps the revocation list current for the life of the process.
    pub fn spawn_revocation_poller(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let tokens = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(REVOCATION_POLL);
            loop {
                interval.tick().await;
                if !tokens.refresh_revocations().await {
                    tracing::warn!("collector revocation list refresh failed");
                }
            }
        })
    }

    fn verify(&self, token: &str, now: u64) -> std::result::Result<Source, Status> {
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(rejected());
        };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| rejected());
        let header: Header = serde_json::from_slice(&decode(header)?).map_err(|_| rejected())?;
        if header.alg != "EdDSA" {
            return Err(rejected());
        }
        let key = self.keys.get(&header.kid).ok_or_else(rejected)?;
        let signature: [u8; 64] = decode(signature)?.try_into().map_err(|_| rejected())?;
        let signed = &token[..token.rfind('.').ok_or_else(rejected)?];
        key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&signature))
            .map_err(|_| rejected())?;
        let claims: Claims = serde_json::from_slice(&decode(payload)?).map_err(|_| rejected())?;
        if claims.iss != ISSUER
            || claims.aud != AUDIENCE
            || claims.exp <= now
            || claims.iat > now + ISSUED_AT_SKEW_SECONDS
        {
            return Err(rejected());
        }
        source(claims).ok_or_else(rejected)
    }
}

fn source(claims: Claims) -> Option<Source> {
    let node_id = Uuid::parse_str(&claims.sub).ok()?;
    let project = Uuid::parse_str(&claims.project).ok()?;
    let (maximum_age_ns, skew_ns) = policy_nanos(claims.max_age, claims.skew)?;
    let local_kinds = claims
        .local_kinds
        .into_iter()
        .map(ResourceKind::try_from)
        .collect::<std::result::Result<BTreeSet<_>, _>>()
        .ok()?;
    if !identifier(&claims.root)
        || claims.root.starts_with("recount.local.")
        || ResourceKind::try_from(claims.root_kind).is_err()
        || !matches!(claims.adapter.as_str(), "standard" | "linux")
    {
        return None;
    }
    Some(Source {
        node_id,
        security: SecurityScope {
            project_id: project.to_string(),
            source_id: node_id.to_string(),
        },
        root: ResourceRef {
            id: claims.root,
            kind: claims.root_kind,
        },
        adapter: claims.adapter,
        local_kinds,
        maximum_age_ns,
        skew_ns,
    })
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

#[tonic::async_trait]
impl Authority for NodeTokens {
    async fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status> {
        let token = one(metadata, "authorization")?
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(|| Status::unauthenticated("A collector bearer token is required"))?;
        let source = self.verify(token, unix_now())?;
        let revocations = self.revocations.read().map_err(|_| unavailable())?;
        // Fail closed until the first revocation list has loaded.
        if revocations.loaded_at.is_none() {
            return Err(unavailable());
        }
        if revocations.nodes.contains(&source.node_id) {
            return Err(rejected());
        }
        Ok(source)
    }

    async fn grants(
        &self,
        source: &Source,
        requested: &RequestedAuthorities,
    ) -> std::result::Result<(Vec<RootGrant>, Vec<BoundGrant>), Status> {
        // A node holds exactly one root, its machine; independent resources are not granted.
        let roots = requested
            .roots
            .contains(&source.root.id)
            .then(|| RootGrant {
                security: source.security.clone(),
                root: source.root.clone(),
                adapter: source.adapter.clone(),
                allowed_local_kinds: source.local_kinds.clone(),
            })
            .into_iter()
            .collect();
        Ok((roots, Vec::new()))
    }

    async fn ready(&self) -> bool {
        self.revocations.read().is_ok_and(|revocations| {
            revocations
                .loaded_at
                .is_some_and(|loaded| loaded.elapsed() < REVOCATION_STALE)
        })
    }
}

pub fn policy_nanos(age: i64, skew: i64) -> Option<(u64, u64)> {
    let age = u64::try_from(age).ok()?.checked_mul(1_000_000_000)?;
    let skew = u64::try_from(skew).ok()?.checked_mul(1_000_000_000)?;
    (age > 0 && age.checked_add(skew).is_some()).then_some((age, skew))
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
    use ed25519_dalek::{Signer, SigningKey};

    fn public(signing: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes())
    }

    fn tokens(signing: &SigningKey) -> NodeTokens {
        NodeTokens::new(
            "postgres://recount@127.0.0.1:1/recount?sslmode=disable",
            &[public(signing)],
        )
        .unwrap()
    }

    fn token(signing: &SigningKey, claims: serde_json::Value, kid: Option<&str>) -> String {
        let kid = kid.map_or_else(|| key_id(&public(signing)), str::to_string);
        let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": kid });
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let signature = signing.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn claims(now: u64) -> serde_json::Value {
        serde_json::json!({
            "sub": "019a4790-d1da-7000-8000-000000000001",
            "org": "org",
            "project": "019a4790-d1da-7000-8000-000000000002",
            "root": "machine-a",
            "rootKind": 1,
            "adapter": "linux",
            "localKinds": [4, 6],
            "maxAge": 3600,
            "skew": 60,
            "iss": "recount",
            "aud": "recount-ingestion",
            "iat": now,
            "exp": now + 3600,
        })
    }

    #[tokio::test]
    async fn signed_claims_become_the_trusted_source() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let tokens = tokens(&signing);
        let now = 1_800_000_000;
        let source = tokens
            .verify(&token(&signing, claims(now), None), now)
            .unwrap();
        assert_eq!(
            source.security.source_id,
            "019a4790-d1da-7000-8000-000000000001"
        );
        assert_eq!(
            source.root,
            ResourceRef {
                id: "machine-a".into(),
                kind: 1
            }
        );
        assert_eq!(
            source.local_kinds,
            BTreeSet::from([ResourceKind::Process, ResourceKind::Container])
        );
        assert_eq!(source.maximum_age_ns, 3_600_000_000_000);
        let requested = RequestedAuthorities {
            roots: BTreeSet::from(["machine-a".to_string()]),
            independent: BTreeSet::from(["sensor".to_string()]),
        };
        let (roots, bound) = tokens.grants(&source, &requested).await.unwrap();
        assert_eq!(roots.len(), 1);
        assert!(bound.is_empty());
    }

    #[test]
    fn forged_expired_and_malformed_tokens_are_rejected() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[9; 32]);
        let tokens = tokens(&signing);
        let now = 1_800_000_000;
        let valid = token(&signing, claims(now), None);
        let mut wrong_audience = claims(now);
        wrong_audience["aud"] = "elsewhere".into();
        let mut reserved_root = claims(now);
        reserved_root["root"] = "recount.local.x".into();
        let kid = key_id(&public(&signing));
        for candidate in [
            token(&other, claims(now), Some(&kid)),
            token(&signing, wrong_audience, None),
            token(&signing, reserved_root, None),
            token(&signing, claims(now), Some("unknown")),
            format!("{valid}x"),
            valid.replacen('.', "", 1),
        ] {
            assert!(tokens.verify(&candidate, now).is_err());
        }
        assert!(tokens.verify(&valid, now + 3600).is_err());
        assert!(tokens.verify(&valid, now - 120).is_err());
    }

    #[tokio::test]
    async fn submissions_fail_closed_until_revocations_load() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let tokens = tokens(&signing);
        let mut metadata = MetadataMap::new();
        let value = format!("Bearer {}", token(&signing, claims(unix_now()), None));
        metadata.insert("authorization", value.parse().unwrap());
        assert_eq!(
            tokens.authenticate(&metadata).await.unwrap_err().code(),
            tonic::Code::Unavailable
        );
        assert!(!tokens.ready().await);
        *tokens.revocations.write().unwrap() = Revocations {
            nodes: HashSet::from(
                [Uuid::parse_str("019a4790-d1da-7000-8000-000000000001").unwrap()],
            ),
            loaded_at: Some(Instant::now()),
        };
        assert!(tokens.ready().await);
        assert_eq!(
            tokens.authenticate(&metadata).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
    }

    #[test]
    fn duration_overflow_fails_closed() {
        assert_eq!(policy_nanos(7 * 86400, 0), Some((604800000000000, 0)));
        assert!(policy_nanos(0, 0).is_none());
        assert!(policy_nanos(1, -1).is_none());
        assert!(policy_nanos(18446744073, 1).is_none());
        assert!(policy_nanos(i64::MAX, 0).is_none());
    }

    #[test]
    fn key_ids_match_the_web_application() {
        // Values printed by apps/web/src/collectors/tokens.server.ts for a seed of 32 × 0x07.
        let public = public(&SigningKey::from_bytes(&[7; 32]));
        assert_eq!(public, "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw");
        assert_eq!(key_id(&public), "gKy7G6nCrCzghDSU");
    }
}
