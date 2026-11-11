pub mod admission;
pub mod auth;
pub mod broker;
pub mod config;
mod delivery;
pub mod live;
pub mod resources;
#[cfg(test)]
mod tests;

use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    metrics_service_server::{MetricsService, MetricsServiceServer},
};
use prost::Message;
use recount_telemetry_schema::wire::{PayloadKind, RawRecord};
use recount_telemetry_validation::{
    Category, Issue, metadata, policy,
    validate::{self, Limits},
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tonic::{Request, Response, Status, codec::CompressionEncoding, transport::Server};
use tonic_health::{ServingStatus, server::health_reporter};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type HttpResponse = tonic::codegen::http::Response<tonic::body::Body>;
type LimitLayer =
    tower::layer::util::Stack<admission::AdmissionLayer, tower::layer::util::Identity>;
pub type Router = tonic::transport::server::Router<LimitLayer>;
pub const HEALTH_SERVICE: &str = "grpc.health.v1.Health";

fn limit_status(mut response: HttpResponse) -> HttpResponse {
    // Tonic rejects compressed/decompressed oversized frames before Prost decode.
    // OUT_OF_RANGE is retryable in OTLP, but deterministic body limits are not.
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

pub fn status(issue: Issue) -> Status {
    let message = issue.to_string();
    match issue.category {
        Category::Invalid => Status::invalid_argument(message),
        Category::Unsupported | Category::Expired => Status::failed_precondition(message),
        Category::Forbidden => Status::permission_denied(message),
        Category::Limit => Status::resource_exhausted(message),
        _ => Status::unavailable("Ingestion validation is unavailable"),
    }
}

pub fn unix_nanos() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .try_into()?)
}

struct Ingestion {
    authority: Arc<dyn auth::Authority>,
    sink: Arc<dyn broker::Sink>,
    limits: Limits,
}

impl Ingestion {
    async fn accept(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
        let permit = request
            .extensions()
            .get::<admission::DecodePermit>()
            .cloned()
            .ok_or_else(|| Status::internal("Missing admission context"))?;
        let source = self.authority.authenticate(request.metadata()).await?;
        let received =
            unix_nanos().map_err(|_| Status::unavailable("Ingestion clock is unavailable"))?;
        let mut headers = Vec::new();
        for key in [
            metadata::PROFILE,
            metadata::BATCH_ID,
            metadata::BATCH_CREATED,
        ] {
            if let Some(value) = auth::one(request.metadata(), key)? {
                headers.push((key, value));
            }
        }
        let (profile, batch) = metadata::headers(&headers).map_err(status)?;
        if let Some(batch) = &batch {
            metadata::age(batch, received, source.maximum_age_ns, source.skew_ns)
                .map_err(status)?;
        }
        let delivery = delivery::observe(&request)?;
        let body = request.into_inner();
        let limits = self.limits;
        // Blocking validation retains admission until completion even if the RPC is cancelled.
        let (raw, body, count, permit, source, requested) =
            tokio::task::spawn_blocking(move || {
                let count = validate::request(&body, limits).map_err(status)?;
                let bindings = resources::resolve(&body, &source, profile, limits)?;
                let raw = RawRecord {
                    security: Some(source.security.clone()),
                    record_id: Uuid::now_v7().to_string(),
                    received_unix_nano: received,
                    batch,
                    payload_kind: PayloadKind::OtlpMetrics as i32,
                    otlp_request: body.encode_to_vec(),
                    bindings,
                    delivery: Some(delivery),
                };
                let requested = policy::requested_authorities(&raw, limits.distinct_authorities)
                    .map_err(status)?;
                Ok::<_, Status>((raw, body, count, permit, source, requested))
            })
            .await
            .map_err(|_| Status::unavailable("Validation worker failed"))??;
        let (roots, bound) = self.authority.grants(&source, &requested).await?;
        if profile == metadata::Profile::Linux && roots.iter().any(|grant| grant.adapter != "linux")
        {
            return Err(Status::permission_denied(
                "Linux adapter is not enrolled for this root",
            ));
        }
        policy::authorize(
            &source.security,
            &raw,
            &roots,
            &bound,
            limits.distinct_authorities,
        )
        .map_err(status)?;
        let (raw, body, count, _permit) = tokio::task::spawn_blocking(move || {
            validate::preflight(&raw, &body, limits).map_err(status)?;
            Ok::<_, Status>((raw, body, count, permit))
        })
        .await
        .map_err(|_| Status::unavailable("Preflight worker failed"))??;
        if count > 0 {
            self.sink
                .publish(&raw, &body)
                .await
                .map_err(|_| Status::unavailable("Durable publication was not confirmed"))?;
        }
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

pub async fn configured_router(
    authority: Arc<dyn auth::Authority>,
    sink: Arc<dyn broker::Sink>,
    limits: Limits,
    max_in_flight: usize,
) -> Result<Router> {
    let limits = limits.validate()?;
    if max_in_flight == 0 {
        return Err("Positive admission concurrency required".into());
    }
    let (reporter, health) = health_reporter();
    reporter
        .set_service_status(HEALTH_SERVICE, ServingStatus::Serving)
        .await;
    let name = "opentelemetry.proto.collector.metrics.v1.MetricsService";
    reporter
        .set_service_status("", ServingStatus::NotServing)
        .await;
    reporter
        .set_service_status(name, ServingStatus::NotServing)
        .await;
    reporter
        .set_service_status(
            "opentelemetry.proto.collector.trace.v1.TraceService",
            ServingStatus::NotServing,
        )
        .await;
    let weak = Arc::downgrade(&authority);
    let health_sink = sink.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            let Some(authority) = weak.upgrade() else {
                break;
            };
            let (database, broker) = tokio::join!(authority.ready(), health_sink.ready());
            let state = if database && broker {
                ServingStatus::Serving
            } else {
                ServingStatus::NotServing
            };
            reporter.set_service_status("", state).await;
            reporter.set_service_status(name, state).await;
        }
    });
    let ingestion = Ingestion {
        authority,
        sink,
        limits,
    };
    let metrics = MetricsServiceServer::new(ingestion)
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
        .max_decoding_message_size(limits.decoded_bytes);
    Ok(Server::builder()
        .layer(admission::AdmissionLayer::new(max_in_flight))
        .concurrency_limit_per_connection(max_in_flight)
        .timeout(Duration::from_secs(10))
        .add_service(health)
        .add_service(metrics))
}

pub async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Unable to register interrupt handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Unable to register termination handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { () = interrupt => {}, () = terminate => {} }
}
