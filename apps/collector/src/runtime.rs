use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, metrics_service_client::MetricsServiceClient,
};
use prost::Message;
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::MissedTickBehavior;
use tonic::{
    codec::CompressionEncoding,
    transport::{Channel, Endpoint},
};

use crate::{
    LossReason, LossTracker, Scan,
    config::{Config, ExportConfig},
    point_count,
    spool::{Batch, MAX_REQUEST_BYTES, Result, Spool, unix_nanos},
};

type SharedSpool = Arc<Mutex<Spool>>;
const PENDING_SCANS: usize = 64;

pub async fn run(config: Config) -> Result<()> {
    let sampler_config = config.sampling();
    let ExportConfig {
        endpoint,
        authorization,
        queue_destination,
    } = config.export()?;
    let Config {
        interval_ms,
        queue_max_bytes: max_bytes,
        queue_max_batches: max_batches,
        queue_max_age_seconds,
        queue_directory: directory,
        ..
    } = config;
    let period = Duration::from_millis(interval_ms);
    let max_age = Duration::from_secs(queue_max_age_seconds);
    let spool = tokio::task::spawn_blocking(move || {
        Spool::open(&directory, &queue_destination, max_bytes, max_batches)
    })
    .await??;
    let (pending_bytes, pending_batches) = spool.usage()?;
    tracing::info!(
        pending_bytes,
        pending_batches,
        discarded_points = spool.discarded_points()?,
        "Opened persistent export queue"
    );
    let spool = Arc::new(Mutex::new(spool));
    let client = client(endpoint);
    let loss = LossTracker::default();
    let feedback = loss.clone();
    let collector =
        tokio::task::spawn_blocking(move || crate::Collector::new(sampler_config, feedback))
            .await??;
    let shutdown = shutdown_signal()?;
    tokio::pin!(shutdown);
    let (stop, stopped) = watch::channel(false);
    let notify = Arc::new(Notify::new());
    let (scans, waiting) = mpsc::channel(PENDING_SCANS);
    let mut sampler = tokio::spawn(sample(collector, period, scans, stopped.clone()));
    let mut persister = tokio::spawn(persist(
        waiting,
        spool.clone(),
        loss.clone(),
        notify.clone(),
    ));
    let mut exporter = tokio::spawn(export(
        client,
        spool,
        loss,
        max_age,
        notify,
        stopped,
        authorization,
    ));
    tracing::info!(
        interval_ms,
        max_bytes,
        max_batches,
        "Starting Linux resource collection"
    );
    enum Completed {
        Shutdown,
        Sampler,
        Persister,
        Exporter,
    }
    let (completed, result) = tokio::select! {
        () = &mut shutdown => (Completed::Shutdown, Ok(())),
        result = &mut sampler => (Completed::Sampler, result?),
        result = &mut persister => (Completed::Persister, result?),
        result = &mut exporter => (Completed::Exporter, result?),
    };
    stop.send_replace(true);
    // Stop acquisition, drain the bounded volatile buffer to disk, and leave
    // cancelled network requests pending. A slow disk can delay graceful exit.
    let pending = match completed {
        Completed::Shutdown => vec![sampler, persister, exporter],
        Completed::Sampler => vec![persister, exporter],
        Completed::Persister => vec![sampler, exporter],
        Completed::Exporter => vec![sampler, persister],
    };
    let mut result = result;
    for task in pending {
        let ended = match task.await {
            Ok(result) => result,
            Err(error) => Err(error.into()),
        };
        if result.is_ok() {
            result = ended;
        }
    }
    result?;
    tracing::info!("Stopped collection; pending exports retained");
    Ok(())
}

fn client(endpoint: Endpoint) -> MetricsServiceClient<Channel> {
    let channel = endpoint
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .connect_lazy();
    MetricsServiceClient::new(channel)
        .send_compressed(CompressionEncoding::Gzip)
        .accept_compressed(CompressionEncoding::Gzip)
        .max_encoding_message_size(MAX_REQUEST_BYTES)
}

async fn access<T: Send + 'static>(
    spool: &SharedSpool,
    operation: impl FnOnce(&mut Spool) -> Result<T> + Send + 'static,
) -> Result<T> {
    let spool = spool.clone();
    tokio::task::spawn_blocking(move || {
        let mut spool = spool
            .lock()
            .map_err(|_| io::Error::other("Queue worker panicked"))?;
        operation(&mut spool)
    })
    .await?
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
        let feedback = loss.clone();
        access(&spool, move |spool| enqueue_scan(spool, scan, &feedback)).await?;
        notify.notify_one();
    }
    Ok(())
}

