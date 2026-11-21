use crate::{config::Config, kafka, retention::RetentionMetrics};
use futures_util::future::join_all;
use recount_telemetry_schema::{RAW_RECEIVED_MS_HEADER, identity_cache::IdentityCache, recent};
use recount_telemetry_validation::transport::ConsumerBudget;
use ruststream_rdkafka::{
    PARTITION_KEY_HEADER,
    context::keys::{Key, Offset, Partition, TimestampMillis},
    prelude::*,
};
use std::{
    convert::Infallible,
    fmt::Write,
    future::Future,
    num::NonZeroUsize,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

#[cfg(test)]
#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
mod dead_letter;
#[cfg(test)]
mod delivery_tests;
#[cfg(test)]
mod identity_cache_tests;
pub(crate) mod packing;
pub(crate) mod series_cache;
use series_cache::SeriesCache;
#[cfg(test)]
mod packing_replay;

const KAFKA_NETWORK_TIMEOUT: Duration = Duration::from_secs(3);
const KAFKA_SESSION_TIMEOUT: Duration = Duration::from_secs(6);
const KAFKA_ASSIGNMENT_HEADROOM: Duration = Duration::from_secs(12);

#[derive(Clone)]
struct RunState {
    config: Config,
    preparation: Arc<Semaphore>,
    packed_recent: bool,
    series_cache: Arc<SeriesCache>,
    stream_cache: Arc<SeriesCache<[u8; 16]>>,
    delivery_cache: Arc<SeriesCache<[u8; 32]>>,
    identity_cache: Arc<IdentityCache>,
}

impl RunState {
    fn new(config: Config, packed_recent: bool) -> Self {
        let entries = config.series_cache_entries;
        let resend_ms = config.series_resend_ms;
        Self {
            preparation: Arc::new(Semaphore::new(config.max_active)),
            series_cache: Arc::new(SeriesCache::new(entries, resend_ms)),
            identity_cache: Arc::new(IdentityCache::default()),
            stream_cache: Arc::new(SeriesCache::new(entries, resend_ms)),
            delivery_cache: Arc::new(SeriesCache::new(entries, resend_ms)),
            config,
            packed_recent,
        }
    }

    fn export_cache_metrics(&self, metrics: &RetentionMetrics) {
        let mut text = String::new();
        let [(resource, resource_counters), (series, series_counters)] =
            self.identity_cache.counters();
        let (series_emits, series_suppressed) = self.series_cache.counters();
        let (stream_emits, stream_suppressed) = self.stream_cache.counters();
        for (name, values) in [
            (
                "identity_cache_hits",
                [
                    (resource, resource_counters.hits),
                    (series, series_counters.hits),
                ],
            ),
            (
                "identity_cache_misses",
                [
                    (resource, resource_counters.misses),
                    (series, series_counters.misses),
                ],
            ),
            (
                "identity_cache_evictions",
                [
                    (resource, resource_counters.evictions),
                    (series, series_counters.evictions),
                ],
            ),
            (
                "metadata_cache_emits",
                [("series", series_emits), ("stream", stream_emits)],
            ),
            (
                "metadata_cache_suppressed",
                [("series", series_suppressed), ("stream", stream_suppressed)],
            ),
        ] {
            writeln!(text, "# TYPE recount_normalizer_{name}_total counter").unwrap();
            for (kind, count) in values {
                writeln!(
                    text,
                    "recount_normalizer_{name}_total{{cache_kind=\"{kind}\"}} {count}"
                )
                .unwrap();
            }
        }
        if let Err(error) = metrics.update_cache(text) {
            tracing::warn!(%error, "normalizer metrics export failed");
        }
    }
}
impl FromRef<RunState> for RunState {
    fn from_ref(state: &RunState) -> Self {
        state.clone()
    }
}

#[derive(Deserialized)]
struct Frame<'a>(&'a [u8]);
#[derive(Serialized, Outgoing)]
struct Point(Vec<u8>);
#[derive(OutSlot)]
#[publishes(Point)]
struct Normalized;
#[derive(Serialized, Outgoing)]
struct DeadLetterDelivery(Vec<u8>);
#[derive(OutSlot)]
#[publishes(DeadLetterDelivery)]
struct Rejected;

