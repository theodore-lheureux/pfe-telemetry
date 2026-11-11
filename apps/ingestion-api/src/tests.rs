use super::*;
use auth::{Authority, Source};
use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_client::MetricsServiceClient;
use recount_telemetry_schema::{
    common::{AnyValue, KeyValue, any_value},
    metrics::{
        Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric, number_data_point,
    },
    resource::Resource,
    wire::{PointLineage, ResourceKind, ResourceRef, SecurityScope},
};
use recount_telemetry_validation::delivery::{self as delivery_diagnostics, CollectorConnection};
use recount_telemetry_validation::policy::{BoundGrant, RequestedAuthorities, RootGrant};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{
    net::TcpListener,
    sync::{Notify, oneshot},
};
use tonic::{Code, metadata::MetadataMap};
mod live;

#[derive(Default)]
struct TestSink {
    records: Mutex<Vec<RawRecord>>,
    fail: AtomicBool,
}
#[tonic::async_trait]
impl broker::Sink for TestSink {
    async fn publish(&self, raw: &RawRecord, _body: &ExportMetricsServiceRequest) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("unconfirmed".into());
        }
        self.records.lock().unwrap().push(raw.clone());
        Ok(())
    }
    async fn ready(&self) -> bool {
        true
    }
}

struct TestAuthority {
    authenticate_count: AtomicUsize,
    grant_count: AtomicUsize,
    blocked: AtomicBool,
    entered: Notify,
    release: Notify,
    deny: AtomicBool,
}
impl Default for TestAuthority {
    fn default() -> Self {
        Self {
            authenticate_count: AtomicUsize::new(0),
            grant_count: AtomicUsize::new(0),
            blocked: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            deny: AtomicBool::new(false),
        }
    }
}
fn source() -> Source {
    Source {
        node_id: Uuid::nil(),
        security: SecurityScope {
            project_id: "019a4790-d1da-7000-8000-000000000002".into(),
            source_id: "source".into(),
        },
        root: ResourceRef {
            id: "node".into(),
            kind: ResourceKind::Host as i32,
        },
        maximum_age_ns: 7 * 86400 * 1_000_000_000,
        skew_ns: 0,
        adapter: "linux".into(),
        local_kinds: [ResourceKind::Process].into(),
    }
}
#[tonic::async_trait]
impl Authority for TestAuthority {
    async fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status> {
        self.authenticate_count.fetch_add(1, Ordering::SeqCst);
        if auth::one(metadata, "authorization")? != Some("Bearer test") {
            return Err(Status::unauthenticated("Invalid credentials"));
        }
        if self.blocked.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(source())
    }
    async fn grants(
        &self,
        source: &Source,
        requested: &RequestedAuthorities,
    ) -> std::result::Result<(Vec<RootGrant>, Vec<BoundGrant>), Status> {
        self.grant_count.fetch_add(1, Ordering::SeqCst);
        if self.deny.load(Ordering::SeqCst) {
            return Ok((vec![], vec![]));
        }
        let roots = requested
            .roots
            .iter()
            .filter(|id| *id == "node")
            .map(|id| RootGrant {
                security: source.security.clone(),
                root: ResourceRef {
                    id: id.clone(),
                    kind: ResourceKind::Host as i32,
                },
                adapter: "linux".into(),
                allowed_local_kinds: [ResourceKind::Process].into(),
            })
            .collect();
        let bound = requested
            .independent
            .iter()
            .filter(|id| *id == "sensor")
            .map(|id| BoundGrant {
                security: source.security.clone(),
                resource: ResourceRef {
                    id: id.clone(),
                    kind: ResourceKind::Sensor as i32,
                },
            })
            .collect();
        Ok((roots, bound))
    }
    async fn ready(&self) -> bool {
        true
    }
}