fn enqueue_scan(spool: &mut Spool, scan: Scan, loss: &LossTracker) -> Result<()> {
    if scan.generation() != loss.generation() {
        let epoch = scan.epoch().to_owned();
        let resources = scan.into_resources();
        spool.record_loss(
            &epoch,
            LossReason::BufferExpired,
            point_count(&resources),
            loss,
        )?;
        return Ok(());
    }
    let epoch = scan.epoch().to_owned();
    let mut resources = scan.into_resources();
    let mut window = resources
        .last()
        .cloned()
        .expect("Completed scans contain diagnostics");
    let is_window = |name: &str| {
        matches!(
            name,
            "pfe.collection.scan.duration" | "pfe.clock.status" | "pfe.clock.uncertainty"
        )
    };
    for scope in &mut window.scope_metrics {
        scope.metrics.retain(|metric| is_window(&metric.name));
    }
    if let Some(diagnostics) = resources.last_mut() {
        for scope in &mut diagnostics.scope_metrics {
            scope.metrics.retain(|metric| !is_window(&metric.name));
        }
    }
    let window_size = window.encoded_len() + 16;
    let mut request = ExportMetricsServiceRequest {
        resource_metrics: vec![window.clone()],
    };
    let mut size = window_size;
    for resource in resources {
        let resource_size = resource.encoded_len() + 16;
        if resource_size + window_size > MAX_REQUEST_BYTES {
            spool.record_loss(
                &epoch,
                LossReason::PermanentRejection,
                point_count(std::slice::from_ref(&resource)),
                loss,
            )?;
            continue;
        }
        if size + resource_size > MAX_REQUEST_BYTES {
            enqueue_request(spool, &epoch, request, loss)?;
            request = ExportMetricsServiceRequest {
                resource_metrics: vec![window.clone()],
            };
            size = window_size;
        }
        size += resource_size;
        request.resource_metrics.push(resource);
    }
    if request.resource_metrics.len() > 1 {
        enqueue_request(spool, &epoch, request, loss)?;
    }
    Ok(())
}

