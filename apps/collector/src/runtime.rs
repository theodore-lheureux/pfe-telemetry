use std::{
    io,
    sync::Arc,
    time::{Duration, Instant},
};

use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use prost::Message;
use recount_telemetry_validation::{
    catalogue::{self, Adapter},
    metadata::{BATCH_CREATED, BATCH_ID, PROFILE},
};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::MissedTickBehavior;
use tonic::transport::Endpoint;

use crate::{
    LossReason, LossTracker, Scan,
    config::{Config, ExportConfig, queue_destination},
    delivery::ScanContents,
    enrollment::{self, Authorization},
    point_count,
    spool::{Batch, MAX_REQUEST_BYTES, Result, Spool, unix_nanos},
    transport::Client,
};

type SharedSpool = Arc<tokio::sync::Mutex<Spool>>;
const PENDING_SCANS: usize = 64;

pub async fn run(config: Config) -> Result<()> {
    let sampler_config = config.sampling();
    let ExportConfig {
        endpoint,
        enrollment,
    } = config.export()?;
    let (node, authorization) = match enrollment {
        Some(enrollment) => {
            let machine_id = crate::linux::host_id_or_machine_id(config.host_id.clone())?;
            // First enrollment retries until the web application answers.
            let (node, authorization) = tokio::select! {
                started = enrollment::start(enrollment, &machine_id) => started?,
                () = shutdown_signal()? => return Ok(()),
            };
            (Some(node), Some(authorization))
        }
        None => (None, None),
    };
    let queue_destination = queue_destination(&config.endpoint, node);
    let Config {
        interval_ms,
        queue_max_bytes: max_bytes,
        queue_max_batches: max_batches,
        queue_max_age_seconds,
        queue_directory: directory,
        drain,
        ..
    } = config;
    let period = Duration::from_millis(interval_ms);
    let max_age = Duration::from_secs(queue_max_age_seconds);
    let mut spool = Spool::open(&directory, &queue_destination, max_bytes, max_batches).await?;
    let (pending_bytes, pending_batches) = spool.usage().await?;
    let discarded_points = spool.discarded_points().await?;
    tracing::info!(
        pending_bytes,
        pending_batches,
        discarded_points,
        "Opened persistent export queue"
    );
    let spool = Arc::new(tokio::sync::Mutex::new(spool));
    let client = client(endpoint);
    let loss = LossTracker::default();
    if drain {
        let (_stop, stopped) = watch::channel(false);
        let result = tokio::select! {
            result = export(client, spool.clone(), loss, max_age, None, stopped, authorization) => result,
            () = shutdown_signal()? => Ok(()),
        };
        spool.lock().await.close_connection().await?;
        return result;
    }
    let feedback = loss.clone();
    let collector =
        tokio::task::spawn_blocking(move || crate::Collector::new(sampler_config, feedback))
            .await??;
    let shutdown = shutdown_signal()?;
    let (stop, stopped) = watch::channel(false);
    let notify = Arc::new(Notify::new());
    let (scans, waiting) = mpsc::channel(PENDING_SCANS);
    let mut tasks = JoinSet::new();
    tasks.spawn(sample(collector, period, scans, stopped.clone()));
    tasks.spawn(persist(
        waiting,
        spool.clone(),
        loss.clone(),
        notify.clone(),
    ));
    tasks.spawn(export(
        client,
        spool.clone(),
        loss,
        max_age,
        Some(notify),
        stopped,
        authorization,
    ));
    tracing::info!(
        interval_ms,
        max_bytes,
        max_batches,
        "Starting Linux resource collection"
    );
    let (_running, cancelled) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(supervise(tasks, stop, spool, async move {
        tokio::select! { () = shutdown => {}, _ = cancelled => {} }
    }))
    .await?
}

async fn supervise(
    mut tasks: JoinSet<Result<()>>,
    stop: watch::Sender<bool>,
    spool: SharedSpool,
    shutdown: impl Future<Output = ()>,
) -> Result<()> {
    let mut result = tokio::select! {
        () = shutdown => Ok(()),
        Some(ended) = tasks.join_next() => ended.unwrap_or_else(|error| Err(error.into())),
    };
    stop.send_replace(true);
    // Stop acquisition, drain the bounded volatile buffer to disk, and leave
    // cancelled network requests pending. A slow disk can delay graceful exit.
    while let Some(ended) = tasks.join_next().await {
        let ended = ended.unwrap_or_else(|error| Err(error.into()));
        // Keep the first worker error, including panics, ahead of close errors.
        if result.is_ok() {
            result = ended;
        }
    }
    let closed = spool.lock().await.close_connection().await;
    result?;
    closed?;
    tracing::info!("Stopped collection; pending exports retained");
    Ok(())
}

fn client(endpoint: Endpoint) -> Client {
    Client::new(endpoint)
}

