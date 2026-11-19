use crate::{Result, clickhouse::ClickHouse, kafka, postgres, services};
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub fn setting(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| format!("missing explicit allocation setting: {name}").into())
}

/// Creates or replaces a file readable only by its owner.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    file.write_all(bytes)?;
    Ok(())
}

pub fn unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or_default()
}

#[derive(Args, Clone, Serialize, Deserialize)]
pub struct PrepareArgs {
    /// Tenants; nodes are assigned to them round-robin.
    #[arg(long, default_value_t = 2)]
    pub projects: usize,
    /// Standard-profile nodes whose single resource is their enrolled root.
    #[arg(long, default_value_t = 8)]
    pub direct_nodes: usize,
    /// Linux-profile nodes sending one host resource plus process resources per batch.
    #[arg(long, default_value_t = 4)]
    pub linux_nodes: usize,
    #[arg(long, default_value_t = 3)]
    pub raw_partitions: u32,
    #[arg(long, default_value_t = 3)]
    pub normalized_partitions: u32,
    /// Per-partition byte retention of the owned raw and normalized topics.
    #[arg(long, default_value_t = 134_217_728)]
    pub retention_bytes: u64,
    /// The ingestion API's process-wide admission limit; 1 is the shipped default.
    #[arg(long, default_value_t = 1)]
    pub ingestion_max_in_flight: u32,
    /// Normalizer workers; 2 is the shipped default.
    #[arg(long, default_value_t = 2)]
    pub normalizer_max_active: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Direct,
    Linux,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub project: usize,
    pub root: String,
    pub kind: NodeKind,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Allocation {
    pub created_unix_nano: u64,
    pub source_revision: String,
    pub namespace: String,
    pub broker: String,
    pub internal_broker: String,
    pub raw_topic: String,
    pub normalized_topic: String,
    pub late_topic: String,
    pub live_topic: String,
    pub participant_topic: String,
    pub normalizer_group: String,
    pub clickhouse_group: String,
    pub clickhouse_late_group: String,
    pub participant_group: String,
    pub output_rows: u32,
    pub database: String,
    pub reader_user: String,
    pub reader_password: String,
    pub pg_database: String,
    pub pg_role: String,
    pub pg_password: String,
    pub organization: String,
    pub signing_seed: String,
    pub ingestion_addr: String,
    pub settings: PrepareArgs,
    pub projects: Vec<String>,
    pub nodes: Vec<Node>,
}

/// Secret-free view for evidence and console output.
#[derive(Serialize)]
pub struct PublicAllocation<'a> {
    pub created_unix_nano: u64,
    pub source_revision: &'a str,
    pub namespace: &'a str,
    pub raw_topic: &'a str,
    pub normalized_topic: &'a str,
    pub late_topic: &'a str,
    pub normalizer_group: &'a str,
    pub clickhouse_group: &'a str,
    pub output_rows: u32,
    pub database: &'a str,
    pub pg_database: &'a str,
    pub settings: &'a PrepareArgs,
    pub projects: &'a [String],
    pub nodes: &'a [Node],
}

impl Allocation {
    pub fn load(run: &Path) -> Result<Self> {
        Ok(serde_json::from_slice(&std::fs::read(
            run.join("allocation.json"),
        )?)?)
    }

    pub fn public(&self) -> PublicAllocation<'_> {
        PublicAllocation {
            created_unix_nano: self.created_unix_nano,
            source_revision: &self.source_revision,
            namespace: &self.namespace,
            raw_topic: &self.raw_topic,
            normalized_topic: &self.normalized_topic,
            late_topic: &self.late_topic,
            normalizer_group: &self.normalizer_group,
            clickhouse_group: &self.clickhouse_group,
            output_rows: self.output_rows,
            database: &self.database,
            pg_database: &self.pg_database,
            settings: &self.settings,
            projects: &self.projects,
            nodes: &self.nodes,
        }
    }

    pub fn signing_key(&self) -> ed25519_dalek::SigningKey {
        let mut seed = [0; 32];
        for (index, byte) in seed.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&self.signing_seed[index * 2..index * 2 + 2], 16)
                .expect("hex signing seed");
        }
        ed25519_dalek::SigningKey::from_bytes(&seed)
    }

    pub fn clickhouse(&self) -> Result<ClickHouse> {
        ClickHouse::from_env()
    }

    /// Refuses names this tool could not have created, before anything is dropped,
    /// detached or deleted.
    pub fn validate_owned(&self) -> Result<()> {
        let suffix = |value: &str, prefix: &str| {
            value.strip_prefix(prefix).is_some_and(|rest| {
                !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit() || b == b'_')
            })
        };
        let prefix = format!("{}.load.", self.namespace);
        let owned = self.namespace.starts_with("recount.")
            && suffix(&self.database, "recount_load_")
            && suffix(&self.reader_user, "recount_load_reader_")
            && suffix(&self.pg_database, "recount_load_")
            && suffix(&self.pg_role, "recount_load_ingestion_")
            && self
                .topics()
                .iter()
                .chain(self.groups().iter())
                .all(|name| name.starts_with(&prefix));
        if owned {
            Ok(())
        } else {
            Err("allocation names are outside the load tool's owned prefixes".into())
        }
    }

    pub fn groups(&self) -> [&str; 4] {
        [
            &self.normalizer_group,
            &self.clickhouse_group,
            &self.clickhouse_late_group,
            &self.participant_group,
        ]
    }

    pub fn topics(&self) -> [&str; 5] {
        [
            &self.raw_topic,
            &self.normalized_topic,
            &self.late_topic,
            &self.live_topic,
            &self.participant_topic,
        ]
    }
}

