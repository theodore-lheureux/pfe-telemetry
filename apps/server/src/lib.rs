//! OTLP ingestion, retained envelopes and replay-safe analytical files.

pub mod auth;
pub mod broker;
pub mod config;
pub mod envelope;
pub mod metrics;
pub mod storage;

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use opentelemetry_proto::tonic::collector::{
    metrics::v1::{
        ExportMetricsServiceRequest, ExportMetricsServiceResponse,
        metrics_service_server::{MetricsService, MetricsServiceServer},
    },
    trace::v1::{
        ExportTraceServiceRequest, ExportTraceServiceResponse,
        trace_service_server::{TraceService, TraceServiceServer},
    },
};
use prost::Message;
use tokio::sync::Semaphore;
use tonic::{Request, Response, Status, codec::CompressionEncoding, transport::Server};
use tonic_health::{ServingStatus, server::health_reporter};
use uuid::Uuid;

use auth::{Sources, one};
use broker::Sink;
use envelope::Envelope;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type HttpResponse = tonic::codegen::http::Response<tonic::body::Body>;
type LimitLayer = tower::layer::util::Stack<
    tower::util::MapResponseLayer<fn(HttpResponse) -> HttpResponse>,
    tower::layer::util::Identity,
>;
pub type Router = tonic::transport::server::Router<LimitLayer>;

fn limit_status(mut response: HttpResponse) -> HttpResponse {
    // Tonic's decoder reports oversized messages as OUT_OF_RANGE, which OTLP retries.
    // Application handlers never use that status; size rejection must be terminal.
    if response
        .headers()
        .get("grpc-status")
        .is_some_and(|v| v == "11")
    {
        response.headers_mut().insert(
            "grpc-status",
            tonic::codegen::http::HeaderValue::from_static("8"),
        );
    }
    response
}

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const HEALTH_SERVICE: &str = "grpc.health.v1.Health";

pub fn unix_nanos() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .try_into()?)
}

#[derive(Clone)]
struct Ingestion {
    configured: Option<(Arc<Sources>, Arc<dyn Sink>)>,
    admission: Arc<Semaphore>,
}

impl Ingestion {
    async fn accept(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
        let Some((sources, sink)) = &self.configured else {
            return Err(Status::unimplemented(
                "Durable telemetry ingestion is not configured",
            ));
        };
        let source = sources.authenticate(request.metadata())?;
        let _permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Status::unavailable("Ingestion is at capacity"))?;
        let received =
            unix_nanos().map_err(|_| Status::unavailable("Ingestion clock is unavailable"))?;
        let profile = one(request.metadata(), "pfe-collection-profile")?
            .unwrap_or("standard")
            .to_owned();
        if profile != "standard" && profile != "external/1.0" {
            return Err(Status::failed_precondition(
                "Unsupported collection profile",
            ));
        }
        let batch_id = one(request.metadata(), "pfe-batch-id")?
            .unwrap_or("")
            .to_owned();
        let created = one(request.metadata(), "pfe-batch-created-unix-nano")?;
        let created = match (batch_id.is_empty(), created) {
            (true, None) if profile == "standard" => 0,
            (false, Some(value)) => {
                if !Uuid::parse_str(&batch_id)
                    .is_ok_and(|v| v.to_string() == batch_id && v.get_version_num() == 7)
                {
                    return Err(Status::invalid_argument(
                        "Batch ID must be a lowercase UUIDv7",
                    ));
                }
                if value.is_empty()
                    || value.len() > 20
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(Status::invalid_argument("Invalid batch creation timestamp"));
                }
                let time: u64 = value
                    .parse()
                    .map_err(|_| Status::invalid_argument("Invalid batch creation timestamp"))?;
                if time == 0
                    || time > received.saturating_add(source.allowed_clock_skew * 1_000_000_000)
                {
                    return Err(Status::invalid_argument(
                        "Invalid future batch creation timestamp",
                    ));
                }
                if received.saturating_sub(time)
                    > (source.maximum_submission_age + source.allowed_clock_skew) * 1_000_000_000
                {
                    return Err(Status::failed_precondition("Batch submission has expired"));
                }
                time
            }
            _ => {
                return Err(Status::invalid_argument(
                    "Batch identity and creation timestamp are required together",
                ));
            }
        };
        let body = request.into_inner();
        if body.encoded_len() > MAX_MESSAGE_BYTES {
            return Err(Status::resource_exhausted(
                "Request exceeds the decoded message limit",
            ));
        }
        let project_id = source.project_id.clone();
        let source_id = source.source_id.clone();
        let external = profile == "external/1.0";
        let (payload, count) = tokio::task::spawn_blocking(move || {
            let count = metrics::validate(&body, &source, external)?;
            Ok::<_, Status>((body.encode_to_vec(), count))
        })
        .await
        .map_err(|_| Status::unavailable("Validation worker failed"))??;
        if count == 0 {
            return Ok(Response::new(ExportMetricsServiceResponse::default()));
        }
        let envelope = Envelope {
            format_version: 1,
            record_id: Uuid::now_v7().to_string(),
            project_id,
            source_id,
            received_unix_nano: received,
            payload_kind: "otlp.metrics".into(),
            profile,
            client_batch_id: batch_id,
            client_created_unix_nano: created,
            payload,
        };
        sink.publish(&envelope)
            .await
            .map_err(|_| Status::unavailable("Durable publication was not confirmed"))?;
        Ok(Response::new(ExportMetricsServiceResponse::default()))
    }
}