async fn sample(
    mut collector: crate::Collector,
    period: Duration,
    sender: mpsc::Sender<Scan>,
    mut stopped: watch::Receiver<bool>,
) -> Result<()> {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut previous_tick = None;
    loop {
        let tick = tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            tick = interval.tick() => tick,
        };
        let missed = previous_tick.is_some_and(|previous| tick.duration_since(previous) > period)
            || tokio::time::Instant::now().duration_since(tick) >= period;
        previous_tick = Some(tick);
        let (returned, scan) = tokio::task::spawn_blocking(move || -> Result<_> {
            if missed {
                collector.missed_cycle();
            }
            let scan = collector.sample()?;
            Ok((collector, scan))
        })
        .await??;
        collector = returned;
        if let Some(scan) = scan {
            match sender.try_send(scan) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(scan)) => scan.discard(LossReason::BufferFull),
                Err(mpsc::error::TrySendError::Closed(_)) => return Ok(()),
            }
        }
    }
}

async fn persist(
    mut scans: mpsc::Receiver<Scan>,
    spool: SharedSpool,
    loss: LossTracker,
    notify: Arc<Notify>,
) -> Result<()> {
    while let Some(scan) = scans.recv().await {
        enqueue_scan(&mut *spool.lock().await, scan, &loss).await?;
        notify.notify_one();
    }
    Ok(())
}

async fn enqueue_scan(spool: &mut Spool, scan: Scan, loss: &LossTracker) -> Result<()> {
    if scan.generation() != loss.generation() {
        let epoch = scan.epoch().to_owned();
        let contents = scan.into_contents();
        spool
            .record_loss(
                &epoch,
                LossReason::BufferExpired,
                contents.point_count(),
                loss,
            )
            .await?;
        return Ok(());
    }
    let epoch = scan.epoch().to_owned();
    enqueue_contents(spool, &epoch, scan.into_contents(), loss, MAX_REQUEST_BYTES).await
}

async fn enqueue_contents(
    spool: &mut Spool,
    epoch: &str,
    contents: ScanContents,
    loss: &LossTracker,
    max_request_bytes: usize,
) -> Result<()> {
    let ScanContents {
        measurements,
        window,
        diagnostics,
    } = contents;
    let window_size = window.encoded_len() + 16;
    let mut request = ExportMetricsServiceRequest {
        resource_metrics: vec![window.clone()],
    };
    let mut size = window_size;
    for resource in measurements.into_iter().chain(std::iter::once(diagnostics)) {
        let resource_size = resource.encoded_len() + 16;
        if resource_size + window_size > max_request_bytes {
            spool
                .record_loss(
                    epoch,
                    LossReason::PermanentRejection,
                    point_count(std::slice::from_ref(&resource)),
                    loss,
                )
                .await?;
            continue;
        }
        if size + resource_size > max_request_bytes {
            enqueue_request(spool, epoch, request, loss).await?;
            request = ExportMetricsServiceRequest {
                resource_metrics: vec![window.clone()],
            };
            size = window_size;
        }
        size += resource_size;
        request.resource_metrics.push(resource);
    }
    if request.resource_metrics.len() > 1 {
        enqueue_request(spool, epoch, request, loss).await?;
    }
    Ok(())
}

async fn enqueue_request(
    spool: &mut Spool,
    epoch: &str,
    request: ExportMetricsServiceRequest,
    loss: &LossTracker,
) -> Result<()> {
    recount_telemetry_validation::validate::request(
        &request,
        recount_telemetry_validation::validate::Limits {
            decoded_bytes: MAX_REQUEST_BYTES,
            ..Default::default()
        },
    )?;
    for metric in request
        .resource_metrics
        .iter()
        .flat_map(|r| &r.scope_metrics)
        .flat_map(|s| &s.metrics)
    {
        catalogue::validate_adapter_metric(metric, Adapter::Linux)?;
    }
    let points = point_count(&request.resource_metrics);
    let batch = Batch::new(epoch.into(), request, points)?;
    spool.enqueue(&batch, loss).await?;
    Ok(())
}

// OTLP's exact retry table; RESOURCE_EXHAUSTED additionally needs RetryInfo.
fn retry_delay(status: &tonic::Status) -> Option<Duration> {
    // Locally generated connection errors can be wrapped as UNKNOWN. Wire
    // statuses have no underlying local error and follow the OTLP table below.
    if status.code() == tonic::Code::Unknown && std::error::Error::source(status).is_some() {
        return Some(Duration::ZERO);
    }
    let retry_info = tonic_types::pb::Status::decode(status.details())
        .ok()
        .and_then(|details| {
            details
                .details
                .into_iter()
                .find(|detail| detail.type_url.rsplit('/').next() == Some("google.rpc.RetryInfo"))
                .and_then(|detail| tonic_types::pb::RetryInfo::decode(detail.value.as_slice()).ok())
        });
    let delay = retry_info
        .as_ref()
        .and_then(|info| info.retry_delay.as_ref())
        .and_then(|delay| {
            (delay.seconds >= 0 && (0..1_000_000_000).contains(&delay.nanos))
                .then(|| Duration::new(delay.seconds as u64, delay.nanos as u32))
        });
    match status.code() {
        tonic::Code::Cancelled
        | tonic::Code::DeadlineExceeded
        | tonic::Code::Aborted
        | tonic::Code::OutOfRange
        | tonic::Code::Unavailable
        | tonic::Code::DataLoss => Some(delay.unwrap_or_default()),
        tonic::Code::ResourceExhausted if retry_info.is_some() => Some(delay.unwrap_or_default()),
        _ => None,
    }
}