async fn server(
    authority: Arc<dyn Authority>,
    sink: Arc<TestSink>,
    limits: Limits,
) -> (
    MetricsServiceClient<tonic::transport::Channel>,
    String,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let router = configured_router(authority, sink, limits, 1).await.unwrap();
    let task = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(
                tokio_stream::wrappers::TcpListenerStream::new(listener),
                async {
                    let _ = stopped.await;
                },
            )
            .await
            .unwrap();
    });
    let client = MetricsServiceClient::connect(endpoint.clone())
        .await
        .unwrap();
    (client, endpoint, stop, task)
}

fn body() -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![Metric {
                    name: "custom.value".into(),
                    data: Some(metric::Data::Gauge(Gauge {
                        data_points: vec![NumberDataPoint {
                            time_unix_nano: 1,
                            value: Some(number_data_point::Value::AsInt(i64::MAX)),
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
fn request(body: ExportMetricsServiceRequest) -> Request<ExportMetricsServiceRequest> {
    let mut request = Request::new(body);
    request
        .metadata_mut()
        .insert("authorization", "Bearer test".parse().unwrap());
    request
}
fn string(key: &str, value: &str) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.into())),
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn whole_request_preflight_precedes_publication_and_success_follows_confirmation() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let limits = Limits {
        normalized_record_bytes: 64,
        ..Default::default()
    };
    let (mut client, _, stop, task) = server(authority.clone(), sink.clone(), limits).await;
    let error = client.export(request(body())).await.unwrap_err();
    assert_eq!(error.code(), Code::ResourceExhausted);
    assert!(error.details().is_empty());
    assert!(sink.records.lock().unwrap().is_empty());
    assert_eq!(authority.grant_count.load(Ordering::SeqCst), 1);
    stop.send(()).unwrap();
    task.await.unwrap();

    let (mut client, _, stop, task) = server(authority, sink.clone(), Limits::default()).await;
    sink.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        client.export(request(body())).await.unwrap_err().code(),
        Code::Unavailable
    );
    sink.fail.store(false, Ordering::SeqCst);
    client.export(request(body())).await.unwrap();
    let raw = sink.records.lock().unwrap()[0].clone();
    assert_eq!(raw.security.unwrap().source_id, "source");
    assert_eq!(
        raw.bindings[0]
            .context
            .as_ref()
            .unwrap()
            .resource
            .as_ref()
            .unwrap()
            .id,
        "node"
    );
    let points = validate::raw(&sink.records.lock().unwrap()[0], Limits::default()).unwrap();
    assert_eq!(points[0].int_value, Some(i64::MAX));
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn delivery_diagnostics_preserve_claims_but_never_trust_forwarded_sender_addresses() {
    let sink = Arc::new(TestSink::default());
    let (mut client, _, stop, task) = server(
        Arc::new(TestAuthority::default()),
        sink.clone(),
        Limits::default(),
    )
    .await;
    let connection = CollectorConnection {
        connection_id: "reported-connection".into(),
        connected_unix_nano: 1,
        local_address: "10.0.0.2:42000".into(),
        peer_address: "10.0.0.1:4317".into(),
        inventory_observed_unix_nano: 1,
        architecture: "aarch64".into(),
        inventory_status: "unavailable".into(),
        ..Default::default()
    };
    let binary = tonic::metadata::MetadataValue::from_bytes(&connection.encode_to_vec());
    let mut accepted = request(body());
    accepted
        .metadata_mut()
        .insert_bin(delivery_diagnostics::HEADER, binary.clone());
    accepted
        .metadata_mut()
        .insert("x-forwarded-for", "198.51.100.99".parse().unwrap());
    accepted
        .metadata_mut()
        .insert("forwarded", "for=198.51.100.99".parse().unwrap());
    client.export(accepted).await.unwrap();
    let raw = sink.records.lock().unwrap()[0].clone();
    let observation = raw.delivery.as_ref().unwrap();
    assert_eq!(observation.collector.as_ref(), Some(&connection));
    let peer = observation
        .ingestion_peer_address
        .as_ref()
        .unwrap()
        .parse::<std::net::SocketAddr>()
        .unwrap();
    assert!(peer.ip().is_loopback());
    let points = validate::retained_raw(&raw, Limits::default()).unwrap();
    let context = PointLineage::decode(points[0].lineage.as_slice())
        .unwrap()
        .delivery
        .unwrap();
    assert_eq!(
        context.ingestion_peer_address,
        observation.ingestion_peer_address
    );
    assert_eq!(
        context.collector_connection_id.as_deref(),
        Some("reported-connection")
    );
    assert_eq!(
        context.collector_local_address.as_deref(),
        Some("10.0.0.2:42000")
    );

    let mut duplicate = request(body());
    duplicate
        .metadata_mut()
        .append_bin(delivery_diagnostics::HEADER, binary.clone());
    duplicate
        .metadata_mut()
        .append_bin(delivery_diagnostics::HEADER, binary);
    assert_eq!(
        client.export(duplicate).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    let mut oversized = request(body());
    oversized.metadata_mut().insert_bin(
        delivery_diagnostics::HEADER,
        tonic::metadata::MetadataValue::from_bytes(&vec![
            0;
            delivery_diagnostics::MAX_CONNECTION_BYTES
                + 1
        ]),
    );
    assert_eq!(
        client.export(oversized).await.unwrap_err().code(),
        Code::ResourceExhausted
    );
    assert_eq!(sink.records.lock().unwrap().len(), 1);
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn authentication_empty_requests_metadata_and_expiry_remain_fail_closed() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let (mut client, _, stop, task) =
        server(authority.clone(), sink.clone(), Limits::default()).await;
    assert_eq!(
        client.export(body()).await.unwrap_err().code(),
        Code::Unauthenticated
    );
    assert_eq!(authority.grant_count.load(Ordering::SeqCst), 0);
    client
        .export(request(ExportMetricsServiceRequest::default()))
        .await
        .unwrap();
    assert_eq!(authority.grant_count.load(Ordering::SeqCst), 1);
    let mut duplicate = request(body());
    duplicate
        .metadata_mut()
        .append(metadata::BATCH_ID, "one".parse().unwrap());
    duplicate
        .metadata_mut()
        .append(metadata::BATCH_ID, "two".parse().unwrap());
    assert_eq!(
        client.export(duplicate).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    let mut expired = request(body());
    expired
        .metadata_mut()
        .insert(metadata::BATCH_ID, "immutable-token".parse().unwrap());
    expired
        .metadata_mut()
        .insert(metadata::BATCH_CREATED, "1".parse().unwrap());
    assert_eq!(
        client.export(expired).await.unwrap_err().code(),
        Code::FailedPrecondition
    );
    let mut future = request(body());
    future
        .metadata_mut()
        .insert(metadata::BATCH_ID, "immutable-token".parse().unwrap());
    future.metadata_mut().insert(
        metadata::BATCH_CREATED,
        u64::MAX.to_string().parse().unwrap(),
    );
    assert_eq!(
        client.export(future).await.unwrap_err().code(),
        Code::InvalidArgument
    );
    assert!(sink.records.lock().unwrap().is_empty());
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn global_admission_rejects_a_second_connection_before_authentication_or_decode() {
    let authority = Arc::new(TestAuthority::default());
    authority.blocked.store(true, Ordering::SeqCst);
    let sink = Arc::new(TestSink::default());
    let (mut first, endpoint, stop, task) =
        server(authority.clone(), sink, Limits::default()).await;
    let pending = tokio::spawn(async move { first.export(request(body())).await });
    authority.entered.notified().await;
    let mut second = MetricsServiceClient::connect(endpoint)
        .await
        .unwrap()
        .send_compressed(CompressionEncoding::Gzip);
    // A highly compressible body with many empty generated containers. The service
    // must reject it before decoding, not rely on semantic post-decode accounting.
    let adversarial = ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics::default(); 100_000],
    };
    assert_eq!(
        second
            .export(request(adversarial))
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    assert_eq!(authority.authenticate_count.load(Ordering::SeqCst), 1);
    authority.blocked.store(false, Ordering::SeqCst);
    authority.release.notify_one();
    pending.await.unwrap().unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn compressed_decompressed_and_normalized_limits_are_terminal_without_publication() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let limits = Limits {
        decoded_bytes: 1024,
        ..Default::default()
    };
    let (mut client, _, stop, task) = server(authority.clone(), sink.clone(), limits).await;
    let mut large = body();
    large.resource_metrics[0].resource = Some(Resource {
        attributes: vec![string("large", &"x".repeat(8192))],
        ..Default::default()
    });
    for gzip in [false, true] {
        let mut client = if gzip {
            client.clone().send_compressed(CompressionEncoding::Gzip)
        } else {
            client.clone()
        };
        let status = client.export(request(large.clone())).await.unwrap_err();
        assert_eq!(status.code(), Code::ResourceExhausted);
        assert!(status.details().is_empty());
    }
    assert_eq!(authority.authenticate_count.load(Ordering::SeqCst), 0);
    assert!(sink.records.lock().unwrap().is_empty());
    client.export(request(body())).await.unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn root_local_and_independent_claims_never_delegate_from_payload_topology() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let (mut client, _, stop, task) =
        server(authority.clone(), sink.clone(), Limits::default()).await;
    let mut sensor = body();
    sensor.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("recount.resource.id", "sensor"),
            string("recount.resource.kind", "sensor"),
            string("parent.id", "node"),
        ],
        ..Default::default()
    });
    client.export(request(sensor.clone())).await.unwrap();
    sensor.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes[0] = string("recount.resource.id", "unbound");
    assert_eq!(
        client.export(request(sensor)).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    let mut linux = body();
    linux.resource_metrics[0].scope_metrics[0].metrics[0].name =
        "recount.process.memory.rss".into();
    linux.resource_metrics[0].scope_metrics[0].metrics[0].unit = "By".into();
    linux.resource_metrics[0].resource = Some(Resource {
        attributes: vec![
            string("host.id", "node"),
            string(
                "recount.host.boot_id",
                "01234567-89ab-cdef-0123-456789abcdef",
            ),
            string("recount.collection.epoch_id", "epoch"),
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
    let created = unix_nanos().unwrap().to_string();
    for _ in 0..2 {
        let mut req = request(linux.clone());
        req.metadata_mut()
            .insert(metadata::PROFILE, "linux".parse().unwrap());
        req.metadata_mut()
            .insert(metadata::BATCH_ID, "immutable-linux".parse().unwrap());
        req.metadata_mut()
            .insert(metadata::BATCH_CREATED, created.parse().unwrap());
        client.export(req).await.unwrap();
    }
    {
        let records = sink.records.lock().unwrap();
        assert_eq!(records[1].bindings, records[2].bindings);
        assert!(
            records[1].bindings[0]
                .context
                .as_ref()
                .unwrap()
                .resource
                .as_ref()
                .unwrap()
                .id
                .starts_with("recount.local.")
        );
    }
    authority.deny.store(true, Ordering::SeqCst);
    assert_eq!(
        client.export(request(body())).await.unwrap_err().code(),
        Code::PermissionDenied
    );
    stop.send(()).unwrap();
    task.await.unwrap();
}

struct RawCodec;
struct RawEncoder;
struct ResponseDecoder;
impl tonic::codec::Codec for RawCodec {
    type Encode = Vec<u8>;
    type Decode = ExportMetricsServiceResponse;
    type Encoder = RawEncoder;
    type Decoder = ResponseDecoder;
    fn encoder(&mut self) -> Self::Encoder {
        RawEncoder
    }
    fn decoder(&mut self) -> Self::Decoder {
        ResponseDecoder
    }
}
impl tonic::codec::Encoder for RawEncoder {
    type Item = Vec<u8>;
    type Error = Status;
    fn encode(
        &mut self,
        item: Self::Item,
        destination: &mut tonic::codec::EncodeBuf<'_>,
    ) -> std::result::Result<(), Status> {
        prost::bytes::BufMut::put_slice(destination, &item);
        Ok(())
    }
}
impl tonic::codec::Decoder for ResponseDecoder {
    type Item = ExportMetricsServiceResponse;
    type Error = Status;
    fn decode(
        &mut self,
        source: &mut tonic::codec::DecodeBuf<'_>,
    ) -> std::result::Result<Option<Self::Item>, Status> {
        ExportMetricsServiceResponse::decode(source)
            .map(Some)
            .map_err(|_| Status::internal("Invalid test response"))
    }
}

#[tokio::test]
async fn unsupported_traces_are_unimplemented_without_decode_authentication_or_publication() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let limits = Limits {
        decoded_bytes: 1024,
        ..Default::default()
    };
    let (mut metrics, endpoint, stop, task) = server(authority.clone(), sink.clone(), limits).await;
    let channel = tonic::transport::Endpoint::from_shared(endpoint)
        .unwrap()
        .connect()
        .await
        .unwrap();
    for gzip in [false, true] {
        let mut client = tonic::client::Grpc::new(channel.clone());
        if gzip {
            client = client.send_compressed(CompressionEncoding::Gzip);
        }
        // Unsupported services are rejected before decoding or decompression,
        // including malformed Protobuf and bodies above the metrics limit.
        for payload in [vec![], vec![0xff], vec![0; 2048]] {
            client.ready().await.unwrap();
            let error = client
                .unary(
                    Request::new(payload),
                    tonic::codegen::http::uri::PathAndQuery::from_static(
                        "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
                    ),
                    RawCodec,
                )
                .await
                .unwrap_err();
            assert_eq!(error.code(), Code::Unimplemented);
        }
    }
    let mut health = tonic_health::pb::health_client::HealthClient::new(channel);
    let response = health
        .check(tonic_health::pb::HealthCheckRequest {
            service: "opentelemetry.proto.collector.trace.v1.TraceService".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        response.into_inner().status,
        tonic_health::pb::health_check_response::ServingStatus::NotServing as i32
    );
    assert_eq!(authority.authenticate_count.load(Ordering::SeqCst), 0);
    assert_eq!(authority.grant_count.load(Ordering::SeqCst), 0);
    assert!(sink.records.lock().unwrap().is_empty());
    metrics.export(request(body())).await.unwrap();
    assert_eq!(sink.records.lock().unwrap().len(), 1);
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn admitted_near_wire_limit_empty_containers_are_bounded_after_decode() {
    let authority = Arc::new(TestAuthority::default());
    let sink = Arc::new(TestSink::default());
    let (_, endpoint, stop, task) =
        server(authority.clone(), sink.clone(), Limits::default()).await;
    let channel = tonic::transport::Endpoint::from_shared(endpoint)
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut client = tonic::client::Grpc::new(channel).send_compressed(CompressionEncoding::Gzip);
    client.ready().await.unwrap();
    // Standard Protobuf fixture: repeated empty ResourceMetrics messages. Raw
    // encoding avoids allocating a second large generated object on the client.
    let payload = [0x0a_u8, 0].repeat((Limits::default().decoded_bytes - 2) / 2);
    let mut req = Request::new(payload);
    req.metadata_mut()
        .insert("authorization", "Bearer test".parse().unwrap());
    let error = client
        .unary(
            req,
            tonic::codegen::http::uri::PathAndQuery::from_static(
                "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
            ),
            RawCodec,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), Code::ResourceExhausted);
    assert!(error.details().is_empty());
    assert_eq!(authority.authenticate_count.load(Ordering::SeqCst), 1);
    assert_eq!(authority.grant_count.load(Ordering::SeqCst), 0);
    assert!(sink.records.lock().unwrap().is_empty());
    stop.send(()).unwrap();
    task.await.unwrap();
}
