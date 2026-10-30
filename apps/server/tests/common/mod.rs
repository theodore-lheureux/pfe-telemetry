#![allow(dead_code)]
use opentelemetry_proto::tonic::{
    collector::metrics::v1::{
        ExportMetricsServiceRequest, metrics_service_client::MetricsServiceClient,
    },
    common::v1::{AnyValue, KeyValue, any_value},
    metrics::v1::{
        Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric, number_data_point,
    },
    resource::v1::Resource,
};
use pfe_server::{
    Result,
    auth::Credentials,
    broker::Sink,
    envelope::{Envelope, digest},
};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::oneshot;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{codec::CompressionEncoding, transport::Channel};
use uuid::Uuid;

pub const CREDENTIAL_ID: &str = "019a4790-d1da-7000-8000-000000000001";
pub const PROJECT_ID: &str = "019a4790-d1da-7000-8000-000000000002";
pub const TOKEN: &str =
    "pfe_019a4790-d1da-7000-8000-000000000001_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
pub const ROTATED_TOKEN: &str =
    "pfe_019a4790-d1da-7000-8000-000000000001_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
pub fn attr(name: &str, value: &str) -> KeyValue {
    KeyValue {
        key: name.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.into())),
        }),
        ..Default::default()
    }
}
pub fn request() -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(Resource {
                attributes: vec![attr("host.id", "node1"), attr("project_id", "untrusted")],
                ..Default::default()
            }),
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![Metric {
                    name: "pfe.node.memory.total".into(),
                    unit: "By".into(),
                    data: Some(metric::Data::Gauge(Gauge {
                        data_points: vec![NumberDataPoint {
                            time_unix_nano: u64::MAX - 1,
                            value: Some(number_data_point::Value::AsInt(9_007_199_254_740_993)),
                            ..Default::default()
                        }],
                    })),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    }
}
pub fn envelope() -> Envelope {
    use prost::Message;
    Envelope {
        format_version: 1,
        project_id: PROJECT_ID.into(),
        source_id: "trusted-source".into(),
        record_id: Uuid::now_v7().to_string(),
        received_unix_nano: pfe_server::unix_nanos().unwrap(),
        payload_kind: "otlp.metrics".into(),
        profile: "standard".into(),
        client_batch_id: Uuid::now_v7().to_string(),
        client_created_unix_nano: pfe_server::unix_nanos().unwrap(),
        payload: request().encode_to_vec(),
    }
}
pub fn export(
    body: ExportMetricsServiceRequest,
    id: &str,
) -> tonic::Request<ExportMetricsServiceRequest> {
    let mut request = tonic::Request::new(body);
    request
        .metadata_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    if !id.is_empty() {
        request
            .metadata_mut()
            .insert("pfe-batch-id", id.parse().unwrap());
        request.metadata_mut().insert(
            "pfe-batch-created-unix-nano",
            pfe_server::unix_nanos()
                .unwrap()
                .to_string()
                .parse()
                .unwrap(),
        );
    }
    request
}
pub struct Directory(pub PathBuf);
impl Directory {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pfe-storage-test-{}", Uuid::now_v7()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub fn files(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.0)
            .unwrap()
            .map(|v| v.unwrap().path())
            .filter(|v| v.extension().is_some_and(|v| v == "parquet"))
            .collect()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
pub struct TestSink {
    pub records: Mutex<Vec<Envelope>>,
    pub fail: AtomicBool,
}
#[tonic::async_trait]
impl Sink for TestSink {
    async fn publish(&self, envelope: &Envelope) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("Sink unavailable".into());
        }
        self.records.lock().unwrap().push(envelope.clone());
        Ok(())
    }
    async fn ready(&self) -> bool {
        !self.fail.load(Ordering::SeqCst)
    }
}
pub async fn server(
    sink: Arc<dyn Sink>,
) -> (
    MetricsServiceClient<Channel>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let database = Database::new().await;
    server_with_database(sink, database).await
}

pub async fn server_with_database(
    sink: Arc<dyn Sink>,
    database: Database,
) -> (
    MetricsServiceClient<Channel>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let router = pfe_server::configured_router(database.credentials(), sink).await;
    let task = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        database.close().await;
    });
    let client = MetricsServiceClient::connect(format!("http://{address}"))
        .await
        .unwrap()
        .send_compressed(CompressionEncoding::Gzip)
        .accept_compressed(CompressionEncoding::Gzip);
    (client, stop, task)
}

pub struct Database {
    pub client: Arc<tokio_postgres::Client>,
    pub admin: tokio_postgres::Client,
    pub credential_url: String,
    pub management_url: String,
    name: String,
    pub role: String,
}

async fn connect(config: tokio_postgres::Config) -> tokio_postgres::Client {
    let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

impl Database {
    pub async fn new() -> Self {
        let base = std::env::var("TEST_DATABASE_URL").expect("Set disposable TEST_DATABASE_URL");
        let mut config: tokio_postgres::Config = base.parse().unwrap();
        let admin = connect(config.clone()).await;
        let suffix = Uuid::now_v7().simple().to_string();
        let name = format!("pfe_ingestion_test_{suffix}");
        let role = format!("pfe_ingestion_reader_{suffix}");
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await
            .unwrap();
        config.dbname(&name);
        let (base, query) = base.split_once('?').unwrap_or((&base, ""));
        let (prefix, _) = base.rsplit_once('/').expect("PostgreSQL URL with database");
        let url = format!("{prefix}/{name}?{query}");
        let web = std::env::var_os("PFE_TEST_WEB_DIRECTORY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web"));
        let status = std::process::Command::new("bun")
            .args(["--no-env-file", "scripts/migrate.ts"])
            .current_dir(web)
            .env("DATABASE_URL", &url)
            .status()
            .expect("Bun and frozen-lockfile web dependencies are required");
        assert!(status.success(), "Drizzle migrations failed");
        let client = connect(config).await;
        client.batch_execute(&format!(
            "INSERT INTO app.organization (id,name,slug,created_at) VALUES ('test-org','Test','test',now());
             INSERT INTO app.project (id,organization_id,name,slug) VALUES ('{PROJECT_ID}','test-org','Test','test');
             CREATE ROLE {role} LOGIN PASSWORD 'test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 4;
             GRANT CONNECT ON DATABASE {name} TO {role};
             GRANT USAGE ON SCHEMA ingestion TO {role};
             GRANT SELECT ON ingestion.collector_credential TO {role};"
        )).await.unwrap();
        client
            .execute(
                "INSERT INTO ingestion.collector_credential
             (id,organization_id,project_id,source_id,name,token_sha256,hosts)
             VALUES ($1,'test-org',$2,'trusted-source','Test',$3,ARRAY['node1'])",
                &[
                    &Uuid::parse_str(CREDENTIAL_ID).unwrap(),
                    &Uuid::parse_str(PROJECT_ID).unwrap(),
                    &digest(TOKEN.as_bytes()),
                ],
            )
            .await
            .unwrap();
        let (_, host) = prefix
            .rsplit_once('@')
            .expect("Test URL must include user info");
        let credential_url = format!("postgresql://{role}:test-only@{host}/{name}?sslmode=disable");
        Self {
            client: Arc::new(client),
            admin,
            credential_url,
            management_url: url,
            name,
            role,
        }
    }

    pub fn credentials(&self) -> Credentials {
        Credentials::new(&self.credential_url).unwrap()
    }

    pub async fn close(self) {
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
