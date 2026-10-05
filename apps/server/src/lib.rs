//! OTLP/gRPC ingestion services and standard gRPC health checks.

use std::time::Duration;

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
use tonic::{Request, Response, Status, codec::CompressionEncoding, transport::Server};
use tonic_health::{ServingStatus, server::health_reporter};

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const HEALTH_SERVICE: &str = "grpc.health.v1.Health";

#[derive(Default)]
struct Ingestion;

#[tonic::async_trait]
impl MetricsService for Ingestion {
    async fn export(
        &self,
        _request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        Err(Status::unimplemented(
            "Durable telemetry ingestion is not configured",
        ))
    }
}

#[tonic::async_trait]
impl TraceService for Ingestion {
    async fn export(
        &self,
        _request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        Err(Status::unimplemented(
            "Durable telemetry ingestion is not configured",
        ))
    }
}

pub async fn router() -> tonic::transport::server::Router {
    let (reporter, health) = health_reporter();
    reporter
        .set_service_status("", ServingStatus::NotServing)
        .await;
    reporter
        .set_service_status(HEALTH_SERVICE, ServingStatus::Serving)
        .await;
    reporter
        .set_not_serving::<MetricsServiceServer<Ingestion>>()
        .await;
    reporter
        .set_not_serving::<TraceServiceServer<Ingestion>>()
        .await;

    let metrics = MetricsServiceServer::new(Ingestion)
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
        .max_decoding_message_size(MAX_MESSAGE_BYTES);
    let traces = TraceServiceServer::new(Ingestion)
        .accept_compressed(CompressionEncoding::Gzip)
        .send_compressed(CompressionEncoding::Gzip)
        .max_decoding_message_size(MAX_MESSAGE_BYTES);

    Server::builder()
        .concurrency_limit_per_connection(32)
        .timeout(Duration::from_secs(10))
        .add_service(health)
        .add_service(metrics)
        .add_service(traces)
}
