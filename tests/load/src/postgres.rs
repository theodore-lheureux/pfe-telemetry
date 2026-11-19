use crate::{
    Result,
    allocation::{Allocation, setting},
};
use std::path::PathBuf;
use tokio_postgres::{Client, Config, NoTls};

async fn connect(config: &Config) -> Result<Client> {
    let (client, connection) = config.connect(NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

fn admin_url() -> Result<String> {
    setting("TEST_DATABASE_URL")
}

fn database_url(base: &str, name: &str) -> Result<String> {
    let (base, query) = base.split_once('?').unwrap_or((base, ""));
    let (prefix, _) = base.rsplit_once('/').ok_or("invalid administrator URL")?;
    Ok(format!("{prefix}/{name}?{query}"))
}

/// The URL the ingestion API receives: the scoped read-only role on the disposable database,
/// with the administrator URL's parameters. The API requires TLS unless `sslmode=disable`,
/// so that mode is the default only when the administrator URL names none.
pub fn ingestion_url(allocation: &Allocation) -> Result<String> {
    let base = admin_url()?;
    let (base, query) = base.split_once('?').unwrap_or((&base, ""));
    let (prefix, _) = base.rsplit_once('/').ok_or("invalid administrator URL")?;
    let (_, host) = prefix
        .rsplit_once('@')
        .ok_or("administrator URL must include user info")?;
    let mut parameters: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    if !parameters.iter().any(|p| p.starts_with("sslmode=")) {
        parameters.push("sslmode=disable");
    }
    Ok(format!(
        "postgresql://{}:{}@{host}/{}?{}",
        allocation.pg_role,
        allocation.pg_password,
        allocation.pg_database,
        parameters.join("&")
    ))
}

/// A migrated application database with one organization, the allocation's projects, an
/// enrollment key and a node row per synthetic principal, plus a scoped revocation reader.
pub async fn create(allocation: &Allocation) -> Result<()> {
    let base = admin_url()?;
    let admin = connect(&base.parse()?).await?;
    admin
        .batch_execute(&format!("CREATE DATABASE {}", allocation.pg_database))
        .await?;
    let url = database_url(&base, &allocation.pg_database)?;
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web");
    let status = tokio::process::Command::new("bun")
        .args(["--no-env-file", "scripts/migrate.ts"])
        .current_dir(web)
        .env("DATABASE_URL", &url)
        .stdout(std::process::Stdio::null())
        .status()
        .await?;
    if !status.success() {
        return Err("current Drizzle migrations failed".into());
    }
    let client = connect(&url.parse()?).await?;
    let organization = &allocation.organization;
    let mut sql = format!(
        "INSERT INTO app.organization (id,name,slug,created_at) VALUES ('{organization}','Load','{organization}',now());"
    );
    for (index, project) in allocation.projects.iter().enumerate() {
        sql.push_str(&format!(
            "INSERT INTO app.project (id,organization_id,name) VALUES ('{project}','{organization}','Load {index}');
             INSERT INTO ingestion.enrollment_key (id,organization_id,project_id,name,key_sha256)
               VALUES ('{project}','{organization}','{project}','Load',encode(sha256('{project}'::bytea),'hex'));"
        ));
    }
    for node in &allocation.nodes {
        let project = &allocation.projects[node.project];
        sql.push_str(&format!(
            "INSERT INTO ingestion.collector_node (id,organization_id,project_id,enrollment_key_id,machine_id,hostname,public_key)
               VALUES ('{}','{organization}','{project}','{project}','{}','{}',repeat('A',43));",
            node.id, node.root, node.root
        ));
    }
    let role = &allocation.pg_role;
    let database = &allocation.pg_database;
    sql.push_str(&format!(
        "CREATE ROLE {role} LOGIN PASSWORD '{}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 4;
         GRANT CONNECT ON DATABASE {database} TO {role};
         GRANT USAGE ON SCHEMA ingestion TO {role};
         GRANT SELECT (id, project_id, organization_id, revoked_at) ON ingestion.collector_node TO {role};",
        allocation.pg_password
    ));
    client.batch_execute(&sql).await?;
    Ok(())
}

pub async fn drop(allocation: &Allocation) -> Result<()> {
    let admin = connect(&admin_url()?.parse()?).await?;
    // Separate statements: DROP DATABASE cannot run inside a multi-statement transaction.
    admin
        .batch_execute(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            allocation.pg_database
        ))
        .await
        .map_err(|error| format!("{error:?}"))?;
    admin
        .batch_execute(&format!("DROP ROLE IF EXISTS {}", allocation.pg_role))
        .await
        .map_err(|error| format!("{error:?}"))?;
    Ok(())
}

pub async fn revoke(allocation: &Allocation, node: usize) -> Result<()> {
    let node = allocation.nodes.get(node).ok_or("unknown node index")?;
    let url = database_url(&admin_url()?, &allocation.pg_database)?;
    let client = connect(&url.parse()?).await?;
    client
        .execute(
            "UPDATE ingestion.collector_node SET revoked_at = now() WHERE id = $1::text::uuid",
            &[&node.id],
        )
        .await?;
    eprintln!(
        "revoked_node={} at_unix_nano={}",
        node.id,
        crate::allocation::unix_nanos()
    );
    Ok(())
}

/// Authority database activity. Every credential or revocation lookup scans the node table,
/// so its scan counter counts lookups; transactions also include autovacuum.
pub async fn activity(allocation: &Allocation) -> Result<serde_json::Value> {
    let url = database_url(&admin_url()?, &allocation.pg_database)?;
    let client = connect(&url.parse()?).await?;
    let row = client
        .query_one(
            "SELECT d.xact_commit, d.numbackends,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND usename = $2),
               t.seq_scan + coalesce(t.idx_scan, 0), t.seq_tup_read
             FROM pg_stat_database d, pg_stat_user_tables t
             WHERE d.datname = $1 AND t.schemaname = 'ingestion' AND t.relname = 'collector_node'",
            &[&allocation.pg_database, &allocation.pg_role],
        )
        .await?;
    Ok(serde_json::json!({
        "xact_commit": row.get::<_, i64>(0),
        "backends": row.get::<_, i32>(1),
        "ingestion_sessions": row.get::<_, i64>(2),
        "node_table_scans": row.get::<_, i64>(3),
        "node_rows_read": row.get::<_, i64>(4),
    }))
}
