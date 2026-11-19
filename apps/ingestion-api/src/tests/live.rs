use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use recount_telemetry_schema::wire::{
    ParticipantFact, execution_participants_client::ExecutionParticipantsClient,
};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};

struct Database {
    client: tokio_postgres::Client,
    admin: tokio_postgres::Client,
    name: String,
    role: String,
    reader_url: String,
    node: Uuid,
    other_node: Uuid,
    project: Uuid,
}

async fn connect(config: &tokio_postgres::Config) -> tokio_postgres::Client {
    let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

impl Database {
    async fn new() -> Self {
        let base = std::env::var("TEST_DATABASE_URL")
            .expect("A disposable PostgreSQL administrator URL is required");
        let mut config: tokio_postgres::Config = base.parse().unwrap();
        let admin = connect(&config).await;
        let suffix = Uuid::now_v7().simple().to_string();
        let name = format!("recount_ingestion_test_{suffix}");
        let role = format!("recount_ingestion_reader_{suffix}");
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await
            .unwrap();
        config.dbname(&name);
        let (base, query) = base.split_once('?').unwrap_or((&base, ""));
        let (prefix, _) = base.rsplit_once('/').unwrap();
        let url = format!("{prefix}/{name}?{query}");
        let web = std::env::var_os("RECOUNT_TEST_WEB_DIRECTORY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web"));
        let status = std::process::Command::new("bun")
            .args(["--no-env-file", "scripts/migrate.ts"])
            .current_dir(web)
            .env("DATABASE_URL", &url)
            .status()
            .expect("Bun and current web migrations are required");
        assert!(status.success(), "Current Drizzle migrations failed");
        let client = connect(&config).await;
        let key = Uuid::now_v7();
        let node = Uuid::now_v7();
        let other_node = Uuid::now_v7();
        let project = Uuid::now_v7();
        client.batch_execute(&format!(
            "INSERT INTO app.organization (id,name,slug,created_at) VALUES ('test-org','Test','test',now());
             INSERT INTO app.project (id,organization_id,name) VALUES ('{project}','test-org','Test');
             INSERT INTO ingestion.enrollment_key (id,organization_id,project_id,name,key_sha256) VALUES ('{key}','test-org','{project}','Test',repeat('a',64));
             INSERT INTO ingestion.collector_node (id,organization_id,project_id,enrollment_key_id,machine_id,hostname,public_key) VALUES
               ('{node}','test-org','{project}','{key}','node','node',repeat('A',43)),
               ('{other_node}','test-org','{project}','{key}','other','other',repeat('A',43));"
        )).await.unwrap();
        let mut psql = Command::new("psql")
            .args(["-X", &url])
            .env("RECOUNT_INGESTION_PASSWORD", "test-only")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        psql.stdin
            .take()
            .unwrap()
            .write_all(
                include_str!("../../../../infra/local/ingestion-role.sql")
                    .replace("recount_ingestion", &role)
                    .as_bytes(),
            )
            .unwrap();
        assert!(psql.wait().unwrap().success());
        let (_, host) = prefix
            .rsplit_once('@')
            .expect("Test URL must include explicit user info");
        let reader_url = format!("postgresql://{role}:test-only@{host}/{name}?sslmode=disable");
        Self {
            client,
            admin,
            name,
            role,
            reader_url,
            node,
            other_node,
            project,
        }
    }
    async fn close(self) {
        drop(self.client);
        self.admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .await
            .unwrap();
        self.admin
            .batch_execute(&format!("DROP ROLE {}", self.role))
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires explicit isolated PostgreSQL, current web migrations, psql and Bun"]
async fn last_seen_flush_is_monotonic_and_restricted_to_active_nodes_and_one_column() {
    let db = Database::new().await;
    let old = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let new = old + Duration::from_secs(1);
    db.client.execute(
        "UPDATE ingestion.collector_node SET last_seen_at = $1, revoked_at = CASE WHEN id = $2 THEN now() END",
        &[&old, &db.other_node],
    ).await.unwrap();
    let role = connect(&db.reader_url.parse().unwrap()).await;
    assert_eq!(
        role.query_one("SHOW default_transaction_read_only", &[])
            .await
            .unwrap()
            .get::<_, String>(0),
        "on"
    );
    let public = URL_SAFE_NO_PAD.encode(signing().verifying_key().as_bytes());
    let tokens = auth::NodeTokens::new(&db.reader_url, &[public]).unwrap();
    auth::Authority::accepted_export(&tokens, db.node, new);
    auth::Authority::accepted_export(&tokens, db.other_node, new);
    tokens.flush_last_seen().await;
    auth::Authority::accepted_export(&tokens, db.node, old);
    tokens.flush_last_seen().await;
    for (id, expected) in [(db.node, new), (db.other_node, old)] {
        let row = db
            .client
            .query_one(
                "SELECT last_seen_at FROM ingestion.collector_node WHERE id = $1",
                &[&id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, SystemTime>(0), expected);
    }
    role.batch_execute("BEGIN READ WRITE").await.unwrap();
    let error = role
        .execute("UPDATE ingestion.collector_node SET revoked_at = NULL", &[])
        .await
        .unwrap_err();
    assert_eq!(
        error.code(),
        Some(&tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE)
    );
    role.batch_execute("ROLLBACK").await.unwrap();
    drop(role);
    drop(tokens);
    db.close().await;
}

fn authorized(
    token: &str,
    body: ExportMetricsServiceRequest,
) -> Request<ExportMetricsServiceRequest> {
    let mut req = Request::new(body);
    req.metadata_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    req
}
fn batch(token: &str, created: u64) -> Request<ExportMetricsServiceRequest> {
    let mut req = authorized(token, body());
    req.metadata_mut()
        .insert(metadata::BATCH_ID, "immutable-live".parse().unwrap());
    req.metadata_mut().insert(
        metadata::BATCH_CREATED,
        created.to_string().parse().unwrap(),
    );
    req
}

fn participant(token: &str, db: &Database) -> Request<ParticipantFact> {
    let mut fact = super::participants::cases::lifecycle();
    fact.project_id = db.project.to_string();
    fact.node_id = db.node.to_string();
    fact.first_seen_unix_nano = unix_nanos().unwrap() - 1000;
    fact.last_seen_unix_nano = fact.first_seen_unix_nano;
    let mut request = Request::new(fact);
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request
}

fn linux_process(token: &str, created: u64) -> Request<ExportMetricsServiceRequest> {
    let mut metrics = body();
    let metric = &mut metrics.resource_metrics[0].scope_metrics[0].metrics[0];
    metric.name = "recount.process.memory.rss".into();
    metric.unit = "By".into();
    metrics.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("host.id", "node"),
            string(
                "recount.host.boot_id",
                "01234567-89ab-cdef-0123-456789abcdef",
            ),
            string("recount.collection.epoch_id", "live-linux-epoch"),
            string("recount.collection.scope", "process"),
            string("recount.process.namespace_id", "host"),
            string("recount.process.start_time_ticks", "42"),
            KeyValue {
                key: "process.pid".into(),
                value: Some(AnyValue {
                    value: Some(any_value::Value::IntValue(42)),
                }),
                ..Default::default()
            },
        ],
        ..Default::default()
    });
    let mut request = authorized(token, metrics);
    request
        .metadata_mut()
        .insert(metadata::PROFILE, "linux".parse().unwrap());
    request
        .metadata_mut()
        .insert(metadata::BATCH_ID, "immutable-live-linux".parse().unwrap());
    request.metadata_mut().insert(
        metadata::BATCH_CREATED,
        created.to_string().parse().unwrap(),
    );
    request
}

