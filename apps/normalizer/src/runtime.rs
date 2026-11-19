use crate::{config::Config, kafka, prepare};
use futures_util::future::join_all;
use recount_telemetry_schema::{RAW_RECEIVED_MS_HEADER, recent};
use recount_telemetry_validation::transport::ConsumerBudget;
use ruststream_rdkafka::{
    context::keys::{Key, TimestampMillis},
    prelude::*,
};
use std::{
    convert::Infallible,
    future::Future,
    num::NonZeroUsize,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

#[cfg(test)]
mod delivery_tests;
mod packing;
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

// Fallible decoding stays inside the handler: panic FailFast leaves the input
// unsettled, unlike the released typed-decode/default Result error paths.
#[subscriber("raw")]
async fn normalize(
    frame: &Frame<'_>,
    Ctx(key): Ctx<Key>,
    Ctx(timestamp): Ctx<TimestampMillis>,
    State(state): State<RunState>,
    Out(out): Out<impl Publisher<Options = KafkaOptions>, Normalized>,
) -> HandlerOutcome {
    assert!(
        frame.0.len() <= state.config.limits.decoded_bytes,
        "raw byte limit"
    );
    assert!(
        key.as_ref().is_some_and(|key| key.len() == 32),
        "raw routing key required"
    );
    let permit = state
        .preparation
        .clone()
        .acquire_owned()
        .await
        .expect("preparation lane");
    let payload = frame.0.to_vec();
    let partitions = state.config.normalized_partitions;
    let limits = state.config.limits;
    let records = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        prepare(&payload, key.as_deref(), partitions, limits)
            .unwrap_or_else(|_| panic!("retained validation failed"))
    })
    .await
    .expect("preparation failed");
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
    // Points far from now take the late topic, which ClickHouse reads in small blocks.
    let now = unix_nanos();
    let records = if state.packed_recent {
        packing::pack_recent(records, now, state.config.normalized_broker_max_bytes)
            .expect("packed normalized record exceeds broker budget")
    } else {
        records
    };
    let points: Vec<(Point, i32, &str)> = records
        .into_iter()
        .map(|record| {
            let topic = if recent(record.time_unix_nano, now) {
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
    await_deliveries(points.iter().map(|(point, partition, topic)| {
        out.message(point)
            .to(*topic)
            .partition(*partition)
            .with_headers(headers.clone())
            .publish()
    }))
    .await
    .unwrap_or_else(|error| {
        panic!("normalized publication failed; input remains unsettled: {error}")
    });
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

fn app(config: Config, packed_recent: bool) -> impl App {
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
        // Rows repeat their resource, scope and identity fields, so batches compress well;
        // the topic declares the same codec, so the broker stores them unchanged.
        .producer_config("compression.type", "zstd")
        .producer_config("linger.ms", config.linger_ms.to_string())
        .producer_config(
            "message.max.bytes",
            config.normalized_broker_max_bytes.to_string(),
        )
        .producer_config(
            "queue.buffering.max.kbytes",
            (config.normalized_broker_max_bytes * 2)
                .div_ceil(1024)
                .to_string(),
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
        kafka::preflight(config.clone())
            .await
            .map_err(std::io::Error::other)?;
        Ok::<_, std::io::Error>(RunState {
            preparation: Arc::new(Semaphore::new(config.max_active)),
            config,
            packed_recent,
        })
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
        .build();
    })
}

pub async fn run(config: Config) -> Result<(), String> {
    eprintln!("state=starting");
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    app(config, true)
        .run_until(async {
            #[cfg(unix)]
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())
}