fn backoff(attempt: u32) -> Duration {
    let ceiling = (1u64 << attempt.min(5)).min(30) * 1000;
    // Equal jitter in [ceiling/2, ceiling], bounded at 30 seconds.
    let random = uuid::Uuid::now_v7().as_u128() as u64;
    Duration::from_millis(ceiling / 2 + random % (ceiling / 2 + 1))
}

async fn export(
    mut client: Client,
    spool: SharedSpool,
    loss: LossTracker,
    max_age: Duration,
    notify: Option<Arc<Notify>>,
    mut stopped: watch::Receiver<bool>,
    mut authorization: Option<Authorization>,
) -> Result<()> {
    loop {
        if *stopped.borrow() {
            return Ok(());
        }
        let batch = spool.lock().await.front().await?;
        let Some(batch) = batch else {
            let Some(notify) = &notify else {
                tracing::info!("Persistent export queue is empty");
                return Ok(());
            };
            tokio::select! { _ = stopped.changed() => return Ok(()), () = notify.notified() => {} }
            continue;
        };
        let lifetime = Instant::now();
        let remaining = max_age.saturating_sub(Duration::from_nanos(
            unix_nanos()?.saturating_sub(batch.created_ns),
        ));
        let mut attempt = 0;
        let discarded = loop {
            if *stopped.borrow() {
                return Ok(());
            }
            if lifetime.elapsed() >= remaining
                || batch.expired(unix_nanos()?, max_age.as_nanos() as u64)
            {
                break Some((LossReason::BufferExpired, batch.points));
            }
            let mut request = request(&batch)?;
            if let Some(authorization) = &mut authorization {
                // Without a current token, wait for renewal within the batch's lifetime.
                let Some(value) = authorization.current() else {
                    tokio::select! {
                        biased;
                        _ = stopped.changed() => return Ok(()),
                        () = authorization.changed() => {}
                        () = tokio::time::sleep(remaining.saturating_sub(lifetime.elapsed())) => {}
                    }
                    continue;
                };
                request.metadata_mut().insert("authorization", value);
            }
            let result = tokio::select! {
                biased;
                _ = stopped.changed() => return Ok(()),
                result = tokio::time::timeout(remaining.saturating_sub(lifetime.elapsed()), client.export(request)) => result,
            };
            match result {
                Ok(Ok(response)) => {
                    let rejected = response
                        .into_inner()
                        .partial_success
                        .map_or(0, |partial| partial.rejected_data_points);
                    if rejected != 0 {
                        let rejected = u64::try_from(rejected)
                            .unwrap_or(batch.points)
                            .min(batch.points);
                        break Some((LossReason::PermanentRejection, rejected));
                    }
                    break None;
                }
                Ok(Err(status)) => {
                    // A refused token is renewed and the unchanged batch retried.
                    let refused = status.code() == tonic::Code::Unauthenticated
                        && authorization.as_ref().inspect(|a| a.reject()).is_some();
                    let Some(server_delay) =
                        retry_delay(&status).or(refused.then_some(Duration::ZERO))
                    else {
                        tracing::warn!(code=?status.code(), "Batch permanently rejected");
                        break Some((LossReason::PermanentRejection, batch.points));
                    };
                    let delay = backoff(attempt)
                        .max(server_delay)
                        .min(remaining.saturating_sub(lifetime.elapsed()));
                    tracing::warn!(code=?status.code(), attempt, retry_ms=delay.as_millis(), "Export pending; retrying unchanged batch");
                    attempt = attempt.saturating_add(1);
                    tokio::select! { _ = stopped.changed() => return Ok(()), () = tokio::time::sleep(delay) => {} }
                }
                Err(_) => break Some((LossReason::BufferExpired, batch.points)),
            }
        };
        spool.lock().await.finish(&batch, discarded, &loss).await?;
    }
}

fn request(batch: &Batch) -> Result<tonic::Request<ExportMetricsServiceRequest>> {
    let mut request = tonic::Request::new(ExportMetricsServiceRequest::decode(
        batch.payload.as_slice(),
    )?);
    request.metadata_mut().insert(BATCH_ID, batch.id.parse()?);
    request
        .metadata_mut()
        .insert(BATCH_CREATED, batch.created_ns.to_string().parse()?);
    request.metadata_mut().insert(PROFILE, "linux".parse()?);
    Ok(request)
}

