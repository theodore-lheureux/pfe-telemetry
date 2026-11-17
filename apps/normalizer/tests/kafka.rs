use futures_util::future::join_all;
use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    client::DefaultClientContext,
    consumer::{BaseConsumer, CommitMode, Consumer},
    message::Message as _,
    producer::{FutureProducer, FutureRecord},
    types::RDKafkaErrorCode,
    util::Timeout,
};
use recount_telemetry_schema::{
    identity,
    metrics::{metric::Data, number_data_point::Value},
    wire::{AnalyticalPoint, RawRecord},
};
#[cfg(unix)]
use std::io::Read;
use std::{
    collections::{BTreeMap, btree_map::Entry},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
#[path = "../../../tests/fixtures/kafka/disposable.rs"]
mod disposable;

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh topic permission"]
async fn continuous_backlog_advances_confirmed_prefix_beyond_active_slots() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let unique = format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        std::process::id()
    );
    let namespace = setting("RECOUNT_NORMALIZER_TEST_NAMESPACE");
    assert!(namespace.starts_with("recount."));
    let env = Environment::create(
        &setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        &format!("{namespace}.normalizer.progress.{unique}"),
    )
    .await;
    let observer = consumer(&env.broker, &env.group);
    let reader = consumer(&env.broker, &format!("{}.observer", env.group));
    let mut assignment = TopicPartitionList::new();
    for p in 0..3 {
        assignment
            .add_partition_offset(&env.late, p, Offset::Offset(0))
            .unwrap();
    }
    reader.assign(&assignment).unwrap();
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &env.broker)
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .set("message.timeout.ms", "5000")
        .create()
        .unwrap();
    let mut expected = BTreeMap::new();
    const PER_PARTITION: i64 = 40;
    let mut raw_bytes = 0;
    let outage = Instant::now();
    // Pre-fill all raw partitions, so buffered/prefetched inputs persist while
    // the same production process must repeatedly release its two active slots.
    for index in 0..PER_PARTITION * 3 {
        let mut raw = cases::raw();
        raw.batch.as_mut().unwrap().client_id = format!("progress-{index}");
        let body = raw.encode_to_vec();
        raw_bytes += body.len();
        let key = identity::raw_routing_key(&raw).unwrap();
        for record in recount_normalizer::prepare(
            &body,
            Some(&key),
            3,
            recount_telemetry_validation::validate::Limits::default(),
        )
        .unwrap()
        {
            let row = AnalyticalPoint::decode(record.payload.as_slice()).unwrap();
            expected.insert(row.sample_id.clone(), row);
        }
        producer
            .send(
                FutureRecord::to(&env.raw)
                    .partition((index % 3) as i32)
                    .key(&key)
                    .payload(&body),
                Timeout::After(Duration::from_secs(1)),
            )
            .await
            .map_err(|(error, _)| error)
            .expect("progress raw publication failed");
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let outage_seconds = outage.elapsed().as_secs_f64();
    for p in 0..3 {
        let mut query = TopicPartitionList::new();
        query.add_partition(&env.raw, p);
        assert_eq!(
            observer
                .committed_offsets(query, Duration::from_secs(3))
                .unwrap()
                .find_partition(&env.raw, p)
                .unwrap()
                .offset(),
            Offset::Invalid
        );
        assert_eq!(
            observer
                .fetch_watermarks(&env.raw, p, Duration::from_secs(3))
                .unwrap(),
            (0, PER_PARTITION),
        );
    }
    let catchup = Instant::now();
    let process = env.start();
    let deadline = Instant::now() + Duration::from_secs(20);
    let query = || {
        let mut q = TopicPartitionList::new();
        for p in 0..3 {
            q.add_partition(&env.raw, p);
        }
        q
    };
    let mut last = Vec::new();
    loop {
        let offsets = observer
            .committed_offsets(query(), Duration::from_secs(1))
            .unwrap();
        let current: Vec<_> = (0..3)
            .map(|p| offsets.find_partition(&env.raw, p).unwrap().offset())
            .collect();
        if current != last {
            eprintln!("progress_broker_checkpoints={current:?}");
            last = current.clone();
        }
        if current.iter().all(|v| *v == Offset::Offset(PER_PARTITION)) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "continuous raw backlog stalled beyond max_active=2: checkpoints={current:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let catchup_seconds = catchup.elapsed().as_secs_f64();
    assert!(
        collect(&reader, expected.len(), "continuous backlog").await == expected,
        "normalized sample identities/projections differ"
    );
    for p in 0..3 {
        assert_eq!(
            observer
                .fetch_watermarks(&env.normalized, p, Duration::from_secs(3))
                .unwrap(),
            (0, 0),
            "points outside the recent window reached the recent topic"
        );
    }
    eprintln!(
        "catchup_complete inputs={} logical_samples={} raw_payload_bytes={raw_bytes} normalized_payload_bytes={} outage_seconds={outage_seconds:.3} catchup_seconds={catchup_seconds:.3} raw_bytes_per_second={:.0}",
        PER_PARTITION * 3,
        expected.len(),
        expected.values().map(Message::encoded_len).sum::<usize>(),
        raw_bytes as f64 / catchup_seconds,
    );
    drop(process);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh short-retention topic permission"]
async fn natural_time_and_byte_expiry_warn_count_and_resume_the_suffix() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let namespace = setting("RECOUNT_NORMALIZER_TEST_NAMESPACE");
    assert!(namespace.starts_with("recount."));
    assert!(
        namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    );
    let broker = setting("RECOUNT_NORMALIZER_TEST_BROKER");
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .unwrap();
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .create()
        .unwrap();
    for bytes in [false, true] {
        let prefix = format!(
            "{namespace}.expiry.{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let env = Environment {
            binary: env!("CARGO_BIN_EXE_recount-normalizer").into(),
            broker: broker.clone(),
            raw: format!("{prefix}.raw"),
            normalized: format!("{prefix}.normalized"),
            late: format!("{prefix}.late"),
            group: format!("{prefix}.group"),
        };
        let results = admin
            .create_topics(
                &[
                    NewTopic::new(&env.raw, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "6291456")
                        .set("retention.ms", if bytes { "21600000" } else { "1000" })
                        .set(
                            "retention.bytes",
                            if bytes { "1048576" } else { "134217728" },
                        )
                        .set("segment.bytes", "1048576")
                        .set("segment.ms", "1000"),
                    NewTopic::new(&env.normalized, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "2097152"),
                    NewTopic::new(&env.late, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "2097152"),
                ],
                &AdminOptions::new().request_timeout(Some(Duration::from_secs(5))),
            )
            .await
            .unwrap();
        assert!(results.iter().all(Result::is_ok), "{results:?}");
        let observer = consumer(&env.broker, &env.group);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if [&env.raw, &env.normalized, &env.late].iter().all(|topic| {
                (0..3).all(|p| {
                    observer
                        .fetch_watermarks(topic, p, Duration::from_secs(1))
                        .is_ok_and(|v| v == (0, 0))
                })
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned topics not ready: {prefix}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut seed = TopicPartitionList::new();
        for p in 0..3 {
            seed.add_partition_offset(&env.raw, p, Offset::Offset(0))
                .unwrap();
        }
        observer.assign(&seed).unwrap();
        observer.commit(&seed, CommitMode::Sync).unwrap();
        let metrics = std::env::temp_dir().join(format!("{prefix}.prom"));
        let mut paused = if bytes {
            None
        } else {
            let process = Process(
                env.command()
                    .env("RECOUNT_NORMALIZER_METRICS_FILE", &metrics)
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let groups = observer
                    .fetch_group_list(Some(&env.group), Duration::from_secs(2))
                    .unwrap();
                if groups
                    .groups()
                    .iter()
                    .any(|group| group.state() == "Stable" && group.members().len() == 1)
                {
                    break;
                }
                assert!(Instant::now() < deadline, "owned worker did not join");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(
                Command::new("kill")
                    .args(["-STOP", &process.0.id().to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
            Some(process)
        };
        let mut raw = cases::raw();
        if bytes {
            // Wide single-point records exercise byte eviction without turning this
            // expiry case into another throughput benchmark.
            let mut request = cases::request();
            request.resource_metrics.truncate(1);
            let scope = &mut request.resource_metrics[0].scope_metrics[0];
            scope.metrics.truncate(1);
            let metric = &mut scope.metrics[0];
            metric.description = "x".repeat(32768);
            let Some(Data::Gauge(gauge)) = &mut metric.data else {
                panic!("single-point gauge fixture");
            };
            gauge.data_points.truncate(1);
            raw.otlp_request = request.encode_to_vec();
            raw.bindings.truncate(1);
        }
        let body = raw.encode_to_vec();
        let key = identity::raw_routing_key(&raw).unwrap();
        let publish = || async {
            producer
                .send(
                    FutureRecord::to(&env.raw)
                        .partition(0)
                        .key(&key)
                        .payload(&body),
                    Timeout::After(Duration::from_secs(1)),
                )
                .await
                .unwrap();
        };
        publish().await;
        tokio::time::sleep(Duration::from_millis(1250)).await;
        let count = if bytes {
            3 * 1048576 / body.len() + 10
        } else {
            1
        };
        for _ in 0..count {
            publish().await;
        }
        let deadline = Instant::now() + Duration::from_secs(100);
        let low = loop {
            let (low, _) = observer
                .fetch_watermarks(&env.raw, 0, Duration::from_secs(3))
                .unwrap();
            if low > 0 {
                break low;
            }
            assert!(
                Instant::now() < deadline,
                "owned prefix did not expire: {prefix}"
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        publish().await;
        let high = observer
            .fetch_watermarks(&env.raw, 0, Duration::from_secs(3))
            .unwrap()
            .1;
        let reader = consumer(&env.broker, &format!("{}.observer", env.group));
        let mut outputs = TopicPartitionList::new();
        for p in 0..3 {
            outputs
                .add_partition_offset(&env.late, p, Offset::Offset(0))
                .unwrap();
        }
        reader.assign(&outputs).unwrap();
        if let Some(process) = &mut paused {
            assert!(
                Command::new("kill")
                    .args(["-CONT", &process.0.id().to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
        } else {
            paused = Some(Process(
                env.command()
                    .env("RECOUNT_NORMALIZER_METRICS_FILE", &metrics)
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            ));
        }
        committed(&observer, &env.raw, 0, high).await;
        let expected: BTreeMap<_, _> = recount_normalizer::prepare(
            &body,
            Some(&key),
            3,
            recount_telemetry_validation::validate::Limits::default(),
        )
        .unwrap()
        .into_iter()
        .map(|record| {
            let row = AnalyticalPoint::decode(record.payload.as_slice()).unwrap();
            (row.sample_id.clone(), row)
        })
        .collect();
        assert_eq!(
            collect(&reader, expected.len(), "retained suffix").await,
            expected
        );
        let metric = std::fs::read_to_string(&metrics).unwrap();
        let resets: u64 = metric
            .lines()
            .find_map(|line| line.strip_prefix("recount_normalizer_retention_gaps_total "))
            .unwrap()
            .parse()
            .unwrap();
        let process = paused.as_mut().unwrap();
        assert!(
            process.0.try_wait().unwrap().is_none(),
            "retention stopped the worker"
        );
        process.0.kill().unwrap();
        process.0.wait().unwrap();
        let mut warning = String::new();
        process
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut warning)
            .unwrap();
        assert!(resets > 0, "{metric}\n{warning}");
        assert!(
            warning.contains("event=retention_gap action=resume_earliest")
                && warning.contains(&env.raw),
            "{warning}"
        );
        for p in 0..3 {
            assert_eq!(
                observer
                    .fetch_watermarks(&env.normalized, p, Duration::from_secs(3))
                    .unwrap(),
                (0, 0)
            );
        }
        std::fs::remove_file(metrics).unwrap();
        eprintln!(
            "expiry_recovered cause={} earliest={low} committed={high} resets={resets} topic={}",
            if bytes { "bytes" } else { "time" },
            env.raw
        );
        let results = admin
            .delete_topics(
                &[&env.raw, &env.normalized, &env.late],
                &AdminOptions::new(),
            )
            .await
            .unwrap();
        assert!(results.iter().all(Result::is_ok), "{results:?}");
    }
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing explicit integration setting: {name}"))
}

struct Environment {
    binary: PathBuf,
    broker: String,
    raw: String,
    normalized: String,
    /// Receives the fixtures' points, which are older than the recent window.
    late: String,
    group: String,
}
impl Environment {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .env_clear()
            .env("RECOUNT_KAFKA_BOOTSTRAP", &self.broker)
            .env("RECOUNT_RAW_TOPIC", &self.raw)
            .env("RECOUNT_NORMALIZED_TOPIC", &self.normalized)
            .env("RECOUNT_LATE_TOPIC", &self.late)
            .env("RECOUNT_NORMALIZER_GROUP", &self.group)
            .env("RECOUNT_RAW_PARTITIONS", "3")
            .env("RECOUNT_NORMALIZED_PARTITIONS", "3")
            .env("RECOUNT_RAW_BROKER_MAX_BYTES", "6291456")
            .env("RECOUNT_NORMALIZED_BROKER_MAX_BYTES", "2097152")
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        command
    }
    fn start(&self) -> Process {
        Process(self.command().stderr(Stdio::inherit()).spawn().unwrap())
    }

    /// Creates empty three-partition raw, normalized and late topics under `prefix`.
    async fn create(broker: &str, prefix: &str) -> Self {
        let env = Self {
            binary: env!("CARGO_BIN_EXE_recount-normalizer").into(),
            broker: broker.into(),
            raw: format!("{prefix}.raw"),
            normalized: format!("{prefix}.normalized"),
            late: format!("{prefix}.late"),
            group: format!("{prefix}.group"),
        };
        eprintln!(
            "normalizer_allocation raw={} normalized={} late={} group={}",
            env.raw, env.normalized, env.late, env.group
        );
        let results = admin(broker)
            .create_topics(
                &[
                    NewTopic::new(&env.raw, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "6291456"),
                    NewTopic::new(&env.normalized, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "2097152"),
                    NewTopic::new(&env.late, 3, TopicReplication::Fixed(1))
                        .set("max.message.bytes", "2097152"),
                ],
                &AdminOptions::new().request_timeout(Some(Duration::from_secs(5))),
            )
            .await
            .unwrap();
        assert!(
            results.iter().all(Result::is_ok),
            "fresh topic creation failed: {results:?}"
        );
        let observer = consumer(broker, &env.group);
        let deadline = Instant::now() + Duration::from_secs(10);
        while ![&env.raw, &env.normalized, &env.late].iter().all(|topic| {
            (0..3).all(|p| {
                observer
                    .fetch_watermarks(topic, p, Duration::from_secs(1))
                    .is_ok_and(|v| v == (0, 0))
            })
        }) {
            assert!(Instant::now() < deadline, "fresh topics not ready");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        env
    }

    /// The same allocation, with the process connecting through another bootstrap.
    fn via(&self, broker: &str) -> Self {
        Self {
            binary: self.binary.clone(),
            broker: broker.into(),
            raw: self.raw.clone(),
            normalized: self.normalized.clone(),
            late: self.late.clone(),
            group: self.group.clone(),
        }
    }

    /// Deletes the owned topics and group; stopped members' sessions must expire first.
    async fn remove(&self) {
        let admin = admin(&self.broker);
        let options = AdminOptions::new().request_timeout(Some(Duration::from_secs(5)));
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let result = admin.delete_groups(&[&self.group], &options).await.unwrap();
            match &result[0] {
                Ok(_) | Err((_, RDKafkaErrorCode::GroupIdNotFound)) => break,
                Err((_, RDKafkaErrorCode::NonEmptyGroup)) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(error) => panic!("owned group cleanup failed: {error:?}"),
            }
        }
        let results = admin
            .delete_topics(&[&self.raw, &self.normalized, &self.late], &options)
            .await
            .unwrap();
        assert!(
            results.iter().all(Result::is_ok),
            "owned topic cleanup failed: {results:?}"
        );
    }
}

fn admin(broker: &str) -> AdminClient<DefaultClientContext> {
    ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()
        .unwrap()
}

fn producer(broker: &str) -> FutureProducer {
    ClientConfig::new()
        .set("bootstrap.servers", broker)
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .set("message.timeout.ms", "10000")
        .create()
        .unwrap()
}

fn signal(process: &Process, name: &str) {
    assert!(
        Command::new("kill")
            .args([&format!("-{name}"), &process.0.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
}

/// Unique allocation prefix for one live case under the explicit test namespace.
fn allocation(label: &str) -> String {
    let namespace = setting("RECOUNT_NORMALIZER_TEST_NAMESPACE");
    assert!(
        namespace.starts_with("recount.")
            && namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    );
    format!(
        "{namespace}.normalizer.{label}.{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn now_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .try_into()
        .unwrap()
}

/// Expected bare-point payloads by sample ID, as the normalizer prepares them.
fn prepared(body: &[u8], key: &[u8]) -> BTreeMap<Vec<u8>, Vec<u8>> {
    recount_normalizer::prepare(
        body,
        Some(key),
        3,
        recount_telemetry_validation::validate::Limits::default(),
    )
    .unwrap()
    .into_iter()
    .map(|record| {
        let point = AnalyticalPoint::decode(record.payload.as_slice()).unwrap();
        (point.sample_id, record.payload)
    })
    .collect()
}

async fn publish(producer: &FutureProducer, topic: &str, partition: i32, raw: &RawRecord) -> i64 {
    let key = identity::raw_routing_key(raw).unwrap();
    producer
        .send(
            FutureRecord::to(topic)
                .partition(partition)
                .key(&key)
                .payload(&raw.encode_to_vec()),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .map_err(|(error, _)| error)
        .expect("raw publication failed")
        .offset
}

/// Raw inputs queued before a case starts its normalizers, with the samples
/// each retained offset must produce.
struct Backlog {
    per_partition: i64,
    samples: BTreeMap<(i32, i64), Vec<Vec<u8>>>,
    expected: BTreeMap<Vec<u8>, Vec<u8>>,
    raw_bytes: usize,
}

impl Backlog {
    async fn publish(broker: &str, topic: &str, per_partition: i64, label: &str) -> Self {
        let producer = producer(broker);
        let mut backlog = Self {
            per_partition,
            samples: BTreeMap::new(),
            expected: BTreeMap::new(),
            raw_bytes: 0,
        };
        let inputs: Vec<_> = (0..per_partition * 3)
            .map(|index| {
                let mut raw = cases::raw();
                raw.batch.as_mut().unwrap().client_id = format!("{label}-{index}");
                ((index % 3) as i32, raw)
            })
            .collect();
        for chunk in inputs.chunks(64) {
            let offsets = join_all(
                chunk
                    .iter()
                    .map(|(partition, raw)| publish(&producer, topic, *partition, raw)),
            )
            .await;
            for ((partition, raw), offset) in chunk.iter().zip(offsets) {
                let body = raw.encode_to_vec();
                backlog.raw_bytes += body.len();
                let expected = prepared(&body, &identity::raw_routing_key(raw).unwrap());
                backlog
                    .samples
                    .insert((*partition, offset), expected.keys().cloned().collect());
                backlog.expected.extend(expected);
            }
        }
        backlog
    }

    fn inputs(&self) -> i64 {
        self.per_partition * 3
    }
}

/// Next raw offsets committed by the group, with no checkpoint read as zero.
fn checkpoints(observer: &BaseConsumer, topic: &str) -> Vec<i64> {
    let mut query = TopicPartitionList::new();
    for p in 0..3 {
        query.add_partition(topic, p);
    }
    let offsets = observer
        .committed_offsets(query, Duration::from_secs(3))
        .unwrap();
    (0..3)
        .map(
            |p| match offsets.find_partition(topic, p).unwrap().offset() {
                Offset::Offset(next) => next,
                Offset::Invalid => 0,
                other => panic!("unexpected checkpoint {other:?}"),
            },
        )
        .collect()
}

/// Reads every output record from offset zero. Replays must be byte-identical,
/// so one payload per sample remains and physical duplicates are counted.
struct Tail {
    consumer: BaseConsumer,
    topics: Vec<String>,
    next: BTreeMap<(String, i32), i64>,
    rows: BTreeMap<Vec<u8>, (String, Vec<u8>)>,
    duplicates: usize,
}

impl Tail {
    fn new(broker: &str, topics: &[&str]) -> Self {
        let consumer = ClientConfig::new()
            .set("bootstrap.servers", broker)
            // Assignment requires a group name; this reader never joins or commits.
            .set("group.id", format!("{}.tail", topics[0]))
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", "error")
            .create::<BaseConsumer>()
            .unwrap();
        let mut assignment = TopicPartitionList::new();
        for topic in topics {
            for p in 0..3 {
                assignment
                    .add_partition_offset(topic, p, Offset::Offset(0))
                    .unwrap();
            }
        }
        consumer.assign(&assignment).unwrap();
        Self {
            consumer,
            topics: topics.iter().map(|topic| (*topic).to_owned()).collect(),
            next: BTreeMap::new(),
            rows: BTreeMap::new(),
            duplicates: 0,
        }
    }

    /// Consumes until every output partition reaches its current high watermark.
    async fn catch_up(&mut self) {
        let mut targets = Vec::new();
        for topic in &self.topics {
            for p in 0..3 {
                let (_, high) = self
                    .consumer
                    .fetch_watermarks(topic, p, Duration::from_secs(3))
                    .unwrap();
                targets.push(((topic.clone(), p), high));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while !targets
            .iter()
            .all(|(position, high)| self.next.get(position).copied().unwrap_or(0) >= *high)
        {
            assert!(Instant::now() < deadline, "output tail did not catch up");
            let Some(message) = self.consumer.poll(Duration::ZERO) else {
                tokio::time::sleep(Duration::from_millis(5)).await;
                continue;
            };
            let message = message.unwrap();
            let body = message.payload().unwrap();
            let point = AnalyticalPoint::decode(body).unwrap();
            assert_eq!(
                identity::partition(point.stream_id.as_slice().try_into().unwrap(), 3),
                Some(message.partition() as u32)
            );
            self.next.insert(
                (message.topic().to_owned(), message.partition()),
                message.offset() + 1,
            );
            let row = (message.topic().to_owned(), body.to_vec());
            match self.rows.entry(point.sample_id) {
                Entry::Vacant(entry) => {
                    entry.insert(row);
                }
                Entry::Occupied(entry) => {
                    assert_eq!(
                        entry.get(),
                        &row,
                        "replay changed a sample's topic or bytes"
                    );
                    self.duplicates += 1;
                }
            }
        }
    }

    fn payloads(&self) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.rows
            .iter()
            .map(|(sample, (_, payload))| (sample.clone(), payload.clone()))
            .collect()
    }

    fn topic(&self, topic: &str) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.rows
            .iter()
            .filter(|(_, (name, _))| name == topic)
            .map(|(sample, (_, payload))| (sample.clone(), payload.clone()))
            .collect()
    }

    /// Counts published samples of backlog inputs at or above the checkpoints,
    /// after requiring every sample below them: no checkpoint passes unfinished work.
    fn unsettled(&self, backlog: &Backlog, checkpoints: &[i64]) -> usize {
        let mut unsettled = 0;
        for ((partition, offset), samples) in &backlog.samples {
            let settled = *offset < checkpoints[*partition as usize];
            for sample in samples {
                let published = self.rows.contains_key(sample);
                assert!(
                    published || !settled,
                    "checkpoints {checkpoints:?} passed an input whose output is missing"
                );
                unsettled += usize::from(published && !settled);
            }
        }
        unsettled
    }
}

fn consumer(broker: &str, group: &str) -> BaseConsumer {
    ClientConfig::new()
        .set("bootstrap.servers", broker)
        .set("group.id", group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "error")
        .set("allow.auto.create.topics", "false")
        .create()
        .unwrap()
}

async fn collect(
    consumer: &BaseConsumer,
    expected: usize,
    phase: &str,
) -> BTreeMap<Vec<u8>, AnalyticalPoint> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut rows = BTreeMap::new();
    while rows.len() < expected && Instant::now() < deadline {
        if let Some(message) = consumer.poll(Duration::ZERO) {
            let message = message.unwrap();
            let body = message.payload().unwrap();
            assert!(body.len() <= 1048576);
            let point = AnalyticalPoint::decode(body).unwrap();
            assert_eq!(
                identity::partition(point.stream_id.as_slice().try_into().unwrap(), 3),
                Some(message.partition() as u32)
            );
            rows.insert(point.sample_id.clone(), point);
        } else {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    assert_eq!(
        rows.len(),
        expected,
        "normalized output did not complete during {phase}"
    );
    rows
}

async fn committed(observer: &BaseConsumer, topic: &str, partition: i32, next: i64) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut query = TopicPartitionList::new();
        query.add_partition(topic, partition);
        let offsets = observer
            .committed_offsets(query, Duration::from_secs(1))
            .unwrap();
        let actual = offsets.find_partition(topic, partition).unwrap().offset();
        if actual == Offset::Offset(next) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "raw completion checkpoint not confirmed: expected={next} actual={actual:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Requires a coordinator-allocated, disposable Kafka slot and precreated empty
/// topics. Does not create/delete topics, groups, tables, or broker containers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh isolated topics/group"]
async fn real_kafka_first_start_replay_rebalance_and_global_handler_poison() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let env = Environment {
        binary: env!("CARGO_BIN_EXE_recount-normalizer").into(),
        broker: setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        raw: setting("RECOUNT_NORMALIZER_TEST_RAW_TOPIC"),
        normalized: setting("RECOUNT_NORMALIZER_TEST_NORMALIZED_TOPIC"),
        late: setting("RECOUNT_NORMALIZER_TEST_LATE_TOPIC"),
        group: setting("RECOUNT_NORMALIZER_TEST_GROUP"),
    };
    let namespace = setting("RECOUNT_NORMALIZER_TEST_NAMESPACE");
    assert!(namespace.starts_with("recount."));
    for name in [&env.raw, &env.normalized, &env.late, &env.group] {
        assert!(name.starts_with(&format!("{namespace}.normalizer.")));
    }
    let observer = consumer(&env.broker, &env.group);
    let mut assignment = TopicPartitionList::new();
    for partition in 0..3 {
        for topic in [&env.raw, &env.normalized, &env.late] {
            assert_eq!(
                observer
                    .fetch_watermarks(topic, partition, Duration::from_secs(3))
                    .unwrap(),
                (0, 0),
                "requires empty isolated topics"
            );
        }
        assignment
            .add_partition_offset(&env.late, partition, Offset::Offset(0))
            .unwrap();
    }
    let reader = consumer(&env.broker, &format!("{}.observer", env.group));
    reader.assign(&assignment).unwrap();
    assert!(
        !env.command()
            .env("RECOUNT_NORMALIZED_PARTITIONS", "2")
            .output()
            .unwrap()
            .status
            .success()
    );

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &env.broker)
        .set("enable.idempotence", "true")
        .set("acks", "all")
        .set("message.timeout.ms", "5000")
        .create()
        .unwrap();
    let raw = cases::raw();
    let body = raw.encode_to_vec();
    let key = identity::raw_routing_key(&raw).unwrap();
    let expected = recount_normalizer::prepare(
        &body,
        Some(&key),
        3,
        recount_telemetry_validation::validate::Limits::default(),
    )
    .unwrap()
    .len();
    let process = env.start();
    let delivery = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(0)
                .key(&key)
                .payload(&body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    let original = collect(&reader, expected, "initial publication").await;
    committed(&observer, &env.raw, 0, delivery.offset + 1).await;
    drop(process);

    let mut queued = raw.clone();
    queued.batch.as_mut().unwrap().client_id = "queued-during-restart".into();
    let queued_body = queued.encode_to_vec();
    let queued_key = identity::raw_routing_key(&queued).unwrap();
    let delivery = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(0)
                .key(&queued_key)
                .payload(&queued_body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    let queued_expected: BTreeMap<_, _> = recount_normalizer::prepare(
        &queued_body,
        Some(&queued_key),
        3,
        recount_telemetry_validation::validate::Limits::default(),
    )
    .unwrap()
    .into_iter()
    .map(|record| {
        let point = AnalyticalPoint::decode(record.payload.as_slice()).unwrap();
        assert!(!original.contains_key(&point.sample_id));
        (point.sample_id.clone(), point)
    })
    .collect();
    let mut process = env.start();
    assert_eq!(
        collect(&reader, queued_expected.len(), "backlog after restart").await,
        queued_expected
    );
    committed(&observer, &env.raw, 0, delivery.offset + 1).await;

    // Immutable input replay after a process crash produces identical row IDs,
    // event partitions and values despite a different raw Kafka offset.
    let delivery = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(0)
                .key(&key)
                .payload(&body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    assert_eq!(collect(&reader, expected, "process replay").await, original);
    committed(&observer, &env.raw, 0, delivery.offset + 1).await;

    // Rebalance with two actual consumers, then poison one input partition.
    let mut second = env.start();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let groups = observer
            .fetch_group_list(Some(&env.group), Duration::from_secs(2))
            .unwrap();
        if groups.groups().iter().any(|group| {
            group.state() == "Stable"
                && group.members().len() == 2
                && group
                    .members()
                    .iter()
                    .all(|member| member.assignment().is_some_and(|a| !a.is_empty()))
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "two live consumers did not stabilize before poison publication"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let probe = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(1)
                .key(&key)
                .payload(&body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    assert_eq!(
        collect(&reader, expected, "stable rebalance before poison").await,
        original
    );
    committed(&observer, &env.raw, 1, probe.offset + 1).await;
    let output_before: i64 = (0..3)
        .map(|p| {
            observer
                .fetch_watermarks(&env.late, p, Duration::from_secs(3))
                .unwrap()
                .1
        })
        .sum();
    let bad = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(0)
                .key(&[0u8; 32])
                .payload(&body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let a = process.0.try_wait().unwrap();
        let b = second.0.try_wait().unwrap();
        if let (Some(a), Some(b)) = (a, b) {
            assert!(!a.success() && !b.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "poison did not stop group members"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let output_after: i64 = (0..3)
        .map(|p| {
            observer
                .fetch_watermarks(&env.late, p, Duration::from_secs(3))
                .unwrap()
                .1
        })
        .sum();
    assert_eq!(output_after, output_before, "poison published output");
    let mut query = TopicPartitionList::new();
    query.add_partition(&env.raw, 0);
    assert_eq!(
        observer
            .committed_offsets(query, Duration::from_secs(3))
            .unwrap()
            .find_partition(&env.raw, 0)
            .unwrap()
            .offset(),
        Offset::Offset(bad.offset)
    );
    drop(second);
    drop(process);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh topic permission"]
async fn in_flight_rebalance_never_commits_past_unfinished_work() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let env = Environment::create(
        &setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        &allocation("rebalance"),
    )
    .await;
    let backlog = Backlog::publish(&env.broker, &env.raw, 600, "rebalance").await;
    let observer = consumer(&env.broker, &env.group);
    let mut tail = Tail::new(&env.broker, &[&env.normalized, &env.late]);
    let mut members = vec![env.start()];
    let mut stage = 0;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let settled = checkpoints(&observer, &env.raw);
        tail.catch_up().await;
        let unsettled = tail.unsettled(&backlog, &settled);
        let done: i64 = settled.iter().sum();
        if done == backlog.inputs() {
            break;
        }
        // Membership changes while members still hold published but unsettled inputs:
        // a join revokes assigned partitions, an abrupt exit sends no LeaveGroup, and
        // a terminated member drains during revocation.
        let event = match stage {
            0 if done * 10 >= backlog.inputs() => {
                members.push(env.start());
                "join"
            }
            1 if done * 4 >= backlog.inputs() => {
                signal(&members[0], "KILL");
                "abrupt_exit"
            }
            2 if done * 5 >= backlog.inputs() * 2 => {
                members.push(env.start());
                signal(&members[1], "TERM");
                "join_and_terminate"
            }
            _ => "",
        };
        if !event.is_empty() {
            eprintln!(
                "rebalance_event={event} checkpoints={settled:?} published_unsettled_samples={unsettled}"
            );
            stage += 1;
        }
        assert!(
            Instant::now() < deadline,
            "rebalanced backlog stalled: checkpoints={settled:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(stage, 3, "backlog finished before every membership change");
    tail.catch_up().await;
    assert!(
        tail.payloads() == backlog.expected,
        "normalized sample identities/projections differ after rebalance"
    );
    assert!(
        tail.duplicates > 0,
        "no published but unsettled input was replayed"
    );
    eprintln!(
        "rebalance_complete inputs={} logical_samples={} identical_replays={}",
        backlog.inputs(),
        backlog.expected.len(),
        tail.duplicates
    );
    drop(members);
    env.remove().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh topic permission"]
async fn out_of_order_event_times_split_recent_and_late_with_exact_identities() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let env = Environment::create(
        &setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        &allocation("event-order"),
    )
    .await;
    const HOUR: i64 = 3_600_000_000_000;
    let now = now_nanos();
    // Hours from now in arrival order, deliberately unsorted within each batch,
    // partition and node. Points within 24 hours either way are recent.
    let batches: [(&str, i32, [i64; 4]); 6] = [
        ("node-a", 0, [-72, 1, -2, 30]),
        ("node-b", 2, [2, -30, -12, 48]),
        ("node-a", 1, [-1, -48, 23, -25]),
        ("node-b", 0, [-200, 12, -23, 26]),
        ("node-a", 2, [6, -6, -96, 0]),
        ("node-b", 1, [-26, 3, 22, -3]),
    ];
    let producer = producer(&env.broker);
    let (mut recent, mut late) = (BTreeMap::new(), BTreeMap::new());
    let mut inputs = [0; 3];
    for (index, (node, partition, hours)) in batches.into_iter().enumerate() {
        let mut raw = cases::single_resource(cases::single_gauge_resource(
            hours
                .iter()
                .map(|hour| {
                    cases::number(
                        Some(Value::AsInt(*hour)),
                        now.checked_add_signed(hour * HOUR).unwrap(),
                    )
                })
                .collect(),
        ));
        raw.security.as_mut().unwrap().source_id = node.into();
        raw.batch.as_mut().unwrap().client_id = format!("{node}-{index}");
        publish(&producer, &env.raw, partition, &raw).await;
        inputs[partition as usize] += 1;
        let body = raw.encode_to_vec();
        for (sample, payload) in prepared(&body, &identity::raw_routing_key(&raw).unwrap()) {
            let point = AnalyticalPoint::decode(payload.as_slice()).unwrap();
            if point.time_unix_nano.abs_diff(now) < 24 * HOUR as u64 {
                recent.insert(sample, payload);
            } else {
                late.insert(sample, payload);
            }
        }
    }
    assert_eq!((recent.len(), late.len()), (14, 10));
    let observer = consumer(&env.broker, &env.group);
    let process = env.start();
    let deadline = Instant::now() + Duration::from_secs(30);
    while checkpoints(&observer, &env.raw) != inputs {
        assert!(Instant::now() < deadline, "unordered inputs not settled");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut tail = Tail::new(&env.broker, &[&env.normalized, &env.late]);
    tail.catch_up().await;
    assert_eq!(tail.duplicates, 0);
    assert!(
        tail.topic(&env.normalized) == recent,
        "recent topic differs"
    );
    assert!(tail.topic(&env.late) == late, "late topic differs");
    drop(process);
    env.remove().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh topic permission"]
async fn backlog_catchup_peak_rss_stays_bounded() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let broker = setting("RECOUNT_NORMALIZER_TEST_BROKER");
    let mut peaks = Vec::new();
    // Both backlogs exceed what the consumer prefetches, so doubling the
    // queued input must not raise the plateau.
    for per_partition in [3000, 6000] {
        let env = Environment::create(&broker, &allocation(&format!("rss-{per_partition}"))).await;
        let backlog = Backlog::publish(&broker, &env.raw, per_partition, "rss").await;
        let observer = consumer(&broker, &env.group);
        let started = Instant::now();
        let process = env.start();
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut peak = 0;
        for sample in 0.. {
            // Sampled every 20 ms; ru_maxrss would also capture shorter spikes.
            let rss = Command::new("ps")
                .args(["-o", "rss=", "-p", &process.0.id().to_string()])
                .output()
                .unwrap();
            if let Ok(kib) = String::from_utf8_lossy(&rss.stdout).trim().parse::<u64>() {
                peak = peak.max(kib);
            }
            if sample % 10 == 0
                && checkpoints(&observer, &env.raw).iter().sum::<i64>() == backlog.inputs()
            {
                break;
            }
            assert!(Instant::now() < deadline, "RSS backlog did not settle");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        eprintln!(
            "catchup_rss inputs={} logical_samples={} raw_payload_bytes={} peak_rss_kib={peak} catchup_seconds={:.3}",
            backlog.inputs(),
            backlog.expected.len(),
            backlog.raw_bytes,
            started.elapsed().as_secs_f64()
        );
        drop(process);
        env.remove().await;
        peaks.push(peak);
    }
    assert!(
        peaks[1] * 4 <= peaks[0] * 5,
        "peak RSS grew with backlog size: {peaks:?} KiB"
    );
}

fn output_records(observer: &BaseConsumer, topic: &str) -> i64 {
    (0..3)
        .map(|p| {
            observer
                .fetch_watermarks(topic, p, Duration::from_secs(3))
                .unwrap()
                .1
        })
        .sum()
}

/// Waits until the group settles `total` raw inputs. Like a supervisor, it
/// replaces a member that failed fast and returns the number of replacements.
async fn supervise(
    env: &Environment,
    process: &mut Process,
    observer: &BaseConsumer,
    total: i64,
) -> usize {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut replacements = 0;
    while checkpoints(observer, &env.raw).iter().sum::<i64>() < total {
        if let Some(status) = process.0.try_wait().unwrap() {
            assert!(!status.success());
            replacements += 1;
            *process = env.start();
        }
        assert!(Instant::now() < deadline, "raw inputs were not settled");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    replacements
}

/// Waits for a member to exit.
async fn exited(process: &mut Process, seconds: u64) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if let Some(status) = process.0.try_wait().unwrap() {
            return Some(status);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an owned disposable Kafka container and Toxiproxy"]
async fn owned_broker_lost_commit_and_publication_acknowledgements_replay_identically() {
    let broker = disposable::Broker::start();
    let env = Environment::create(&broker.direct, &allocation("acknowledgement")).await;
    let proxied = env.via(&broker.proxied);
    let observer = consumer(&broker.direct, &env.group);
    let mut tail = Tail::new(&broker.direct, &[&env.normalized, &env.late]);
    let producer = producer(&broker.direct);
    let mut expected = BTreeMap::new();
    let mut process = proxied.start();

    // A commit reaches Kafka while its response is dropped; the member never sees it.
    let mut attempt = 0;
    let committed_offset = loop {
        attempt += 1;
        assert!(
            attempt <= 5,
            "every commit completed before responses were dropped"
        );
        let mut raw = cases::raw();
        raw.batch.as_mut().unwrap().client_id = format!("commit-{attempt}");
        let samples = prepared(
            &raw.encode_to_vec(),
            &identity::raw_routing_key(&raw).unwrap(),
        );
        let written = output_records(&observer, &env.late);
        let offset = publish(&producer, &env.raw, 0, &raw).await;
        // Watermarks show the output sooner than a fetch, ahead of the one-second commit.
        let deadline = Instant::now() + Duration::from_secs(30);
        while output_records(&observer, &env.late) < written + samples.len() as i64 {
            assert!(Instant::now() < deadline, "commit-phase output missing");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        expected.extend(samples);
        broker.drop_responses();
        if checkpoints(&observer, &env.raw)[0] > offset {
            broker.restore_responses();
            continue;
        }
        committed(&observer, &env.raw, 0, offset + 1).await;
        break offset + 1;
    };
    // Exceed the client socket timeout so the commit and fetch requests fail locally.
    tokio::time::sleep(Duration::from_secs(5)).await;
    broker.restore_responses();
    let mut raw = cases::raw();
    raw.batch.as_mut().unwrap().client_id = "after-commit-loss".into();
    publish(&producer, &env.raw, 0, &raw).await;
    expected.extend(prepared(
        &raw.encode_to_vec(),
        &identity::raw_routing_key(&raw).unwrap(),
    ));
    let replacements = supervise(&proxied, &mut process, &observer, committed_offset + 1).await;
    tail.catch_up().await;
    assert!(
        tail.payloads() == expected,
        "commit acknowledgement loss changed output"
    );
    eprintln!(
        "commit_acknowledgement_lost checkpoint={committed_offset} attempts={attempt} replacements={replacements} identical_replays={}",
        tail.duplicates
    );

    // Publications reach Kafka while their acknowledgements are dropped; the
    // member must fail before settling them, and a replacement replays them.
    let duplicates_before = tail.duplicates;
    let start = checkpoints(&observer, &env.raw);
    let backlog = Backlog::publish(&broker.direct, &env.raw, 200, "publication").await;
    expected.extend(backlog.expected.clone());
    let total: i64 = start.iter().sum::<i64>() + backlog.inputs();
    let deadline = Instant::now() + Duration::from_secs(60);
    while (checkpoints(&observer, &env.raw).iter().sum::<i64>() - (total - backlog.inputs())) * 5
        < backlog.inputs()
    {
        assert!(
            Instant::now() < deadline,
            "publication backlog did not start"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    broker.drop_responses();
    // Delivery (10 s), shutdown (15 s), flush (3 s) and the exit margin (2 s)
    // bound the failed member's exit while Kafka still sends no responses.
    let status = exited(&mut process, 45)
        .await
        .expect("member did not exit while Kafka responses were dropped");
    broker.restore_responses();
    assert!(!status.success());
    let settled = checkpoints(&observer, &env.raw);
    tail.catch_up().await;
    let unsettled = tail.unsettled(&backlog, &settled);
    assert!(
        unsettled > 0,
        "no publication was written without acknowledgement"
    );
    process = proxied.start();
    supervise(&proxied, &mut process, &observer, total).await;
    tail.catch_up().await;
    assert!(
        tail.payloads() == expected,
        "publication acknowledgement loss changed output"
    );
    assert!(tail.duplicates - duplicates_before >= unsettled);
    eprintln!(
        "publication_acknowledgement_lost checkpoints={settled:?} published_unsettled_samples={unsettled} identical_replays={}",
        tail.duplicates - duplicates_before
    );
    drop(process);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an owned disposable Kafka container and Toxiproxy"]
async fn owned_broker_restart_during_backlog_resumes_without_loss() {
    let broker = disposable::Broker::start();
    let env = Environment::create(&broker.direct, &allocation("broker-restart")).await;
    let proxied = env.via(&broker.proxied);
    let observer = consumer(&broker.direct, &env.group);
    let backlog = Backlog::publish(&broker.direct, &env.raw, 300, "before-restart").await;
    let mut process = proxied.start();
    let deadline = Instant::now() + Duration::from_secs(60);
    while checkpoints(&observer, &env.raw).iter().sum::<i64>() * 10 < backlog.inputs() * 3 {
        assert!(Instant::now() < deadline, "backlog did not start");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interrupted = checkpoints(&observer, &env.raw);
    broker.kill();
    tokio::time::sleep(Duration::from_secs(3)).await;
    broker.restart();
    // The previous observer may still be reconnecting.
    let observer = consumer(&broker.direct, &env.group);
    // Acknowledged raw input survives the unclean broker stop.
    for p in 0..3 {
        assert_eq!(
            observer
                .fetch_watermarks(&env.raw, p, Duration::from_secs(5))
                .unwrap(),
            (0, backlog.per_partition)
        );
    }
    let after = Backlog::publish(&broker.direct, &env.raw, 20, "after-restart").await;
    let mut expected = backlog.expected.clone();
    expected.extend(after.expected.clone());
    let total = backlog.inputs() + after.inputs();
    // A member whose delivery deadline expires during the outage fails fast.
    let restarts = supervise(&proxied, &mut process, &observer, total).await;
    let mut tail = Tail::new(&broker.direct, &[&env.normalized, &env.late]);
    tail.catch_up().await;
    assert!(tail.payloads() == expected, "broker restart changed output");
    eprintln!(
        "broker_restart_recovered interrupted_checkpoints={interrupted:?} member_restarts={restarts} logical_samples={} identical_replays={}",
        expected.len(),
        tail.duplicates
    );
    drop(process);
}