fn signing() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[7; 32])
}

/// A token as the web application signs it; `changes` overrides individual claims.
fn token(db: &Database, node: Uuid, changes: serde_json::Value) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::Signer;
    let now = unix_nanos().unwrap() / 1_000_000_000;
    let public = URL_SAFE_NO_PAD.encode(signing().verifying_key().as_bytes());
    let mut claims = serde_json::json!({
        "sub": node.to_string(),
        "org": "test-org",
        "project": db.project.to_string(),
        "root": if node == db.node { "node" } else { "other" },
        "rootKind": 1,
        "adapter": "linux",
        "localKinds": [4],
        "maxAge": 604800,
        "skew": 0,
        "iss": "recount",
        "aud": "recount-ingestion",
        "iat": now,
        "exp": now + 3600,
    });
    for (key, value) in changes.as_object().unwrap() {
        claims[key] = value.clone();
    }
    let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": auth::key_id(&public) });
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = signing().sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

#[tokio::test]
#[ignore = "requires explicit isolated PostgreSQL, current web migrations and Bun"]
async fn signed_node_tokens_revocation_bindings_and_outage_are_live() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let db = Database::new().await;
    let public = URL_SAFE_NO_PAD.encode(signing().verifying_key().as_bytes());
    let tokens = Arc::new(auth::NodeTokens::new(&db.reader_url, &[public]).unwrap());
    let sink = Arc::new(TestSink::default());
    let (mut client, endpoint, stop, task) =
        server(tokens.clone(), sink.clone(), Limits::default()).await;
    let mut claims = ExecutionParticipantsClient::connect(endpoint)
        .await
        .unwrap();
    let current = token(&db, db.node, serde_json::json!({}));
    let created = unix_nanos().unwrap();
    // Fail closed until the first revocation list loads.
    assert!(!tokens.ready().await);
    assert_eq!(
        client
            .export(batch(&current, created))
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    assert!(tokens.refresh_revocations().await);
    assert!(tokens.ready().await);
    claims.claim(participant(&current, &db)).await.unwrap();
    for field in ["project", "node", "host"] {
        let mut request = participant(&current, &db);
        match field {
            "project" => request.get_mut().project_id = Uuid::now_v7().to_string(),
            "node" => request.get_mut().node_id = db.other_node.to_string(),
            _ => request.get_mut().host_id = "other".into(),
        }
        assert_eq!(
            claims.claim(request).await.unwrap_err().code(),
            Code::PermissionDenied,
            "{field}"
        );
    }
    assert_eq!(sink.participants.lock().unwrap().len(), 1);
    let mut first = batch(&current, created);
    first
        .metadata_mut()
        .insert("project-id", "spoofed".parse().unwrap());
    client.export(first).await.unwrap();
    {
        let records = sink.records.lock().unwrap();
        let security = records[0].security.as_ref().unwrap();
        assert_eq!(security.project_id, db.project.to_string());
        assert_eq!(security.source_id, db.node.to_string());
    }
    // Nodes hold only their machine root; independent resources are never granted.
    let mut sensor = body();
    sensor.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("recount.resource.id", "sensor"),
            string("recount.resource.kind", "sensor"),
        ],
        ..Default::default()
    });
    assert_eq!(
        client
            .export(authorized(&current, sensor))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    let published = sink.records.lock().unwrap().len();
    let no_local = token(&db, db.node, serde_json::json!({ "localKinds": [] }));
    assert_eq!(
        client
            .export(linux_process(&no_local, unix_nanos().unwrap()))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    assert_eq!(sink.records.lock().unwrap().len(), published);
    client
        .export(linux_process(&current, unix_nanos().unwrap()))
        .await
        .unwrap();
    let short = token(&db, db.node, serde_json::json!({ "maxAge": 1 }));
    assert_eq!(
        client
            .export(batch(&short, unix_nanos().unwrap() - 3_000_000_000))
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    let expired = token(&db, db.node, serde_json::json!({ "iat": 1, "exp": 2 }));
    assert_eq!(
        claims
            .claim(participant(&expired, &db))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(sink.participants.lock().unwrap().len(), 1);
    assert_eq!(
        client
            .export(authorized(&expired, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    db.client
        .execute(
            "UPDATE ingestion.collector_node SET revoked_at=statement_timestamp() WHERE id=$1",
            &[&db.node],
        )
        .await
        .unwrap();
    assert!(tokens.refresh_revocations().await);
    assert_eq!(
        claims
            .claim(participant(&current, &db))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    assert_eq!(sink.participants.lock().unwrap().len(), 1);
    assert_eq!(
        client
            .export(authorized(&current, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    // Losing database access keeps the last list: revoked stays revoked, others keep working.
    db.client
        .batch_execute(&format!(
            "REVOKE SELECT ON ingestion.collector_node FROM {}",
            db.role
        ))
        .await
        .unwrap();
    let start = std::time::Instant::now();
    assert!(!tokens.refresh_revocations().await);
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(
        client
            .export(authorized(&current, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    let other = token(&db, db.other_node, serde_json::json!({}));
    client.export(authorized(&other, body())).await.unwrap();
    validate::retained_raw(&sink.records.lock().unwrap()[0], Limits::default()).unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
    drop(tokens);
    db.close().await;
}