fn shutdown_signal() -> io::Result<impl Future<Output = ()>> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CollectorConfig,
        metrics::{gauge, point, resource, string},
    };
    use clap::Parser;
    use opentelemetry_proto::tonic::collector::metrics::v1::{
        ExportMetricsPartialSuccess, ExportMetricsServiceResponse,
        metrics_service_server::{MetricsService, MetricsServiceServer},
    };
    use opentelemetry_proto::tonic::metrics::v1::{ResourceMetrics, number_data_point::Value};
    use recount_telemetry_validation::delivery::{self, CollectorConnection};
    use std::{net::SocketAddr, path::PathBuf, sync::Mutex};
    use tokio::{
        io::copy_bidirectional,
        net::{TcpListener, TcpStream},
    };
    use tonic::{Request, Response, Status, codec::CompressionEncoding};
    use tonic_types::{ErrorDetails, RetryInfo, StatusExt};

    #[derive(Clone, Default)]
    struct Receiver(Arc<Mutex<ReceiverState>>);
    #[derive(Default)]
    struct ReceiverState {
        requests: Vec<(String, String, Vec<u8>)>,
        connections: Vec<CollectorConnection>,
        peer_addresses: Vec<SocketAddr>,
        unavailable: bool,
        rejected: bool,
        partial: bool,
        authorization: Option<String>,
    }
    #[tonic::async_trait]
    impl MetricsService for Receiver {
        async fn export(
            &self,
            request: Request<ExportMetricsServiceRequest>,
        ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
            if let Some(expected) = &self.0.lock().unwrap().authorization
                && request
                    .metadata()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    != Some(expected.as_str())
            {
                return Err(Status::unauthenticated("Invalid collector credentials"));
            }
            let id = request
                .metadata()
                .get("recount-batch-id")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            let time = request
                .metadata()
                .get("recount-batch-created-unix-nano")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            assert_eq!(
                request
                    .metadata()
                    .get("recount-collection-profile")
                    .unwrap(),
                "linux"
            );
            let connection = delivery::decode_connection(
                &request
                    .metadata()
                    .get_bin(delivery::HEADER)
                    .unwrap()
                    .to_bytes()
                    .unwrap(),
            )
            .unwrap();
            let peer = request.remote_addr().unwrap();
            let mut state = self.0.lock().unwrap();
            state.connections.push(connection);
            state.peer_addresses.push(peer);
            state
                .requests
                .push((id, time, request.into_inner().encode_to_vec()));
            if state.unavailable {
                return Err(Status::unavailable(""));
            }
            if state.rejected {
                return Err(Status::invalid_argument(""));
            }
            Ok(Response::new(ExportMetricsServiceResponse {
                partial_success: state.partial.then(|| ExportMetricsPartialSuccess {
                    rejected_data_points: 2,
                    error_message: String::new(),
                }),
            }))
        }
    }

    struct Fixture {
        path: PathBuf,
        spool: SharedSpool,
        loss: LossTracker,
        batch: Batch,
    }
    impl Fixture {
        async fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("recount-runtime-{}", uuid::Uuid::now_v7()));
            let mut spool = Spool::open(&path, "test-receiver", 1024 * 1024, 4)
                .await
                .unwrap();
            let loss = LossTracker::default();
            let request = ExportMetricsServiceRequest {
                resource_metrics: vec![ResourceMetrics {
                    schema_url: "recovery-fixture".into(),
                    ..Default::default()
                }],
            };
            let batch = Batch::new("epoch".into(), request, 3).unwrap();
            spool.enqueue(&batch, &loss).await.unwrap();
            Self {
                path,
                spool: Arc::new(tokio::sync::Mutex::new(spool)),
                loss,
                batch,
            }
        }

        async fn close(&self) {
            self.spool.lock().await.close_connection().await.unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn delivery_observations_follow_the_actual_socket_and_reconnect_without_mutating_the_batch()
     {
        let fixture = Fixture::new().await;
        let receiver = Receiver::default();
        let (endpoint, stop) = server(receiver.clone()).await;
        let mut client = client(endpoint);
        client
            .export(request(&fixture.batch).unwrap())
            .await
            .unwrap();
        client
            .export(request(&fixture.batch).unwrap())
            .await
            .unwrap();
        receiver.0.lock().unwrap().rejected = true;
        assert!(
            client
                .export(request(&fixture.batch).unwrap())
                .await
                .is_err()
        );
        receiver.0.lock().unwrap().rejected = false;
        client
            .export(request(&fixture.batch).unwrap())
            .await
            .unwrap();
        {
            let state = receiver.0.lock().unwrap();
            assert_eq!(state.connections.len(), 4);
            assert_eq!(
                state.connections[0].connection_id,
                state.connections[1].connection_id
            );
            assert_eq!(
                state.connections[1].connection_id,
                state.connections[2].connection_id
            );
            assert_ne!(
                state.connections[2].connection_id,
                state.connections[3].connection_id
            );
            assert!(state.requests.windows(2).all(|r| r[0] == r[1]));
            assert_eq!(state.requests[0].2, fixture.batch.payload);
            assert!(
                state
                    .connections
                    .iter()
                    .zip(&state.peer_addresses)
                    .all(|(connection, peer)| connection.local_address == peer.to_string())
            );
        }
        stop.send(()).unwrap();
        fixture.close().await;
    }

    #[tokio::test]
    async fn dropped_proxy_socket_requires_new_observation_and_preserves_queued_payload() {
        let fixture = Fixture::new().await;
        let receiver = Receiver::default();
        let (backend, stop_backend) = server(receiver.clone()).await;
        let target = backend.uri().authority().unwrap().to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let endpoint = Endpoint::from_shared(format!("http://{proxy_address}")).unwrap();
        let (disconnect, disconnected) = watch::channel(0u64);
        let (stop, mut stopped) = watch::channel(false);
        let released = Arc::new(Notify::new());
        let notified = released.clone();
        let accepted_peers = Arc::new(Mutex::new(Vec::new()));
        let peers = accepted_peers.clone();
        let proxy = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut downstream, peer) = tokio::select! {
                    _ = stopped.changed() => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                peers.lock().unwrap().push(peer);
                let mut dropped = disconnected.clone();
                dropped.borrow_and_update();
                let target = target.clone();
                let released = released.clone();
                connections.spawn(async move {
                    let mut upstream = TcpStream::connect(target).await.unwrap();
                    tokio::select! {
                        _ = dropped.changed() => {},
                        _ = copy_bidirectional(&mut downstream, &mut upstream) => {},
                    }
                    drop(downstream);
                    drop(upstream);
                    released.notify_one();
                });
            }
            connections.shutdown().await;
        });
        let mut client = client(endpoint);
        client
            .export(request(&fixture.batch).unwrap())
            .await
            .unwrap();
        disconnect.send_replace(1);
        tokio::time::timeout(Duration::from_secs(3), notified.notified())
            .await
            .unwrap();
        assert!(
            client
                .export(request(&fixture.batch).unwrap())
                .await
                .is_err()
        );
        client
            .export(request(&fixture.batch).unwrap())
            .await
            .unwrap();
        {
            let state = receiver.0.lock().unwrap();
            let peers = accepted_peers.lock().unwrap();
            assert_eq!(state.connections.len(), 2);
            assert_eq!(peers.len(), 2);
            assert_ne!(
                state.connections[0].connection_id,
                state.connections[1].connection_id
            );
            assert!(
                state
                    .connections
                    .iter()
                    .zip(peers.iter())
                    .all(|(connection, peer)| {
                        connection.local_address == peer.to_string()
                            && connection.peer_address == proxy_address.to_string()
                    })
            );
            assert!(state.requests.iter().all(|r| r.2 == fixture.batch.payload));
        }
        stop.send_replace(true);
        proxy.await.unwrap();
        stop_backend.send(()).unwrap();
        fixture.close().await;
    }

    async fn server(receiver: Receiver) -> (Endpoint, tokio::sync::oneshot::Sender<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(
                    MetricsServiceServer::new(receiver)
                        .accept_compressed(CompressionEncoding::Gzip)
                        .send_compressed(CompressionEncoding::Gzip),
                )
                .serve_with_shutdown(address, async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let endpoint = Endpoint::from_shared(format!("http://{address}")).unwrap();
        for _ in 0..100 {
            if endpoint.connect().await.is_ok() {
                return (endpoint, stop);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Test receiver did not start");
    }
    async fn until(mut condition: impl AsyncFnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !condition().await {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    fn start(
        endpoint: Endpoint,
        fixture: &Fixture,
    ) -> (watch::Sender<bool>, tokio::task::JoinHandle<Result<()>>) {
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(export(
            client(endpoint),
            fixture.spool.clone(),
            fixture.loss.clone(),
            Duration::from_secs(60),
            Some(Arc::new(Notify::new())),
            stopped,
            None,
        ));
        (stop, task)
    }

    fn scan_contents() -> ScanContents {
        let scalar = |definition: &catalogue::Definition, value| {
            gauge(definition, vec![point(value, 200, 0, vec![])])
        };
        ScanContents {
            // A collector-shaped measurement and a window-named diagnostic must
            // not be mistaken for shared window observations.
            measurements: vec![
                resource(
                    vec![string("recount.collection.scope", "collector")],
                    vec![scalar(&catalogue::CLOCK_STATUS, Value::AsInt(1))],
                ),
                resource(
                    vec![string("recount.collection.scope", "node")],
                    vec![scalar(&catalogue::NODE_MEMORY_TOTAL, Value::AsInt(1024))],
                ),
            ],
            window: resource(
                vec![],
                vec![
                    scalar(&catalogue::SCAN_DURATION, Value::AsDouble(0.25)),
                    scalar(&catalogue::CLOCK_STATUS, Value::AsInt(0)),
                ],
            ),
            diagnostics: resource(
                vec![],
                vec![scalar(&catalogue::SCAN_DURATION, Value::AsDouble(0.5))],
            ),
        }
    }

    #[tokio::test]
    async fn requests_repeat_only_explicit_window_in_either_measurement_order() {
        for (reverse, split) in [(false, false), (true, false), (false, true), (true, true)] {
            let fixture = Fixture::new().await;
            let mut spool = fixture.spool.lock().await;
            let pending = spool
                .front()
                .await
                .unwrap()
                .expect("Fixture batch is pending");
            spool.finish(&pending, None, &fixture.loss).await.unwrap();
            let mut contents = scan_contents();
            if reverse {
                contents.measurements.reverse();
            }
            let window = contents.window.clone();
            let expected = contents
                .measurements
                .iter()
                .cloned()
                .chain(std::iter::once(contents.diagnostics.clone()))
                .collect::<Vec<_>>();
            let limit = if split {
                window.encoded_len() + expected.iter().map(Message::encoded_len).max().unwrap() + 32
            } else {
                MAX_REQUEST_BYTES
            };
            enqueue_contents(&mut spool, "epoch", contents, &fixture.loss, limit)
                .await
                .unwrap();
            let mut observed = Vec::new();
            let mut requests = 0;
            while let Some(batch) = spool.front().await.unwrap() {
                let request =
                    ExportMetricsServiceRequest::decode(batch.payload.as_slice()).unwrap();
                assert!(batch.payload.len() <= limit);
                assert_eq!(request.resource_metrics.first(), Some(&window));
                assert!(
                    !request
                        .resource_metrics
                        .iter()
                        .flat_map(|r| &r.scope_metrics)
                        .flat_map(|s| &s.metrics)
                        .any(|m| m.name == "recount.clock.uncertainty")
                );
                observed.extend(request.resource_metrics.into_iter().skip(1));
                requests += 1;
                spool.finish(&batch, None, &fixture.loss).await.unwrap();
            }
            if split {
                assert!(requests > 1);
            } else {
                assert_eq!(requests, 1);
            }
            assert_eq!(observed, expected);
            assert_eq!(fixture.loss.generation(), 0);
            drop(spool);
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn stale_scan_is_discarded_without_changing_pending_bytes() {
        let fixture = Fixture::new().await;
        fixture.loss.start_epoch("epoch");
        let contents = scan_contents();
        let points = contents.point_count();
        let scan = Scan::new(
            "epoch".into(),
            fixture.loss.generation(),
            contents,
            fixture.loss.clone(),
        );
        fixture
            .loss
            .record("epoch", LossReason::PermanentRejection, 1);
        let mut spool = fixture.spool.lock().await;
        enqueue_scan(&mut spool, scan, &fixture.loss).await.unwrap();
        assert_eq!(spool.usage().await.unwrap().1, 1);
        let retained = spool.front().await.unwrap().unwrap();
        assert_eq!(retained.payload, fixture.batch.payload);
        assert_eq!(retained.id, fixture.batch.id);
        assert_eq!(spool.discarded_points().await.unwrap(), points);
        assert_eq!(fixture.loss.snapshot(), (2, [0, points, 1]));
        drop(spool);
        fixture.close().await;
    }

    #[tokio::test]
    async fn oversized_measurement_loss_keeps_window_and_other_resources() {
        let fixture = Fixture::new().await;
        let mut spool = fixture.spool.lock().await;
        let pending = spool
            .front()
            .await
            .unwrap()
            .expect("Fixture batch is pending");
        spool.finish(&pending, None, &fixture.loss).await.unwrap();
        let mut contents = scan_contents();
        let limit = contents.window.encoded_len()
            + contents
                .measurements
                .iter()
                .map(Message::encoded_len)
                .max()
                .unwrap()
            + 32;
        contents.measurements[0].schema_url = "x".repeat(limit);
        let dropped = point_count(&contents.measurements[..1]);
        let window = contents.window.clone();
        enqueue_contents(&mut spool, "epoch", contents, &fixture.loss, limit)
            .await
            .unwrap();
        assert_eq!(spool.discarded_points().await.unwrap(), dropped);
        let mut retained_points = 0;
        while let Some(batch) = spool.front().await.unwrap() {
            let request = ExportMetricsServiceRequest::decode(batch.payload.as_slice()).unwrap();
            assert_eq!(request.resource_metrics.first(), Some(&window));
            retained_points += point_count(&request.resource_metrics[1..]);
            spool.finish(&batch, None, &fixture.loss).await.unwrap();
        }
        assert_eq!(retained_points, 2);
        drop(spool);
        fixture.close().await;
    }

    #[tokio::test]
    async fn supervisor_drains_scans_and_closes_queue_after_shutdown_error_or_panic() {
        for ending in ["shutdown", "completion", "error", "panic", "drain-error"] {
            let fixture = Fixture::new().await;
            fixture.close().await;
            *fixture.spool.lock().await =
                Spool::open(&fixture.path, "test-receiver", 1024 * 1024, 64)
                    .await
                    .unwrap();
            let held = fixture.spool.lock().await;
            let period = Duration::from_millis(100);
            let collector = crate::Collector::new(
                CollectorConfig {
                    interval: period,
                    host_id: Some("test-host".into()),
                    namespace_id: Some("test-namespace".into()),
                    host_visibility: false,
                },
                fixture.loss.clone(),
            )
            .unwrap();
            let (sender, receiver) = mpsc::channel(PENDING_SCANS);
            let probe = sender.clone();
            let (stop, stopped) = watch::channel(false);
            let mut tasks = JoinSet::new();
            tasks.spawn(sample(collector, period, sender, stopped.clone()));
            tasks.spawn(persist(
                receiver,
                fixture.spool.clone(),
                fixture.loss.clone(),
                Arc::new(Notify::new()),
            ));
            let (trigger, triggered) = tokio::sync::oneshot::channel();
            let (shutdown, shutdown_requested) = tokio::sync::oneshot::channel();
            if ending == "drain-error" {
                let mut stopped = stopped.clone();
                tasks.spawn(async move {
                    stopped.changed().await.unwrap();
                    Err(io::Error::other("worker failure").into())
                });
            } else if ending != "shutdown" {
                tasks.spawn(async move {
                    triggered.await.unwrap();
                    assert_ne!(ending, "panic", "worker panic");
                    if ending == "completion" {
                        Ok(())
                    } else {
                        Err(io::Error::other("worker failure").into())
                    }
                });
            }
            let supervisor =
                tokio::spawn(supervise(tasks, stop, fixture.spool.clone(), async move {
                    let _ = shutdown_requested.await;
                }));
            until(async || probe.capacity() <= PENDING_SCANS - 3).await;
            if matches!(ending, "shutdown" | "drain-error") {
                shutdown.send(()).unwrap();
            } else {
                trigger.send(()).unwrap();
            }
            until(async || *stopped.borrow()).await;
            let queued = PENDING_SCANS - probe.capacity();
            drop(probe);
            assert!(!supervisor.is_finished());
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(10), supervisor)
                .await
                .unwrap()
                .unwrap();
            match ending {
                "shutdown" | "completion" => result.unwrap(),
                "error" | "drain-error" => {
                    assert_eq!(result.unwrap_err().to_string(), "worker failure");
                }
                _ => assert!(result.unwrap_err().to_string().contains("worker panic")),
            }
            // Reopening proves the supervisor closed and released the queue only
            // after the volatile scans were committed; the original batch survives.
            let mut reopened = Spool::open(&fixture.path, "test-receiver", 1024 * 1024, 64)
                .await
                .unwrap();
            assert!(reopened.usage().await.unwrap().1 > queued as u64);
            assert_eq!(
                reopened.front().await.unwrap().unwrap().id,
                fixture.batch.id
            );
            reopened.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn supervisor_preserves_the_first_failure_while_joining_failed_survivors() {
        let fixture = Fixture::new().await;
        let (stop, mut stopped) = watch::channel(false);
        let mut tasks = JoinSet::new();
        tasks.spawn(async { Err(io::Error::other("initial failure").into()) });
        tasks.spawn(async move {
            stopped.changed().await.unwrap();
            Err(io::Error::other("drain failure").into())
        });
        let error = supervise(tasks, stop, fixture.spool.clone(), std::future::pending())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "initial failure");
        let mut reopened = Spool::open(&fixture.path, "test-receiver", 1024 * 1024, 4)
            .await
            .unwrap();
        assert_eq!(
            reopened.front().await.unwrap().unwrap().id,
            fixture.batch.id
        );
        reopened.close().await.unwrap();
    }

    #[tokio::test]
    async fn cancelling_run_stops_workers_and_releases_the_queue_for_replay() {
        let path = std::env::temp_dir().join(format!("recount-cancel-{}", uuid::Uuid::now_v7()));
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().unavailable = true;
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let config = Config::try_parse_from([
            "collector",
            "--endpoint",
            &endpoint.uri().to_string(),
            "--queue-directory",
            path.to_str().unwrap(),
            "--interval-ms",
            "100",
            "--host-id",
            "test-host",
            "--process-namespace-id",
            "test-namespace",
        ])
        .unwrap();
        let destination = queue_destination(&config.endpoint, None);
        let task = tokio::spawn(run(config));
        until(async || !receiver.0.lock().unwrap().requests.is_empty()).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let mut reopened = None;
        until(async || {
            reopened = Spool::open(&path, &destination, 64 * 1024 * 1024, 1024)
                .await
                .ok();
            reopened.is_some()
        })
        .await;
        let mut reopened = reopened.unwrap();
        assert!(reopened.usage().await.unwrap().1 > 0);
        assert_eq!(
            reopened.front().await.unwrap().unwrap().id,
            receiver.0.lock().unwrap().requests[0].0
        );
        reopened.close().await.unwrap();
        let _ = server_stop.send(());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn lost_acknowledgement_and_restart_replay_the_exact_batch() {
        let fixture = Fixture::new().await;
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().unavailable = true;
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, task) = start(endpoint.clone(), &fixture);
        until(async || !receiver.0.lock().unwrap().requests.is_empty()).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert_eq!(fixture.spool.lock().await.usage().await.unwrap().1, 1);
        fixture.close().await;
        *fixture.spool.lock().await = Spool::open(&fixture.path, "test-receiver", 1024 * 1024, 4)
            .await
            .unwrap();
        receiver.0.lock().unwrap().unavailable = false;
        let (stop, task) = start(endpoint, &fixture);
        until(async || fixture.spool.lock().await.usage().await.unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        {
            let state = receiver.0.lock().unwrap();
            assert!(state.requests.len() >= 2);
            for (id, created, payload) in &state.requests {
                assert_eq!(id, &fixture.batch.id);
                assert_eq!(created, &fixture.batch.created_ns.to_string());
                assert_eq!(payload, &fixture.batch.payload);
            }
        }
        assert_eq!(fixture.loss.generation(), 0);
        let _ = server_stop.send(());
        fixture.close().await;
    }

    #[tokio::test]
    async fn receiver_outage_retries_without_discarding_then_drains() {
        let fixture = Fixture::new().await;
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().unavailable = true;
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, task) = start(endpoint, &fixture);
        until(async || receiver.0.lock().unwrap().requests.len() >= 2).await;
        assert_eq!(fixture.spool.lock().await.usage().await.unwrap().1, 1);
        assert_eq!(fixture.loss.generation(), 0);
        receiver.0.lock().unwrap().unavailable = false;
        until(async || fixture.spool.lock().await.usage().await.unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert_eq!(fixture.loss.generation(), 0);
        let _ = server_stop.send(());
        fixture.close().await;
    }

    #[tokio::test]
    async fn permanent_and_partial_rejections_are_not_retried() {
        for partial in [false, true] {
            let fixture = Fixture::new().await;
            let receiver = Receiver::default();
            {
                let mut state = receiver.0.lock().unwrap();
                state.partial = partial;
                state.rejected = !partial;
            }
            let (endpoint, server_stop) = server(receiver.clone()).await;
            let (stop, task) = start(endpoint, &fixture);
            until(async || fixture.spool.lock().await.usage().await.unwrap().1 == 0).await;
            stop.send_replace(true);
            task.await.unwrap().unwrap();
            assert_eq!(receiver.0.lock().unwrap().requests.len(), 1);
            assert_eq!(
                fixture.spool.lock().await.discarded_points().await.unwrap(),
                if partial { 2 } else { 3 }
            );
            assert_eq!(fixture.loss.generation(), 1);
            let _ = server_stop.send(());
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn expired_batches_are_removed_without_export() {
        let fixture = Fixture::new().await;
        let receiver = Receiver::default();
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(export(
            client(endpoint),
            fixture.spool.clone(),
            fixture.loss.clone(),
            Duration::ZERO,
            Some(Arc::new(Notify::new())),
            stopped,
            None,
        ));
        until(async || fixture.spool.lock().await.usage().await.unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert!(receiver.0.lock().unwrap().requests.is_empty());
        assert_eq!(
            fixture.spool.lock().await.discarded_points().await.unwrap(),
            3
        );
        let _ = server_stop.send(());
        fixture.close().await;
    }

    #[test]
    fn local_connection_failure_is_not_a_terminal_server_unknown() {
        let local = Status::from_error(Box::new(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "test connection closed",
        )));
        assert_eq!(local.code(), tonic::Code::Unknown);
        assert!(retry_delay(&local).is_some());
        assert!(retry_delay(&Status::unknown("server rejection")).is_none());
    }

    #[tokio::test]
    async fn refused_tokens_are_renewed_without_losing_the_batch() {
        let path = std::env::temp_dir().join(format!("recount-renewal-{}", uuid::Uuid::now_v7()));
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().authorization = Some("Bearer renewed".into());
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let loss = LossTracker::default();
        let mut spool = Spool::open(&path, "destination", 64 * 1024 * 1024, 1024)
            .await
            .unwrap();
        let batch = Batch::new("epoch".into(), ExportMetricsServiceRequest::default(), 1).unwrap();
        spool.enqueue(&batch, &loss).await.unwrap();
        let spool = Arc::new(tokio::sync::Mutex::new(spool));
        let (token, tokens) = watch::channel(Some("Bearer expired".parse().unwrap()));
        let stale = Arc::new(Notify::new());
        let (_stop, stopped) = watch::channel(false);
        let task = tokio::spawn(export(
            client(endpoint),
            spool.clone(),
            loss.clone(),
            Duration::from_secs(60),
            None,
            stopped,
            Some(Authorization::new(tokens, stale.clone())),
        ));
        tokio::time::timeout(Duration::from_secs(5), stale.notified())
            .await
            .unwrap();
        token.send_replace(Some("Bearer renewed".parse().unwrap()));
        tokio::time::timeout(Duration::from_secs(40), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(receiver.0.lock().unwrap().requests.len(), 1);
        let mut spool = spool.lock().await;
        assert_eq!(spool.usage().await.unwrap().1, 0);
        assert_eq!(spool.discarded_points().await.unwrap(), 0);
        spool.close_connection().await.unwrap();
        let _ = server_stop.send(());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn retry_codes_follow_otlp_and_honor_server_delay() {
        for code in [
            tonic::Code::Cancelled,
            tonic::Code::DeadlineExceeded,
            tonic::Code::Aborted,
            tonic::Code::OutOfRange,
            tonic::Code::Unavailable,
            tonic::Code::DataLoss,
        ] {
            assert!(retry_delay(&Status::new(code, "")).is_some());
        }
        for code in [
            tonic::Code::Unknown,
            tonic::Code::InvalidArgument,
            tonic::Code::NotFound,
            tonic::Code::AlreadyExists,
            tonic::Code::PermissionDenied,
            tonic::Code::Unauthenticated,
            tonic::Code::FailedPrecondition,
            tonic::Code::Unimplemented,
            tonic::Code::Internal,
            tonic::Code::ResourceExhausted,
        ] {
            assert!(retry_delay(&Status::new(code, "")).is_none());
        }
        let status = Status::with_error_details(
            tonic::Code::ResourceExhausted,
            "",
            ErrorDetails::with_retry_info(Some(Duration::from_millis(7500))),
        );
        assert_eq!(retry_delay(&status), Some(Duration::from_millis(7500)));
        let empty = Status::with_error_details_vec(
            tonic::Code::ResourceExhausted,
            "",
            vec![RetryInfo::new(None).into()],
        );
        assert_eq!(retry_delay(&empty), Some(Duration::ZERO));
        for attempt in 0..100 {
            assert!(backoff(attempt) <= Duration::from_secs(30));
        }
    }
}
