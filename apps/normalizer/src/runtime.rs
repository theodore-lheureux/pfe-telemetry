use crate::{config::Config, kafka, prepare};
use recount_telemetry_validation::transport::ConsumerBudget;
use ruststream_rdkafka::{context::keys::Key, prelude::*};
use std::{convert::Infallible, num::NonZeroUsize, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct RunState {
    config: Config,
    preparation: Arc<Semaphore>,
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
    for record in records {
        assert!(
            out.message(&Point(record.payload))
                .to(&state.config.normalized_topic)
                .partition(record.partition as i32)
                .publish()
                .await
                .is_ok(),
            "normalized publication failed; input remains unsettled"
        );
    }
    HandlerOutcome::ack()
}

fn app(config: Config) -> impl App {
    let budget = ConsumerBudget::raw(config.raw_broker_max_bytes).expect("validated raw budget");
    let broker = KafkaBroker::new([config.bootstrap.clone()])
        .connect_timeout(Duration::from_secs(3))
        .assignment_timeout(Duration::from_secs(3))
        .flush_timeout(Duration::from_secs(3))
        .config("allow.auto.create.topics", "false")
        .config("socket.timeout.ms", "3000")
        .producer_config("enable.idempotence", "true")
        .producer_config("acks", "all")
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
        .producer_config("queue.buffering.max.messages", "128")
        .producer_config("retry.backoff.ms", config.retry.as_millis().to_string())
        .producer_config("retry.backoff.max.ms", config.retry.as_millis().to_string())
        .producer_config(
            "message.timeout.ms",
            config.delivery.as_millis().to_string(),
        );
    let source = KafkaTopic::new(&config.raw_topic)
        .group(&config.group)
        .commit(Commit::Tracked)
        .config("auto.offset.reset", "error")
        .config("auto.commit.interval.ms", "1000")
        .config("session.timeout.ms", "6000")
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
            config,
            preparation: Arc::new(Semaphore::new(1)),
        })
    })
    .after_startup(async |_: Arc<RunState>| {
        eprintln!("state=ready checks=initial_snapshot native_errors=logged");
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
        .out(Normalized, Publish::default().queue_timeout(Duration::ZERO))
        .build();
    })
}

pub async fn run(config: Config) -> Result<(), String> {
    eprintln!("state=starting");
    #[cfg(unix)]
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    app(config)
        .run_until(async {
            #[cfg(unix)]
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())
}
