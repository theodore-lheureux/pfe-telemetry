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
    auth::Sources,
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

pub const TOKEN: &str = "integration-test-token-with-more-than-32-characters";
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
pub fn policy() -> Sources {
    Sources::parse(&serde_json::json!([{"project_id":"trusted-project", "source_id":"trusted-source", "token_sha256":digest(TOKEN.as_bytes()), "hosts":["node1"]}]).to_string()).unwrap()
}
pub fn envelope() -> Envelope {
    use prost::Message;
    Envelope {
        format_version: 1,
        project_id: "trusted-project".into(),
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel();
    let router = pfe_server::configured_router(policy(), sink).await;
    let task = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let client = MetricsServiceClient::connect(format!("http://{address}"))
        .await
        .unwrap()
        .send_compressed(CompressionEncoding::Gzip)
        .accept_compressed(CompressionEncoding::Gzip);
    (client, stop, task)
}