// Fallible decoding stays inside the handler: panic FailFast leaves the input
// unsettled, unlike the released typed-decode/default Result error paths.
#[subscriber("raw")]
async fn normalize(
    frame: &Frame<'_>,
    Ctx(key): Ctx<Key>,
    Ctx(timestamp): Ctx<TimestampMillis>,
    Ctx(raw_partition): Ctx<Partition>,
    Ctx(raw_offset): Ctx<Offset>,
    State(state): State<RunState>,
    Out(out): Out<impl Publisher<Options = KafkaOptions>, Normalized>,
    Out(rejected): Out<impl Publisher<Options = KafkaOptions>, Rejected>,
) -> HandlerOutcome {
    let partition = u32::try_from(raw_partition).expect("nonnegative raw partition");
    let offset = u64::try_from(raw_offset).expect("nonnegative raw offset");
    let permit = state
        .preparation
        .clone()
        .acquire_owned()
        .await
        .expect("preparation lane");
    let payload = (frame.0.len() <= state.config.limits.decoded_bytes).then(|| frame.0.to_vec());
    let partitions = state.config.normalized_partitions;
    let limits = state.config.limits;
    let now_ns = unix_nanos();
    let now = now_ns / 1_000_000;
    let broker_bytes = state.config.normalized_broker_max_bytes;
    let packed_recent = state.packed_recent;
    let cache = state.series_cache.clone();
    let stream_cache = state.stream_cache.clone();
    let delivery_cache = state.delivery_cache.clone();
    let identity_cache = state.identity_cache.clone();
    let preparation = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let payload = payload
            .ok_or_else(|| dead_letter::Rejection::new(dead_letter::Reason::RawTooLarge, None))?;
        let (mut rows, raw) =
            dead_letter::prepare(&payload, key.as_deref(), limits, &identity_cache)?;
        for row in &mut rows {
            row.frame.raw_partition = partition;
            row.frame.raw_offset = offset;
        }
        let delivery = rows.first_mut().and_then(|first| {
            let frame = &mut first.frame;
            let emission = series_cache::Emission {
                series: frame
                    .delivery_context_id
                    .as_slice()
                    .try_into()
                    .expect("context digest"),
                first: frame.min_event_unix_milli,
                time: frame.max_event_unix_milli,
                emitted_at: now,
                lane_partition: u32::from(!recent(frame.time_unix_milli, now)),
            };
            if delivery_cache.should_emit(emission) {
                Some(emission)
            } else {
                frame.delivery_context.clear();
                None
            }
        });
        let (records, emissions) = packing::pack_prepared(
            rows,
            partitions,
            now,
            broker_bytes,
            packed_recent,
            Some(&cache),
            Some(&stream_cache),
        )
        .map_err(|error| match error {
            packing::PackError::RecordTooLarge => dead_letter::Rejection::new(
                dead_letter::Reason::NormalizedRecordTooLarge,
                dead_letter::verified_scope(&raw),
            ),
            packing::PackError::Invariant(reason) => {
                panic!("normalized packing invariant failed: {reason}")
            }
        })?;
        Ok::<_, dead_letter::Rejection>((records, emissions, delivery))
    })
    .await
    .expect("preparation failed");
    let (records, emissions, delivery) = match preparation {
        Ok(result) => result,
        Err(rejection) => {
            let topic = &state.config.raw_topic;
            let body = DeadLetterDelivery(rejection.body(
                &state.config,
                partition,
                offset,
                timestamp,
                now_ns,
            ));
            let mut headers = HeaderMap::new();
            headers.insert(
                PARTITION_KEY_HEADER,
                format!("{topic}/{partition}/{offset}").into_bytes(),
            );
            return dead_letter::settle(
                || {
                    rejected
                        .message(&body)
                        .to(&state.config.dead_letter_topic)
                        .with_headers(headers.clone())
                        .publish()
                },
                state.config.retry,
            )
            .await;
        }
    };
    // Packing is per raw delivery. Keep its receive time separate from the
    // output timestamp so a delayed replay does not shorten normalized retention.
    let mut headers = HeaderMap::new();
    headers.insert(
        RAW_RECEIVED_MS_HEADER,
        timestamp
            .expect("raw Kafka timestamp required")
            .to_string()
            .into_bytes(),
    );
    let points: Vec<(Point, i32, &str)> = records
        .into_iter()
        .map(|record| {
            let topic = if recent(record.time_unix_milli, now) {
                &state.config.normalized_topic
            } else {
                &state.config.late_topic
            };
            (
                Point(record.payload),
                record.partition as i32,
                topic.as_str(),
            )
        })
        .collect();
    // Let the producer fill and drain its byte-bounded queue without waiting for
    // a delivery barrier between chunks. A partial failure leaves the input unsettled.
    while let Err(error) = await_deliveries(points.iter().map(|(point, partition, topic)| {
        out.message(point)
            .to(*topic)
            .partition(*partition)
            .with_headers(headers.clone())
            .publish()
    }))
    .await
    {
        tracing::warn!(%error, "normalized publication failed; input remains unsettled");
        tokio::time::sleep(state.config.retry).await;
    }
    state.series_cache.acknowledge(&emissions.series);
    state.stream_cache.acknowledge(&emissions.streams);
    if let Some(delivery) = delivery {
        state.delivery_cache.acknowledge(&[delivery]);
    }
    HandlerOutcome::ack()
}

async fn await_deliveries<E>(
    deliveries: impl IntoIterator<Item = impl Future<Output = Result<(), E>>>,
) -> Result<(), E> {
    join_all(deliveries).await.into_iter().collect()
}

fn unix_nanos() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after the Unix epoch");
    u64::try_from(elapsed.as_nanos()).expect("system clock within u64 nanoseconds")
}

