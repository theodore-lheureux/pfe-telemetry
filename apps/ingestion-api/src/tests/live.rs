use super::*;
use std::path::PathBuf;

struct Database {
    client: tokio_postgres::Client,
    admin: tokio_postgres::Client,
    name: String,
    role: String,
    reader_url: String,
    credential: Uuid,
    project: Uuid,
    token: String,
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
        let credential = Uuid::now_v7();
        let project = Uuid::now_v7();
        let token = format!("recount_{credential}_{}", "A".repeat(43));
        client.batch_execute(&format!(
            "INSERT INTO app.organization (id,name,slug,created_at) VALUES ('test-org','Test','test',now());
             INSERT INTO app.project (id,organization_id,name,slug) VALUES ('{project}','test-org','Test','test');
             CREATE ROLE {role} LOGIN PASSWORD 'test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 4;
             GRANT CONNECT ON DATABASE {name} TO {role};
             GRANT USAGE ON SCHEMA ingestion TO {role};
             GRANT SELECT ON ingestion.collector_credential, ingestion.collector_root_grant, ingestion.collector_resource_grant TO {role};"
        )).await.unwrap();
        client.execute("INSERT INTO ingestion.collector_credential (id,organization_id,project_id,source_id,name,token_sha256,root_id,root_kind,maximum_submission_age,allowed_clock_skew) VALUES ($1,'test-org',$2,'trusted-source','Test',$3,'node',1,604800,0)", &[&credential,&project,&auth::digest(token.as_bytes())]).await.unwrap();
        client.execute("INSERT INTO ingestion.collector_root_grant (credential_id,project_id,organization_id,resource_id,resource_kind,adapter,allowed_local_kinds) VALUES ($1,$2,'test-org','node',1,'linux',ARRAY[4])", &[&credential,&project]).await.unwrap();
        client.execute("INSERT INTO ingestion.collector_resource_grant (credential_id,project_id,organization_id,resource_id,resource_kind) VALUES ($1,$2,'test-org','sensor',8)", &[&credential,&project]).await.unwrap();
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
            credential,
            project,
            token,
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

#[tokio::test]
#[ignore = "requires explicit isolated PostgreSQL, current web migrations and Bun"]
async fn authoritative_postgres_rotation_revocation_expiry_bindings_and_outage_are_live() {
    let db = Database::new().await;
    let credentials = Arc::new(auth::Credentials::new(&db.reader_url).unwrap());
    assert!(credentials.ready().await);
    let sink = Arc::new(TestSink::default());
    let (mut client, _, stop, task) =
        server(credentials.clone(), sink.clone(), Limits::default()).await;
    let created = unix_nanos().unwrap();
    let mut first = batch(&db.token, created);
    first
        .metadata_mut()
        .insert("project-id", "spoofed".parse().unwrap());
    client.export(first).await.unwrap();
    assert_eq!(
        sink.records.lock().unwrap()[0]
            .security
            .as_ref()
            .unwrap()
            .project_id,
        db.project.to_string()
    );
    let rotated = db.token.replace(&"A".repeat(43), &"B".repeat(43));
    db.client.execute("UPDATE ingestion.collector_credential SET token_sha256=$1, rotated_at=statement_timestamp() WHERE id=$2", &[&auth::digest(rotated.as_bytes()),&db.credential]).await.unwrap();
    assert_eq!(
        client
            .export(batch(&db.token, created))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    client.export(batch(&rotated, created)).await.unwrap();
    {
        let records = sink.records.lock().unwrap();
        let original = validate::raw(&records[0], Limits::default()).unwrap();
        let retried = validate::raw(&records[1], Limits::default()).unwrap();
        assert_eq!(original[0].sample_id, retried[0].sample_id);
        assert_eq!(records[0].bindings, records[1].bindings);
        assert_ne!(records[0].record_id, records[1].record_id);
    }
    let mut sensor = body();
    sensor.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("recount.resource.id", "sensor"),
            string("recount.resource.kind", "sensor"),
        ],
        ..Default::default()
    });
    client
        .export(authorized(&rotated, sensor.clone()))
        .await
        .unwrap();
    sensor.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes[0] = string("recount.resource.id", "unbound");
    sensor.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .push(string("parent.id", "node"));
    assert_eq!(
        client
            .export(authorized(&rotated, sensor))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    db.client
        .batch_execute("DELETE FROM ingestion.collector_root_grant")
        .await
        .unwrap();
    assert_eq!(
        client
            .export(authorized(&rotated, body()))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    db.client.execute("INSERT INTO ingestion.collector_root_grant (credential_id,project_id,organization_id,resource_id,resource_kind,adapter,allowed_local_kinds) VALUES ($1,$2,'test-org','node',1,'linux',ARRAY[4])", &[&db.credential,&db.project]).await.unwrap();
    let linux_created = unix_nanos().unwrap();
    let published = sink.records.lock().unwrap().len();
    db.client.batch_execute("UPDATE ingestion.collector_root_grant SET adapter='standard', allowed_local_kinds=ARRAY[]::integer[]").await.unwrap();
    assert_eq!(
        client
            .export(linux_process(&rotated, linux_created))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    db.client
        .batch_execute("UPDATE ingestion.collector_root_grant SET adapter='linux'")
        .await
        .unwrap();
    assert_eq!(
        client
            .export(linux_process(&rotated, linux_created))
            .await
            .unwrap_err()
            .code(),
        Code::PermissionDenied
    );
    assert_eq!(sink.records.lock().unwrap().len(), published);
    db.client
        .batch_execute("UPDATE ingestion.collector_root_grant SET allowed_local_kinds=ARRAY[4]")
        .await
        .unwrap();
    client
        .export(linux_process(&rotated, linux_created))
        .await
        .unwrap();
    assert_eq!(sink.records.lock().unwrap().len(), published + 1);
    db.client
        .batch_execute("UPDATE ingestion.collector_credential SET maximum_submission_age=1")
        .await
        .unwrap();
    assert_eq!(
        client
            .export(batch(&rotated, unix_nanos().unwrap() - 3_000_000_000))
            .await
            .unwrap_err()
            .code(),
        Code::FailedPrecondition
    );
    // Current upload/credential policy cannot invalidate an accepted raw record.
    validate::retained_raw(&sink.records.lock().unwrap()[0], Limits::default()).unwrap();
    db.client
        .batch_execute("UPDATE ingestion.collector_credential SET maximum_submission_age=604800")
        .await
        .unwrap();
    client
        .export(batch(
            &rotated,
            unix_nanos().unwrap() - 3 * 86400 * 1_000_000_000,
        ))
        .await
        .unwrap();
    db.client
        .batch_execute(&format!(
            "REVOKE SELECT ON ingestion.collector_root_grant FROM {}",
            db.role
        ))
        .await
        .unwrap();
    let start = std::time::Instant::now();
    assert_eq!(
        client
            .export(authorized(&rotated, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(!credentials.ready().await);
    db.client
        .batch_execute(&format!(
            "GRANT SELECT ON ingestion.collector_root_grant TO {}",
            db.role
        ))
        .await
        .unwrap();
    client.export(authorized(&rotated, body())).await.unwrap();
    db.client.batch_execute("UPDATE ingestion.collector_credential SET created_at='2000-01-01', expires_at='2001-01-01'").await.unwrap();
    assert_eq!(
        client
            .export(authorized(&rotated, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    db.client.batch_execute("UPDATE ingestion.collector_credential SET expires_at=NULL, revoked_at=statement_timestamp()").await.unwrap();
    assert_eq!(
        client
            .export(authorized(&rotated, body()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    validate::retained_raw(&sink.records.lock().unwrap()[0], Limits::default()).unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
    drop(credentials);
    db.close().await;
}
