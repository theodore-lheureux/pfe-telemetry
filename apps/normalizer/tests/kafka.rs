use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, CommitMode, Consumer},
    message::Message as _,
    producer::{FutureProducer, FutureRecord},
    util::Timeout,
};
use recount_telemetry_schema::{identity, wire::AnalyticalPoint};
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
        let ready = [&env.raw, &env.normalized].iter().all(|topic| {
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
    let bootstrap = env.command().arg("bootstrap").output().unwrap();
    assert!(
        bootstrap.status.success(),
        "fresh progress bootstrap failed: {}",
        String::from_utf8_lossy(&bootstrap.stderr)
    );
    let reader = consumer(&env.broker, &format!("{}.observer", env.group));
    let mut assignment = TopicPartitionList::new();
    for p in 0..3 {
        assignment
            .add_partition_offset(&env.normalized, p, Offset::Offset(0))
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
    const PER_PARTITION: i64 = 4;
    // Pre-fill all raw partitions, so buffered/prefetched inputs persist while
    // the same production process must repeatedly release its two active slots.
    for index in 0..PER_PARTITION * 3 {
        let mut raw = cases::raw();
        raw.batch.as_mut().unwrap().client_id = format!("progress-{index}");
        let body = raw.encode_to_vec();
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
    assert!(
        collect(&reader, expected.len(), "continuous backlog").await == expected,
        "normalized sample identities/projections differ"
    );
    eprintln!(
        "progress_complete inputs={} logical_samples={}",
        PER_PARTITION * 3,
        expected.len()
    );
    drop(process);
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing explicit integration setting: {name}"))
}

struct Environment {
    binary: PathBuf,
    broker: String,
    raw: String,
    normalized: String,
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
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
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
        if offsets.find_partition(topic, partition).unwrap().offset() == Offset::Offset(next) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "raw completion checkpoint not confirmed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Requires a coordinator-allocated, disposable Kafka slot and precreated empty
/// topics. Does not create/delete topics, groups, tables, or broker containers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit reused Kafka endpoint and fresh isolated topics/group"]
async fn real_kafka_bootstrap_replay_rebalance_and_global_handler_poison() {
    assert_eq!(setting("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH"), "1");
    let env = Environment {
        binary: env!("CARGO_BIN_EXE_recount-normalizer").into(),
        broker: setting("RECOUNT_NORMALIZER_TEST_BROKER"),
        raw: setting("RECOUNT_NORMALIZER_TEST_RAW_TOPIC"),
        normalized: setting("RECOUNT_NORMALIZER_TEST_NORMALIZED_TOPIC"),
        group: setting("RECOUNT_NORMALIZER_TEST_GROUP"),
    };
    let namespace = setting("RECOUNT_NORMALIZER_TEST_NAMESPACE");
    assert!(namespace.starts_with("recount."));
    for name in [&env.raw, &env.normalized, &env.group] {
        assert!(name.starts_with(&format!("{namespace}.normalizer.")));
    }
    let observer = consumer(&env.broker, &env.group);
    let mut assignment = TopicPartitionList::new();
    for partition in 0..3 {
        for topic in [&env.raw, &env.normalized] {
            assert_eq!(
                observer
                    .fetch_watermarks(topic, partition, Duration::from_secs(3))
                    .unwrap(),
                (0, 0),
                "requires empty isolated topics"
            );
        }
        assignment
            .add_partition_offset(&env.normalized, partition, Offset::Offset(0))
            .unwrap();
    }
    let reader = consumer(&env.broker, &format!("{}.observer", env.group));
    reader.assign(&assignment).unwrap();
    // Missing checkpoints and a wrong partition count must not become ready.
    let output = env.command().output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checkpoint missing"));
    assert!(
        !env.command()
            .env("RECOUNT_NORMALIZED_PARTITIONS", "2")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        env.command()
            .arg("bootstrap")
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        !env.command()
            .arg("bootstrap")
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

    // Immutable input replay after a process crash produces identical row IDs,
    // event partitions and values despite a different raw Kafka offset.
    let mut process = env.start();
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
                .fetch_watermarks(&env.normalized, p, Duration::from_secs(3))
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
                .fetch_watermarks(&env.normalized, p, Duration::from_secs(3))
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

    // An unavailable saved checkpoint must fail visibly, not reset. This is a
    // separate synthetic group; no topic retention or existing group is changed.
    let gap_group = format!("{}.gap", env.group);
    let gap = consumer(&env.broker, &gap_group);
    let mut saved = TopicPartitionList::new();
    for partition in 0..3 {
        let next = if partition == 0 { 1000 } else { 0 };
        saved
            .add_partition_offset(&env.raw, partition, Offset::Offset(next))
            .unwrap();
    }
    gap.assign(&saved).unwrap();
    gap.commit(&saved, CommitMode::Sync).unwrap();
    let output = env
        .command()
        .env("RECOUNT_NORMALIZER_GROUP", &gap_group)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("retention_gap"));
}