fn app(state: RunState) -> impl App {
    let config = &state.config;
    let budget = ConsumerBudget::raw(config.raw_broker_max_bytes).expect("validated raw budget");
    // A killed Kafka group member sends no LeaveGroup, so replacement assignment
    // can wait a full session. Additional startup headroom covers rejoining and
    // RustStream's separate initial committed-offset lookup timeout.
    let assignment_timeout = KAFKA_SESSION_TIMEOUT + KAFKA_ASSIGNMENT_HEADROOM;
    let broker = KafkaBroker::new([config.bootstrap.clone()])
        .connect_timeout(KAFKA_NETWORK_TIMEOUT)
        .assignment_timeout(assignment_timeout)
        .flush_timeout(Duration::from_secs(3))
        .config("allow.auto.create.topics", "false")
        .config(
            "socket.timeout.ms",
            KAFKA_NETWORK_TIMEOUT.as_millis().to_string(),
        )
        .producer_config("enable.idempotence", "true")
        .producer_config("acks", "all")
        // The topic declares the same codec, so the broker stores batches unchanged.
        .producer_config("compression.type", "zstd")
        .producer_config("linger.ms", config.linger_ms.to_string())
        .producer_config(
            "message.max.bytes",
            config.normalized_broker_max_bytes.to_string(),
        )
        .producer_config(
            "queue.buffering.max.kbytes",
            config.producer_queue_kib().to_string(),
        )
        .producer_config(
            "queue.buffering.max.messages",
            config
                .limits
                .points
                .saturating_mul(config.max_active)
                .min(1_000_000)
                .to_string(),
        )
        .producer_config("retry.backoff.ms", config.retry.as_millis().to_string())
        .producer_config("retry.backoff.max.ms", config.retry.as_millis().to_string())
        .producer_config(
            "message.timeout.ms",
            config.delivery.as_millis().to_string(),
        );
    let source = KafkaTopic::new(&config.raw_topic)
        .group(&config.group)
        .commit(Commit::Tracked)
        .config("auto.offset.reset", "earliest")
        .config("auto.commit.interval.ms", "1000")
        .config(
            "session.timeout.ms",
            KAFKA_SESSION_TIMEOUT.as_millis().to_string(),
        )
        .config("message.max.bytes", budget.partition_bytes.to_string())
        .config(
            "fetch.message.max.bytes",
            budget.partition_bytes.to_string(),
        )
        .config("fetch.max.bytes", budget.fetch_bytes.to_string())
        .config(
            "receive.message.max.bytes",
            budget.receive_bytes.to_string(),
        )
        .config("queued.max.messages.kbytes", budget.queued_kib.to_string())
        .config("queued.min.messages", "1")
        .config("fetch.wait.max.ms", "100");
    let workers = NonZeroUsize::new(config.max_active).expect("positive worker count");
    let shutdown = config.shutdown;
    let delivery = config.delivery;
    RustStream::new(AppInfo::new(
        "recount-normalizer",
        env!("CARGO_PKG_VERSION"),
    ))
    .shutdown_timeout(shutdown)
    .on_startup(async move |()| {
        kafka::preflight(state.config.clone())
            .await
            .map_err(std::io::Error::other)?;
        Ok::<_, std::io::Error>(state)
    })
    .after_startup(async |_: Arc<RunState>| {
        eprintln!("state=ready checks=initial_snapshot offset_reset=earliest");
        Ok::<_, Infallible>(())
    })
    .on_shutdown(async |_: Arc<RunState>| {
        eprintln!("state=stopping");
        Ok::<_, Infallible>(())
    })
    .with_broker(broker, move |b| {
        b.include(
            normalize
                .map_source(move |_| source.clone())
                .workers(workers)
                .on_failure(
                    FailurePolicies::default()
                        .with_panic(FailurePolicy::FailFast)
                        .with_decode(FailurePolicy::FailFast),
                ),
        )
        // A publish waits for queue space for at most the delivery deadline: librdkafka
        // frees a record's slot just after reporting its delivery, so the next group can
        // briefly find the queue full.
        .out(Normalized, Publish::default().queue_timeout(delivery))
        .out(Rejected, Publish::default().queue_timeout(delivery))
        .build();
    })
}

pub async fn run(config: Config, metrics: RetentionMetrics) -> Result<(), String> {
    eprintln!("state=starting");
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    let state = RunState::new(config, true);
    let export = async {
        if !metrics.enabled() {
            std::future::pending::<()>().await;
        }
        let mut timer = tokio::time::interval(Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            state.export_cache_metrics(&metrics);
        }
    };
    let app = app(state.clone());
    let run = app.run_until(async {
        #[cfg(unix)]
        tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    });
    let result = tokio::select! { result = run => result, () = export => unreachable!() };
    if metrics.enabled() {
        state.export_cache_metrics(&metrics);
    }
    result.map_err(|error| error.to_string())
}