fn revision() -> String {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output();
    let head = output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|| "unknown".into());
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .is_ok_and(|o| !o.stdout.is_empty());
    if dirty { format!("{head}+dirty") } else { head }
}

fn secret(label: &str) -> String {
    let digest = Sha256::digest(format!("{label}{}{}", unix_nanos(), Uuid::now_v7()));
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub async fn prepare(run: &Path, args: PrepareArgs) -> Result<Allocation> {
    if setting("RECOUNT_STORAGE_TEST_ALLOW_CREATE")? != "1" {
        return Err("RECOUNT_STORAGE_TEST_ALLOW_CREATE=1 is required".into());
    }
    if run.join("allocation.json").exists() {
        return Err("run directory already holds an allocation".into());
    }
    if args.projects == 0 || args.direct_nodes + args.linux_nodes == 0 {
        return Err("at least one project and one node are required".into());
    }
    let namespace = setting("RECOUNT_STORAGE_TEST_NAMESPACE")?;
    if !namespace.starts_with("recount.")
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("namespace must start with recount. and use Kafka name characters".into());
    }
    std::fs::create_dir_all(run.join("logs"))?;
    let created = unix_nanos();
    let unique = format!("{}_{}", created / 1_000_000_000, std::process::id());
    let prefix = format!("{namespace}.load.{unique}");
    let organization = format!("load-org-{unique}");
    let projects: Vec<String> = (0..args.projects)
        .map(|_| Uuid::now_v7().to_string())
        .collect();
    let nodes = (0..args.direct_nodes + args.linux_nodes)
        .map(|index| Node {
            id: Uuid::now_v7().to_string(),
            project: index % args.projects,
            root: format!("load-root-{index}"),
            kind: if index < args.direct_nodes {
                NodeKind::Direct
            } else {
                NodeKind::Linux
            },
        })
        .collect();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let ingestion_addr = listener.local_addr()?.to_string();
    drop(listener);
    let allocation = Allocation {
        created_unix_nano: created,
        source_revision: revision(),
        broker: setting("RECOUNT_STORAGE_TEST_BROKER")?,
        internal_broker: setting("RECOUNT_STORAGE_TEST_INTERNAL_BROKER")?,
        raw_topic: format!("{prefix}.raw"),
        normalized_topic: format!("{prefix}.normalized"),
        late_topic: format!("{prefix}.late"),
        live_topic: format!("{prefix}.live"),
        participant_topic: format!("{prefix}.participants"),
        normalizer_group: format!("{prefix}.normalizer"),
        clickhouse_group: format!("{prefix}.clickhouse"),
        clickhouse_late_group: format!("{prefix}.clickhouse-late"),
        participant_group: format!("{prefix}.clickhouse-participants"),
        output_rows: setting("RECOUNT_STORAGE_TEST_OUTPUT_ROWS")?.parse()?,
        database: format!("recount_load_{unique}"),
        reader_user: format!("recount_load_reader_{unique}"),
        reader_password: secret("reader"),
        pg_database: format!("recount_load_{unique}"),
        pg_role: format!("recount_load_ingestion_{unique}"),
        pg_password: secret("role"),
        organization,
        signing_seed: secret("signing"),
        ingestion_addr,
        namespace,
        settings: args,
        projects,
        nodes,
    };
    // Persist first so a partial preparation can still be cleaned up.
    write_private(
        &run.join("allocation.json"),
        &serde_json::to_vec_pretty(&allocation)?,
    )?;
    std::fs::write(
        run.join("allocation.public.json"),
        serde_json::to_vec_pretty(&allocation.public())?,
    )?;
    kafka::create_topics(&allocation).await?;
    allocation.clickhouse()?.create(&allocation).await?;
    postgres::create(&allocation).await?;
    Ok(allocation)
}

pub async fn cleanup(allocation: &Allocation, run: &Path) -> Result<()> {
    allocation.validate_owned()?;
    let mut failures = Vec::new();
    for service in [
        services::Service::IngestionApi,
        services::Service::Normalizer,
    ] {
        if let Err(error) = services::stop(run, service, false).await {
            failures.push(format!("{service:?}: {error}"));
        }
    }
    if let Err(error) = allocation.clickhouse()?.drop(allocation).await {
        failures.push(format!("ClickHouse: {error}"));
    }
    if let Err(error) = kafka::delete_topics(allocation).await {
        failures.push(format!("Kafka: {error}"));
    }
    if let Err(error) = kafka::delete_groups(allocation).await {
        failures.push(format!("Kafka groups: {error}"));
    }
    if let Err(error) = postgres::drop(allocation).await {
        failures.push(format!("PostgreSQL: {error}"));
    }
    if failures.is_empty() {
        eprintln!("cleanup_complete database={}", allocation.database);
        Ok(())
    } else {
        Err(failures.join("; ").into())
    }
}

pub fn phase_dir(run: &Path, label: &str) -> Result<PathBuf> {
    if label.is_empty()
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("phase labels use letters, digits, '-' and '_'".into());
    }
    let directory = run.join("phases").join(label);
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}