#[tonic::async_trait]
impl MetricsService for Ingestion {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
        self.accept(request).await
    }
}

#[tonic::async_trait]
impl TraceService for Ingestion {
    async fn export(
        &self,
        _request: Request<ExportTraceServiceRequest>,
    ) -> std::result::Result<Response<ExportTraceServiceResponse>, Status> {
        Err(Status::unimplemented("Trace storage is not configured"))
    }
}

pub async fn router() -> Router {
    build_router(None).await
}

pub async fn configured_router(sources: Sources, sink: Arc<dyn Sink>) -> Router {
    build_router(Some((Arc::new(sources), sink))).await
}

async fn build_router(configured: Option<(Arc<Sources>, Arc<dyn Sink>)>) -> Router {
    let (reporter, health) = health_reporter();
    reporter
        .set_service_status(HEALTH_SERVICE, ServingStatus::Serving)
        .await;
    let metrics_name = "opentelemetry.proto.collector.metrics.v1.MetricsService";
    reporter
        .set_service_status("", ServingStatus::NotServing)
        .await;
    reporter
        .set_service_status(metrics_name, ServingStatus::NotServing)
        .await;
    reporter
        .set_not_serving::<TraceServiceServer<Ingestion>>()
        .await;
    if let Some((_, sink)) = &configured {
        let sink = sink.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                let status = if sink.ready().await {
                    ServingStatus::Serving
                } else {
                    ServingStatus::NotServing
                };
                reporter.set_service_status("", status).await;
                reporter.set_service_status(metrics_name, status).await;
            }
        });
    }
    let ingestion = Ingestion {
        configured,
        admission: Arc::new(Semaphore::new(16)),
    };
    let metrics = MetricsServiceServer::new(ingestion.clone())
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
        .max_decoding_message_size(MAX_MESSAGE_BYTES);
    let traces = TraceServiceServer::new(ingestion)
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
        .max_decoding_message_size(MAX_MESSAGE_BYTES);
    Server::builder()
        .layer(tower::util::MapResponseLayer::new(
            limit_status as fn(HttpResponse) -> HttpResponse,
        ))
        .concurrency_limit_per_connection(32)
        .timeout(Duration::from_secs(10))
        .add_service(health)
        .add_service(metrics)
        .add_service(traces)
}

pub async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Unable to register Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Unable to register SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
    tracing::info!("Shutdown requested");
}
