use crate::{HttpResponse, Ingestion};
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse;
use prost::{
    Message,
    bytes::{Buf, Bytes},
};
use recount_telemetry_schema::ExportMetricsServiceRequest;
use std::{
    convert::Infallible,
    task::{Context, Poll},
};
use tonic::{
    Request, Response, Status,
    codec::{
        Codec, CompressionEncoding, DecodeBuf, Decoder, EnabledCompressionEncodings, EncodeBuf,
        Encoder,
    },
    codegen::{Body, BoxFuture, Service, StdError, http},
    server::{Grpc, NamedService, UnaryService},
};

pub(crate) const NAME: &str = "opentelemetry.proto.collector.metrics.v1.MetricsService";
pub(crate) const EXPORT: &str = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";

pub(crate) struct MetricsExport {
    pub body: ExportMetricsServiceRequest,
    pub wire: Bytes,
}

#[derive(Clone)]
pub(crate) struct MetricsService {
    ingestion: Ingestion,
    max_decoded: usize,
}

impl MetricsService {
    pub fn new(ingestion: Ingestion, max_decoded: usize) -> Self {
        Self {
            ingestion,
            max_decoded,
        }
    }
}

impl NamedService for MetricsService {
    const NAME: &'static str = NAME;
}

impl<B: Body + Send + 'static> Service<http::Request<B>> for MetricsService
where
    B::Error: Into<StdError> + Send + 'static,
{
    type Response = HttpResponse;
    type Error = Infallible;
    type Future = BoxFuture<HttpResponse, Infallible>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: http::Request<B>) -> Self::Future {
        if request.uri().path() != EXPORT {
            return Box::pin(async { Ok(Status::unimplemented("").into_http()) });
        }
        let handler = Export(self.ingestion.clone());
        let max_decoded = self.max_decoded;
        Box::pin(async move {
            let mut gzip = EnabledCompressionEncodings::default();
            gzip.enable(CompressionEncoding::Gzip);
            let response = Grpc::new(MetricsCodec)
                .apply_compression_config(gzip, gzip)
                .apply_max_message_size_config(Some(max_decoded), None)
                .unary(handler, request)
                .await;
            Ok(response)
        })
    }
}

struct Export(Ingestion);

impl UnaryService<MetricsExport> for Export {
    type Response = ExportMetricsServiceResponse;
    type Future = BoxFuture<Response<Self::Response>, Status>;

    fn call(&mut self, request: Request<MetricsExport>) -> Self::Future {
        let ingestion = self.0.clone();
        Box::pin(async move { ingestion.accept(request).await })
    }
}

struct MetricsCodec;

impl Codec for MetricsCodec {
    type Encode = ExportMetricsServiceResponse;
    type Decode = MetricsExport;
    type Encoder = Self;
    type Decoder = Self;

    fn encoder(&mut self) -> Self {
        Self
    }
    fn decoder(&mut self) -> Self {
        Self
    }
}

impl Encoder for MetricsCodec {
    type Item = ExportMetricsServiceResponse;
    type Error = Status;

    fn encode(&mut self, value: Self::Item, buf: &mut EncodeBuf<'_>) -> Result<(), Status> {
        value
            .encode(buf)
            .map_err(|err| Status::internal(err.to_string()))
    }
}

impl Decoder for MetricsCodec {
    type Item = MetricsExport;
    type Error = Status;

    fn decode(&mut self, buf: &mut DecodeBuf<'_>) -> Result<Option<MetricsExport>, Status> {
        // Tonic has already unframed, decompressed and size-checked this message.
        let wire = buf.copy_to_bytes(buf.remaining());
        let body = ExportMetricsServiceRequest::decode(wire.as_ref())
            .map_err(|err| Status::internal(err.to_string()))?;
        Ok(Some(MetricsExport { body, wire }))
    }
}
