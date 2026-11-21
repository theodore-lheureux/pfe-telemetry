use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, CommitMode, Consumer},
    message::Message as _,
    producer::{FutureProducer, FutureRecord},
    util::Timeout,
};
use recount_telemetry_schema::{identity, metrics::metric::Data, wire::AnalyticalPoint};
#[cfg(unix)]
use std::io::Read;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;

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
    let prefix = format!("{namespace}.normalizer.progress.{unique}");
    let env = Environment {
        binary: env!("CARGO_BIN_EXE_recount-normalizer").into(),
        broker: setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        raw: format!("{prefix}.raw"),
        normalized: format!("{prefix}.normalized"),
        late: format!("{prefix}.late"),
        group: format!("{prefix}.group"),
    };
    eprintln!(
        "progress_allocation raw={} normalized={} group={}",
        env.raw, env.normalized, env.group
    );
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", &env.broker)
        .create()
        .unwrap();
    let results = admin
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
        "fresh progress topic creation failed: {results:?}"
    );
    let observer = consumer(&env.broker, &env.group);
    let ready_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let ready = [&env.raw, &env.normalized, &env.late].iter().all(|topic| {
            (0..3).all(|p| {
                observer
                    .fetch_watermarks(topic, p, Duration::from_secs(1))
                    .is_ok_and(|v| v == (0, 0))
            })
        });
        if ready {
            break;
        }
        assert!(
            Instant::now() < ready_deadline,
            "fresh progress topics not ready"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
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
            expected.insert(
                (
                    (index % 3) as u32,
                    (index / 3) as u64,
                    row.original_position.clone(),
                ),
                observation(row),
            );
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
            (
                (0, (high - 1) as u64, row.original_position.clone()),
                observation(row),
            )
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
            .env("RECOUNT_DEAD_LETTER_TOPIC", self.dead_letter())
            .env("RECOUNT_NORMALIZER_GROUP", &self.group)
            .env("RECOUNT_RAW_PARTITIONS", "3")
            .env("RECOUNT_NORMALIZED_PARTITIONS", "3")
            .env("RECOUNT_RAW_BROKER_MAX_BYTES", "6291456")
            .env("RECOUNT_NORMALIZED_BROKER_MAX_BYTES", "2097152")
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        command
    }
    fn dead_letter(&self) -> String {
        format!("{}.dead-letter", self.raw)
    }
    fn start(&self) -> Process {
        Process(self.command().stderr(Stdio::inherit()).spawn().unwrap())
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

fn observation(row: AnalyticalPoint) -> AnalyticalPoint {
    AnalyticalPoint {
        stream_id: row.stream_id,
        time_unix_nano: row.time_unix_nano,
        start_time_unix_nano: row.start_time_unix_nano,
        flags: row.flags,
        int_value: row.int_value,
        double_value: row.double_value,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        explicit_bounds: row.explicit_bounds,
        bucket_counts: row.bucket_counts,
        scale: row.scale,
        zero_count: row.zero_count,
        zero_threshold: row.zero_threshold,
        positive_offset: row.positive_offset,
        positive_counts: row.positive_counts,
        negative_offset: row.negative_offset,
        negative_counts: row.negative_counts,
        quantiles: row.quantiles,
        quantile_values: row.quantile_values,
        exemplars: row.exemplars,
        ..Default::default()
    }
}

async fn collect(
    consumer: &BaseConsumer,
    expected: usize,
    phase: &str,
) -> BTreeMap<(u32, u64, Vec<u8>), AnalyticalPoint> {
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
            rows.insert(
                (
                    point.raw_partition,
                    point.raw_offset,
                    point.original_position.clone(),
                ),
                observation(point),
            );
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
/// topics. Creates and deletes only its matching dead-letter topic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh isolated topics/group"]
async fn real_kafka_first_start_replay_rebalance_and_dead_letter() {
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
        let coordinates = (0, delivery.offset as u64, point.original_position.clone());
        assert!(!original.contains_key(&coordinates));
        (coordinates, observation(point))
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
    assert!(
        collect(&reader, expected, "process replay")
            .await
            .values()
            .eq(original.values())
    );
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
    assert!(
        collect(&reader, expected, "stable rebalance before poison")
            .await
            .values()
            .eq(original.values())
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
    // A missing dead-letter destination must not settle the original offset.
    tokio::time::sleep(Duration::from_secs(2)).await;
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
    let dead = env.dead_letter();
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", &env.broker)
        .create()
        .unwrap();
    let created = admin
        .create_topics(
            &[NewTopic::new(&dead, 1, TopicReplication::Fixed(1))],
            &AdminOptions::new(),
        )
        .await
        .unwrap();
    assert!(created.iter().all(Result::is_ok), "{created:?}");
    let good = producer
        .send(
            FutureRecord::to(&env.raw)
                .partition(0)
                .key(&key)
                .payload(&body),
            Timeout::After(Duration::from_secs(1)),
        )
        .await
        .unwrap();
    committed(&observer, &env.raw, 0, good.offset + 1).await;
    assert!(process.0.try_wait().unwrap().is_none());
    assert!(second.0.try_wait().unwrap().is_none());
    let dead_reader = consumer(&env.broker, &format!("{}.dead-reader", env.group));
    let mut assignment = TopicPartitionList::new();
    assignment
        .add_partition_offset(&dead, 0, Offset::Beginning)
        .unwrap();
    dead_reader.assign(&assignment).unwrap();
    let record = dead_reader.poll(Duration::from_secs(10)).unwrap().unwrap();
    let key = format!("{}/0/{}", env.raw, bad.offset);
    assert_eq!(record.key(), Some(key.as_bytes()));
    let message: serde_json::Value = serde_json::from_slice(record.payload().unwrap()).unwrap();
    assert_eq!(message["reason"], "routing_key_mismatch");
    assert_eq!(message["project_id"], "");
    drop(second);
    drop(process);
    assert!(
        admin
            .delete_topics(&[&dead], &AdminOptions::new())
            .await
            .unwrap()[0]
            .is_ok()
    );
}