fn enqueue_request(
    spool: &mut Spool,
    epoch: &str,
    request: ExportMetricsServiceRequest,
    loss: &LossTracker,
) -> Result<()> {
    let points = point_count(&request.resource_metrics);
    let batch = Batch::new(epoch.into(), request, points)?;
    spool.enqueue(&batch, loss)?;
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
    mut client: MetricsServiceClient<Channel>,
    spool: SharedSpool,
    loss: LossTracker,
    max_age: Duration,
    notify: Arc<Notify>,
    mut stopped: watch::Receiver<bool>,
    authorization: Option<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>,
) -> Result<()> {
    loop {
        if *stopped.borrow() {
            return Ok(());
        }
        let Some(batch) = access(&spool, |spool| spool.front()).await? else {
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
            if let Some(value) = &authorization {
                request
                    .metadata_mut()
                    .insert("authorization", value.clone());
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
                    let Some(server_delay) = retry_delay(&status) else {
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
        let feedback = loss.clone();
        access(&spool, move |spool| {
            spool.finish(&batch, discarded, &feedback)
        })
        .await?;
    }
}

fn request(batch: &Batch) -> Result<tonic::Request<ExportMetricsServiceRequest>> {
    let mut request = tonic::Request::new(ExportMetricsServiceRequest::decode(
        batch.payload.as_slice(),
    )?);
    request
        .metadata_mut()
        .insert("pfe-batch-id", batch.id.parse()?);
    request.metadata_mut().insert(
        "pfe-batch-created-unix-nano",
        batch.created_ns.to_string().parse()?,
    );
    Ok(request)
}

fn shutdown_signal() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CollectorConfig;
    use opentelemetry_proto::tonic::collector::metrics::v1::{
        ExportMetricsPartialSuccess, ExportMetricsServiceResponse,
        metrics_service_server::{MetricsService, MetricsServiceServer},
    };
    use opentelemetry_proto::tonic::metrics::v1::ResourceMetrics;
    use std::path::PathBuf;
    use tonic::{Request, Response, Status};

    #[derive(Clone, Default)]
    struct Receiver(Arc<Mutex<ReceiverState>>);
    #[derive(Default)]
    struct ReceiverState {
        requests: Vec<(String, String, Vec<u8>)>,
        unavailable: bool,
        rejected: bool,
        partial: bool,
    }
    #[tonic::async_trait]
    impl MetricsService for Receiver {
        async fn export(
            &self,
            request: Request<ExportMetricsServiceRequest>,
        ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
            let id = request
                .metadata()
                .get("pfe-batch-id")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            let time = request
                .metadata()
                .get("pfe-batch-created-unix-nano")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            assert!(request.metadata().get("pfe-collection-profile").is_none());
            let mut state = self.0.lock().unwrap();
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
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("pfe-runtime-{}", uuid::Uuid::now_v7()));
            let mut spool = Spool::open(&path, "test-receiver", 1024 * 1024, 4).unwrap();
            let loss = LossTracker::default();
            let request = ExportMetricsServiceRequest {
                resource_metrics: vec![ResourceMetrics {
                    schema_url: "recovery-fixture".into(),
                    ..Default::default()
                }],
            };
            let batch = Batch::new("epoch".into(), request, 3).unwrap();
            spool.enqueue(&batch, &loss).unwrap();
            Self {
                path,
                spool: Arc::new(Mutex::new(spool)),
                loss,
                batch,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
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
    async fn until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !condition() {
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
            Arc::new(Notify::new()),
            stopped,
            None,
        ));
        (stop, task)
    }

    #[tokio::test]
    async fn sampling_continues_while_the_persistence_worker_is_blocked() {
        let fixture = Fixture::new();
        let held = fixture.spool.clone();
        let (locked, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            locked.send(()).unwrap();
            let _ = blocked.recv();
        });
        ready.await.unwrap();
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
        let sampler = tokio::spawn(sample(collector, period, sender, stopped));
        let persister = tokio::spawn(persist(
            receiver,
            fixture.spool.clone(),
            fixture.loss.clone(),
            Arc::new(Notify::new()),
        ));
        until(|| probe.capacity() <= PENDING_SCANS - 3).await;
        stop.send_replace(true);
        sampler.await.unwrap().unwrap();
        drop(probe);
        release.send(()).unwrap();
        holder.join().unwrap();
        persister.await.unwrap().unwrap();
        assert!(fixture.spool.lock().unwrap().usage().unwrap().1 >= 3);
    }

    #[tokio::test]
    async fn lost_acknowledgement_and_restart_replay_the_exact_batch() {
        let mut fixture = Fixture::new();
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().unavailable = true;
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, task) = start(endpoint.clone(), &fixture);
        until(|| !receiver.0.lock().unwrap().requests.is_empty()).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert_eq!(fixture.spool.lock().unwrap().usage().unwrap().1, 1);
        // Close the original SQLite connection and reopen as after a restart.
        let placeholder =
            std::env::temp_dir().join(format!("pfe-placeholder-{}", uuid::Uuid::now_v7()));
        fixture.spool = Arc::new(Mutex::new(
            Spool::open(&placeholder, "temporary", 1024, 1).unwrap(),
        ));
        fixture.spool = Arc::new(Mutex::new(
            Spool::open(&fixture.path, "test-receiver", 1024 * 1024, 4).unwrap(),
        ));
        std::fs::remove_dir_all(placeholder).unwrap();
        receiver.0.lock().unwrap().unavailable = false;
        let (stop, task) = start(endpoint, &fixture);
        until(|| fixture.spool.lock().unwrap().usage().unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        let state = receiver.0.lock().unwrap();
        assert!(state.requests.len() >= 2);
        for (id, created, payload) in &state.requests {
            assert_eq!(id, &fixture.batch.id);
            assert_eq!(created, &fixture.batch.created_ns.to_string());
            assert_eq!(payload, &fixture.batch.payload);
        }
        assert_eq!(fixture.loss.generation(), 0);
        let _ = server_stop.send(());
    }

    #[tokio::test]
    async fn receiver_outage_retries_without_discarding_then_drains() {
        let fixture = Fixture::new();
        let receiver = Receiver::default();
        receiver.0.lock().unwrap().unavailable = true;
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, task) = start(endpoint, &fixture);
        until(|| receiver.0.lock().unwrap().requests.len() >= 2).await;
        assert_eq!(fixture.spool.lock().unwrap().usage().unwrap().1, 1);
        assert_eq!(fixture.loss.generation(), 0);
        receiver.0.lock().unwrap().unavailable = false;
        until(|| fixture.spool.lock().unwrap().usage().unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert_eq!(fixture.loss.generation(), 0);
        let _ = server_stop.send(());
    }

    #[tokio::test]
    async fn permanent_and_partial_rejections_are_not_retried() {
        for partial in [false, true] {
            let fixture = Fixture::new();
            let receiver = Receiver::default();
            {
                let mut state = receiver.0.lock().unwrap();
                state.partial = partial;
                state.rejected = !partial;
            }
            let (endpoint, server_stop) = server(receiver.clone()).await;
            let (stop, task) = start(endpoint, &fixture);
            until(|| fixture.spool.lock().unwrap().usage().unwrap().1 == 0).await;
            stop.send_replace(true);
            task.await.unwrap().unwrap();
            assert_eq!(receiver.0.lock().unwrap().requests.len(), 1);
            assert_eq!(
                fixture.spool.lock().unwrap().discarded_points().unwrap(),
                if partial { 2 } else { 3 }
            );
            assert_eq!(fixture.loss.generation(), 1);
            let _ = server_stop.send(());
        }
    }

    #[tokio::test]
    async fn expired_batches_are_removed_without_export() {
        let fixture = Fixture::new();
        let receiver = Receiver::default();
        let (endpoint, server_stop) = server(receiver.clone()).await;
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(export(
            client(endpoint),
            fixture.spool.clone(),
            fixture.loss.clone(),
            Duration::ZERO,
            Arc::new(Notify::new()),
            stopped,
            None,
        ));
        until(|| fixture.spool.lock().unwrap().usage().unwrap().1 == 0).await;
        stop.send_replace(true);
        task.await.unwrap().unwrap();
        assert!(receiver.0.lock().unwrap().requests.is_empty());
        assert_eq!(fixture.spool.lock().unwrap().discarded_points().unwrap(), 3);
        let _ = server_stop.send(());
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
        use tonic_types::{ErrorDetails, RetryInfo, StatusExt};
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
