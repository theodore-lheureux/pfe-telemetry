use prost::Message as _;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, CommitMode, Consumer},
    message::Message as _,
    producer::{FutureProducer, FutureRecord},
    util::Timeout,
};
use recount_telemetry_schema::{ANALYTICAL_COLUMNS, projection, wire::AnalyticalPoint};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing explicit integration setting: {name}"))
}

fn fixture(arguments: &[&str]) -> Vec<u8> {
    let result = Command::new(setting("RECOUNT_CONTRACT_FIXTURE"))
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

fn escaped(value: &str) -> String {
    value.bytes().map(|byte| format!("%{byte:02X}")).collect()
}

struct Storage {
    database: String,
    topic: String,
    group: String,
    broker: String,
    observer: BaseConsumer,
    producer: FutureProducer,
}

impl Storage {
    async fn new(seed: bool, retention: bool) -> Self {
        assert_eq!(setting("RECOUNT_STORAGE_TEST_ALLOW_CREATE"), "1");
        let namespace = setting("RECOUNT_STORAGE_TEST_NAMESPACE");
        assert!(namespace.starts_with("recount."));
        assert!(
            namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        );
        let unique = format!(
            "{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let database = format!("recount_tooling_{unique}");
        let topic = format!("{namespace}.storage.{unique}");
        let group = format!("{topic}.consumer");
        let broker = setting("RECOUNT_STORAGE_TEST_BROKER");
        let admin: AdminClient<_> = ClientConfig::new()
            .set("bootstrap.servers", &broker)
            .create()
            .unwrap();
        let topic_config = NewTopic::new(&topic, 1, TopicReplication::Fixed(1))
            .set("max.message.bytes", "2097152")
            .set("retention.bytes", "134217728")
            .set("retention.ms", if retention { "1000" } else { "21600000" })
            .set("segment.ms", if retention { "1000" } else { "3600000" });
        let results = admin
            .create_topics(
                &[topic_config],
                &AdminOptions::new().request_timeout(Some(Duration::from_secs(5))),
            )
            .await
            .unwrap();
        assert!(
            results.iter().all(Result::is_ok),
            "requires fresh owned topic: {results:?}"
        );
        let observer = Self::consumer(&broker, &group);
        let producer = ClientConfig::new()
            .set("bootstrap.servers", &broker)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("message.timeout.ms", "10000")
            .create()
            .unwrap();
        let storage = Self {
            database,
            topic,
            group,
            broker,
            observer,
            producer,
        };
        eprintln!(
            "storage_allocation database={} topic={} group={}",
            storage.database, storage.topic, storage.group
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if storage
                .observer
                .fetch_watermarks(&storage.topic, 0, Duration::from_secs(1))
                .is_ok_and(|v| v == (0, 0))
            {
                break;
            }
            assert!(Instant::now() < deadline, "fresh topic not ready");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            storage.checkpoint(),
            Offset::Invalid,
            "fresh group must not already have a checkpoint"
        );
        if seed {
            let mut offsets = TopicPartitionList::new();
            offsets
                .add_partition_offset(&storage.topic, 0, Offset::Offset(0))
                .unwrap();
            storage.observer.assign(&offsets).unwrap();
            storage.observer.commit(&offsets, CommitMode::Sync).unwrap();
        }
        storage.sql(&format!("CREATE DATABASE {}", storage.database));
        storage
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

    fn sql(&self, query: &str) -> Vec<u8> {
        self.request(query, &[])
    }

    fn request(&self, query: &str, data: &[u8]) -> Vec<u8> {
        let url = setting("RECOUNT_CLICKHOUSE_TEST_URL");
        assert!(url.starts_with("http://") || url.starts_with("https://"));
        let mut child = Command::new("curl")
            .args([
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "10",
                "--user",
            ])
            .arg(format!(
                "{}:{}",
                setting("RECOUNT_CLICKHOUSE_TEST_USER"),
                setting("RECOUNT_CLICKHOUSE_TEST_PASSWORD")
            ))
            .arg(format!(
                "{}/?wait_end_of_query=1&query={}",
                url.trim_end_matches('/'),
                escaped(query)
            ))
            .args(["--data-binary", "@-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(data).unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "ClickHouse query failed: {} {}",
            String::from_utf8_lossy(&result.stderr),
            String::from_utf8_lossy(&result.stdout)
        );
        result.stdout
    }

    fn start(&self) {
        let internal = setting("RECOUNT_STORAGE_TEST_INTERNAL_BROKER");
        assert!(
            internal
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".:-,".contains(&b))
        );
        let ddl = include_str!("../../../infra/clickhouse/schema.sql.in")
            .replace("IF NOT EXISTS ", "")
            .replace("CREATE DATABASE telemetry;", "")
            .replace("__ANALYTICAL_COLUMNS__", ANALYTICAL_COLUMNS)
            .replace("__KAFKA_BOOTSTRAP__", &internal)
            .replace("__NORMALIZED_TOPIC__", &self.topic)
            .replace("recount-clickhouse", &self.group)
            .replace("__POLL_MS__", "100")
            .replace("__FLUSH_MS__", "1000")
            .replace("telemetry.", &format!("{}.", self.database));
        for statement in ddl.split(';').filter(|s| !s.trim().is_empty()) {
            self.sql(statement);
        }
        self.sql(&format!(
            "SYSTEM STOP MERGES {}.metric_points",
            self.database
        ));
    }

    async fn publish(&self, body: &[u8]) -> i64 {
        let mut first = None;
        for row in decode(body) {
            let offset = self.publish_wire(&projection::serialize(&row)).await;
            first.get_or_insert(offset);
        }
        first.expect("nonempty file fixture")
    }

    async fn publish_wire(&self, body: &[u8]) -> i64 {
        self.producer
            .send(
                FutureRecord::<(), _>::to(&self.topic)
                    .partition(0)
                    .payload(body),
                Timeout::After(Duration::from_secs(1)),
            )
            .await
            .map_err(|(error, _)| error)
            .unwrap()
            .offset
    }

    fn checkpoint(&self) -> Offset {
        let mut offsets = TopicPartitionList::new();
        offsets.add_partition(&self.topic, 0);
        self.observer
            .committed_offsets(offsets, Duration::from_secs(3))
            .unwrap()
            .find_partition(&self.topic, 0)
            .unwrap()
            .offset()
    }

    fn count(&self, logical: bool) -> usize {
        let bytes = self.sql(&format!(
            "SELECT count() FROM {}.metric_points {}",
            self.database,
            if logical { "FINAL" } else { "" }
        ));
        String::from_utf8(bytes).unwrap().trim().parse().unwrap()
    }

    async fn wait(&self, message: &str, seconds: u64, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while !condition() {
            assert!(Instant::now() < deadline, "{message}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn errors(&self) -> String {
        String::from_utf8(self.sql(&format!("SELECT arrayStringConcat(`exceptions.text`, '\\n') FROM system.kafka_consumers WHERE database='{}' AND table='normalized_kafka' FORMAT TSVRaw", self.database))).unwrap()
    }

    async fn assert_blocked(&self, expected: Offset) {
        self.wait("consumer failure not visible", 30, || {
            !self.errors().trim().is_empty()
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(self.checkpoint(), expected, "failed input was acknowledged");
        assert_eq!(self.count(false), 0, "failed input inserted a suffix");
    }

    async fn close(self) {
        self.sql(&format!("DROP DATABASE {} SYNC", self.database));
        let admin: AdminClient<_> = ClientConfig::new()
            .set("bootstrap.servers", &self.broker)
            .create()
            .unwrap();
        let result = admin
            .delete_topics(
                &[&self.topic],
                &AdminOptions::new().request_timeout(Some(Duration::from_secs(5))),
            )
            .await
            .unwrap();
        assert!(
            result.iter().all(Result::is_ok),
            "owned topic cleanup failed: {result:?}"
        );
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        // On assertion failure, stop only this test's consumers; leave Kafka evidence.
        if !std::thread::panicking() {
            return;
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.sql(&format!("DROP DATABASE IF EXISTS {} SYNC", self.database))
        }));
    }
}

fn decode(mut bytes: &[u8]) -> Vec<AnalyticalPoint> {
    let mut rows = Vec::new();
    while !bytes.is_empty() {
        rows.push(AnalyticalPoint::decode_length_delimited(&mut bytes).unwrap());
    }
    rows
}

#[tokio::test]
#[ignore = "requires explicit reused Kafka/ClickHouse endpoints and fresh logical fixture permission"]
async fn native_single_point_roundtrip_replay_sparse_flush_and_destination_recovery() {
    let storage = Storage::new(true, false).await;
    assert_eq!(
        fixture(&["--columns"]),
        ANALYTICAL_COLUMNS.as_bytes(),
        "stale fixture executable"
    );
    storage.start();
    let body = fixture(&[]);
    assert_eq!(storage.publish(&body).await, 0);
    let reader = Storage::consumer(&storage.broker, &format!("{}.observer", storage.group));
    let mut offsets = TopicPartitionList::new();
    offsets
        .add_partition_offset(&storage.topic, 0, Offset::Offset(0))
        .unwrap();
    reader.assign(&offsets).unwrap();
    let message = reader.poll(Duration::from_secs(10)).unwrap().unwrap();
    assert_eq!(
        message.payload().unwrap(),
        projection::serialize(&decode(&body)[0]),
        "bare point record changed bytes"
    );
    assert_eq!(
        storage
            .observer
            .fetch_watermarks(&storage.topic, 0, Duration::from_secs(3))
            .unwrap(),
        (0, 15)
    );
    storage
        .wait("point fixture not fully visible", 30, || {
            storage.count(true) == 15
        })
        .await;
    storage
        .wait("initial checkpoint not confirmed", 30, || {
            storage.checkpoint() == Offset::Offset(15)
        })
        .await;
    storage.publish(&body).await;
    storage
        .wait("physical replay not observed", 30, || {
            storage.count(false) >= 30
        })
        .await;
    assert_eq!(storage.count(true), 15);
    let contract = include_str!("../../../tests/telemetry-pipeline/contract.sql");
    let contract = contract
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    for statement in contract
        .split(';')
        .map(str::trim)
        .filter(|s| s.starts_with("SELECT throwIf"))
    {
        storage.sql(&statement.replace(
            "FROM points",
            &format!("FROM {}.metric_points", storage.database),
        ));
    }
    let result = storage.sql(&format!("SELECT * FROM {}.metric_points FINAL ORDER BY sample_id FORMAT Protobuf SETTINGS format_schema='recount.proto:AnalyticalPoint',format_protobuf_use_autogenerated_schema=0", storage.database));
    let path: PathBuf = std::env::temp_dir().join(format!("{}.pb", storage.database));
    std::fs::write(&path, result).unwrap();
    let verified = Command::new(setting("RECOUNT_CONTRACT_FIXTURE"))
        .args(["--verify", path.to_str().unwrap()])
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        verified.status.success(),
        "{}",
        String::from_utf8_lossy(&verified.stderr)
    );
    storage
        .wait("replay checkpoint not confirmed", 30, || {
            storage.checkpoint() == Offset::Offset(30)
        })
        .await;
    let first = decode(&body)[0].encode_length_delimited_to_vec();
    let before = storage.count(false);
    let started = Instant::now();
    storage.publish(&first).await;
    storage
        .wait("sparse row did not flush within 5s", 5, || {
            storage.count(false) > before
        })
        .await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(storage.count(true), 15);
    storage
        .wait("sparse checkpoint not confirmed", 30, || {
            storage.checkpoint() == Offset::Offset(31)
        })
        .await;
    storage.sql(&format!(
        "DETACH TABLE {}.metric_points SYNC",
        storage.database
    ));
    storage.publish(&fixture(&["--ordinary-new"])).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        storage.checkpoint(),
        Offset::Offset(31),
        "unavailable destination acknowledged input"
    );
    storage.sql(&format!("ATTACH TABLE {}.metric_points", storage.database));
    storage
        .wait("new unique samples not recovered", 30, || {
            storage.count(true) == 19
        })
        .await;
    storage
        .wait("recovered checkpoint not confirmed", 30, || {
            storage.checkpoint() == Offset::Offset(35)
        })
        .await;
    storage.close().await;
}

#[tokio::test]
#[ignore = "requires explicit reused Kafka/ClickHouse endpoints and fresh logical fixture permission"]
async fn poison_is_visible_without_rows_or_checkpoint_advance() {
    let storage = Storage::new(true, false).await;
    storage.start();
    storage.publish_wire(&[255; 12]).await;
    storage.assert_blocked(Offset::Offset(0)).await;
    storage.close().await;
}

#[tokio::test]
#[ignore = "requires explicit reused Kafka/ClickHouse endpoints and fresh logical fixture permission"]
async fn missing_checkpoint_does_not_choose_an_implicit_start() {
    let storage = Storage::new(false, false).await;
    storage.publish(&fixture(&[])).await;
    storage.start();
    storage.assert_blocked(Offset::Invalid).await;
    storage.close().await;
}

#[tokio::test]
#[ignore = "requires explicit reused Kafka/ClickHouse endpoints and fresh short-retention topic permission"]
async fn naturally_expired_checkpoint_does_not_consume_a_readable_suffix() {
    let storage = Storage::new(true, true).await;
    let body = fixture(&[]);
    storage.publish(&body).await;
    tokio::time::sleep(Duration::from_millis(1250)).await;
    storage.publish(&body).await;
    storage
        .wait("owned topic's first segment did not expire", 100, || {
            storage
                .observer
                .fetch_watermarks(&storage.topic, 0, Duration::from_secs(2))
                .unwrap()
                .0
                > 0
        })
        .await;
    storage.publish(&body).await;
    storage.start();
    storage.assert_blocked(Offset::Offset(0)).await;
    storage.close().await;
}

#[tokio::test]
#[ignore = "requires explicit reused Kafka/ClickHouse endpoints and finite prepared partition guard"]
async fn complete_records_have_finite_fanout_and_oversized_records_do_not_commit() {
    let bound: usize = setting("RECOUNT_STORAGE_TEST_OUTPUT_ROWS").parse().unwrap();
    assert!((1..=16384).contains(&bound));
    // Storage-only synthetic projections deliberately vary event days, not admission identity.
    let seed = decode(&fixture(&[]))
        .into_iter()
        .find(|p| p.resource_id == "sensor-a")
        .unwrap();
    {
        let storage = Storage::new(true, false).await;
        let guard =
            String::from_utf8(storage.sql(
                "SELECT value FROM system.settings WHERE name='max_partitions_per_insert_block'",
            ))
            .unwrap();
        assert_eq!(guard.trim(), bound.to_string());
        assert_eq!(String::from_utf8(storage.sql("SELECT value FROM system.settings WHERE name='throw_on_max_partitions_per_insert_block'")).unwrap().trim(), "1");
        storage.start();
        let count = bound + 1;
        for index in 0..count {
            let mut row = seed.clone();
            row.time_unix_nano += index as u64 * 86_400_000_000_000;
            row.event_day = (row.time_unix_nano / 86_400_000_000_000) as u32;
            row.sample_id = vec![index as u8; 32];
            storage.publish_wire(&projection::serialize(&row)).await;
        }
        storage
            .wait(
                "complete records coalesced beyond finite partition guard",
                30,
                || storage.count(false) == count,
            )
            .await;
        storage
            .wait("bounded records not acknowledged", 30, || {
                storage.checkpoint() == Offset::Offset(count as i64)
            })
            .await;
        let mut oversized = seed.clone();
        oversized.description = "x".repeat(2_097_153);
        let body = projection::serialize(&oversized);
        let error = storage
            .producer
            .send(
                FutureRecord::<(), _>::to(&storage.topic)
                    .partition(0)
                    .payload(&body),
                Timeout::After(Duration::from_secs(1)),
            )
            .await;
        assert!(error.is_err(), "oversized point was accepted");
        assert_eq!(
            storage
                .observer
                .fetch_watermarks(&storage.topic, 0, Duration::from_secs(3))
                .unwrap()
                .1,
            count as i64
        );
        assert_eq!(storage.checkpoint(), Offset::Offset(count as i64));
        assert_eq!(storage.count(false), count);
        storage.close().await;
    }
}

#[tokio::test]
#[ignore = "coordinator-only: requires exclusive immutable ClickHouse container restart authority"]
async fn unclean_restart_preserves_rows_and_owned_checkpoint_replay_preserves_identity() {
    assert_eq!(setting("RECOUNT_STORAGE_TEST_ALLOW_RESTART"), "1");
    let id = setting("RECOUNT_STORAGE_TEST_CONTAINER_ID");
    let project = setting("RECOUNT_STORAGE_TEST_COMPOSE_PROJECT");
    assert_eq!(id.len(), 64);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(project.starts_with("recount-"));
    let identity = Command::new("docker").args([
        "inspect", "--type", "container", "--format",
        "{{.Id}}|{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}|{{.State.Running}}",
        &id,
    ]).output().unwrap();
    assert!(identity.status.success());
    assert_eq!(
        String::from_utf8(identity.stdout).unwrap().trim(),
        format!("{id}|{project}|clickhouse|true")
    );
    struct Restart(String, bool);
    impl Drop for Restart {
        fn drop(&mut self) {
            if self.1 {
                let _ = Command::new("docker").args(["start", &self.0]).status();
            }
        }
    }
    let storage = Storage::new(true, false).await;
    storage.start();
    storage.publish(&fixture(&[])).await;
    storage
        .wait("initial rows missing", 30, || storage.count(true) == 15)
        .await;
    storage
        .wait("initial checkpoint missing", 30, || {
            storage.checkpoint() == Offset::Offset(15)
        })
        .await;
    let before = storage.sql(&format!("SELECT * FROM {}.metric_points FINAL ORDER BY sample_id FORMAT Protobuf SETTINGS format_schema='recount.proto:AnalyticalPoint',format_protobuf_use_autogenerated_schema=0", storage.database));
    let mut restart = Restart(id, true);
    assert!(
        Command::new("docker")
            .args(["kill", "--signal", "KILL", &restart.0])
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("docker")
            .args(["start", &restart.0])
            .status()
            .unwrap()
            .success()
    );
    restart.1 = false;
    storage
        .wait("ClickHouse did not recover HTTP readiness", 60, || {
            Command::new("curl")
                .args([
                    "--silent",
                    "--fail",
                    "--max-time",
                    "1",
                    &format!(
                        "{}/ping",
                        setting("RECOUNT_CLICKHOUSE_TEST_URL").trim_end_matches('/')
                    ),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .await;
    assert_eq!(
        storage.count(true),
        15,
        "unclean restart lost acknowledged rows"
    );
    assert_eq!(storage.checkpoint(), Offset::Offset(15));
    storage.sql(&format!(
        "SYSTEM STOP MERGES {}.metric_points",
        storage.database
    ));
    storage.sql(&format!(
        "DETACH TABLE {}.ingest_metric_points SYNC",
        storage.database
    ));
    storage.sql(&format!(
        "DETACH TABLE {}.normalized_kafka SYNC",
        storage.database
    ));
    storage
        .wait(
            "owned group did not become inactive; no rewind attempted",
            90,
            || {
                storage
                    .observer
                    .fetch_group_list(Some(&storage.group), Duration::from_secs(2))
                    .unwrap()
                    .groups()
                    .iter()
                    .any(|g| g.state() == "Empty")
            },
        )
        .await;
    let mut offsets = TopicPartitionList::new();
    offsets
        .add_partition_offset(&storage.topic, 0, Offset::Offset(0))
        .unwrap();
    storage.observer.commit(&offsets, CommitMode::Sync).unwrap();
    assert_eq!(storage.checkpoint(), Offset::Offset(0));
    let physical = storage.count(false);
    storage.sql(&format!(
        "ATTACH TABLE {}.normalized_kafka",
        storage.database
    ));
    storage.sql(&format!(
        "ATTACH TABLE {}.ingest_metric_points",
        storage.database
    ));
    storage
        .wait(
            "owned checkpoint replay did not store physical rows",
            30,
            || storage.count(false) >= physical + 15,
        )
        .await;
    storage
        .wait("replayed checkpoint missing", 30, || {
            storage.checkpoint() == Offset::Offset(15)
        })
        .await;
    let after = storage.sql(&format!("SELECT * FROM {}.metric_points FINAL ORDER BY sample_id FORMAT Protobuf SETTINGS format_schema='recount.proto:AnalyticalPoint',format_protobuf_use_autogenerated_schema=0", storage.database));
    assert_eq!(
        after, before,
        "offset replay changed logical sample identities/values"
    );
    storage.close().await;
}

#[tokio::test]
#[ignore = "coordinator-only: initialized image startup fault requires exclusive container/data/schema authority"]
async fn invalid_initialized_image_start_cannot_change_files_or_acknowledge_pending_input() {
    assert_eq!(setting("RECOUNT_STORAGE_TEST_ALLOW_RESTART"), "1");
    assert_eq!(setting("RECOUNT_STORAGE_TEST_SYNTHETIC_ALLOCATION"), "1");
    let id = setting("RECOUNT_STORAGE_TEST_CONTAINER_ID");
    let project = setting("RECOUNT_STORAGE_TEST_COMPOSE_PROJECT");
    assert_eq!(id.len(), 64);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    let inspect = |format: &str| {
        let result = Command::new("docker")
            .args(["inspect", "--type", "container", "--format", format, &id])
            .output()
            .unwrap();
        assert!(result.status.success());
        String::from_utf8(result.stdout).unwrap().trim().to_owned()
    };
    assert_eq!(
        inspect(
            "{{.Id}}|{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}|{{.State.Running}}"
        ),
        format!("{id}|{project}|clickhouse|true")
    );
    let image = inspect("{{.Image}}");
    assert!(image.starts_with("sha256:"));
    let network = setting("RECOUNT_STORAGE_TEST_NETWORK");
    assert!(
        network
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    );
    assert!(
        !inspect(&format!(
            "{{{{(index .NetworkSettings.Networks \"{network}\").NetworkID}}}}"
        ))
        .is_empty()
    );
    let entrypoint = inspect("{{range .Config.Entrypoint}}{{println .}}{{end}}")
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let command = inspect("{{range .Config.Cmd}}{{println .}}{{end}}")
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let environment = inspect("{{range .Config.Env}}{{println .}}{{end}}")
        .lines()
        .map(|line| {
            let (key, value) = line
                .split_once('=')
                .expect("single-line synthetic container environment required");
            assert!(key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
            (key.to_owned(), value.to_owned())
        })
        .collect::<Vec<_>>();
    assert!(
        !entrypoint.is_empty(),
        "configured startup entrypoint required"
    );
    let mount = inspect(
        "{{range .Mounts}}{{if eq .Destination \"/var/lib/clickhouse\"}}{{.Type}}|{{if eq .Type \"volume\"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}",
    );
    let (kind, source) = mount.split_once('|').unwrap();
    assert!(matches!(kind, "volume" | "bind"));
    assert!(!source.contains([',', '\n']));
    let storage = Storage::new(true, false).await;
    storage.start();
    let body = fixture(&[]);
    storage.publish(&body).await;
    storage
        .wait("initial samples missing", 30, || storage.count(true) == 15)
        .await;
    storage
        .wait("initial checkpoint missing", 30, || {
            storage.checkpoint() == Offset::Offset(15)
        })
        .await;
    let sentinel_query = format!(
        "SELECT * FROM {}.untouched ORDER BY sample_id FORMAT Protobuf SETTINGS format_schema='recount.proto:AnalyticalPoint',format_protobuf_use_autogenerated_schema=0",
        storage.database
    );
    storage.sql(&format!(
        "CREATE TABLE {}.untouched AS {}.metric_points",
        storage.database, storage.database
    ));
    storage.sql(&format!(
        "INSERT INTO {}.untouched SELECT * FROM {}.metric_points FINAL",
        storage.database, storage.database
    ));
    let sentinel = storage.sql(&sentinel_query);
    let path = String::from_utf8(storage.sql(&format!("SELECT data_paths[1] FROM system.tables WHERE database='{}' AND name='metric_points' FORMAT TSVRaw", storage.database))).unwrap().trim().to_owned();
    assert!(path.starts_with("/var/lib/clickhouse/store/") && !path.contains(['\n', '\0']));
    let directory = std::env::temp_dir().join(format!("{}-invalid-schema", storage.database));
    assert!(!directory.exists());
    assert!(
        Command::new("cp")
            .args([
                "-R",
                &setting("RECOUNT_SCHEMA_DIRECTORY"),
                directory.to_str().unwrap()
            ])
            .status()
            .unwrap()
            .success()
    );
    std::fs::OpenOptions::new()
        .append(true)
        .open(directory.join("schemas/recount.proto"))
        .unwrap()
        .write_all(b"\n// synthetic altered schema\n")
        .unwrap();
    struct Restore(String, PathBuf, PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = Command::new("docker").args(["start", &self.0]).status();
            let _ = std::fs::remove_dir_all(&self.1);
            let _ = std::fs::remove_file(&self.2);
        }
    }
    let verifier =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../infra/clickhouse/verify-schema.sh");
    let trace_verifier = directory.with_extension("verify.sh");
    std::fs::write(
        &trace_verifier,
        format!("set -x\n{}", std::fs::read_to_string(verifier).unwrap()),
    )
    .unwrap();
    let verifier_path = setting("RECOUNT_STORAGE_TEST_VERIFIER_PATH");
    assert!(verifier_path.starts_with('/') && !verifier_path.contains([',', '\n']));
    let restore = Restore(id.clone(), directory.clone(), trace_verifier.clone());
    assert!(
        Command::new("docker")
            .args(["stop", "--time", "60", &id])
            .status()
            .unwrap()
            .success()
    );
    let files = || {
        let result = Command::new("docker")
            .args([
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--memory",
                "64m",
                "--pids-limit",
                "32",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--user",
                "101:101",
                "--mount",
                &format!("type={kind},src={source},dst=/var/lib/clickhouse,readonly"),
                "--entrypoint",
                "find",
                &image,
                &path,
                "-type",
                "f",
                "-exec",
                "sha256sum",
                "{}",
                "+",
            ])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let mut lines = String::from_utf8(result.stdout)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        lines.sort();
        assert!(!lines.is_empty(), "initialized target has no stored files");
        lines
    };
    let before = files();
    storage.publish(&fixture(&["--ordinary-new"])).await;
    let failed_name = format!("{}-invalid-start", storage.database);
    struct FailedContainer(String);
    impl Drop for FailedContainer {
        fn drop(&mut self) {
            let _ = Command::new("docker")
                .args(["rm", "--force", &self.0])
                .output();
        }
    }
    let failed_container = FailedContainer(failed_name.clone());
    // Reproduce configured argv; inserting a verifier call here would hide a lost startup guard.
    let mut launch = Command::new("docker");
    launch.args([
        "run",
        "--detach",
        "--name",
        &failed_name,
        "--network",
        &network,
        "--read-only",
        "--memory",
        "1536m",
        "--memory-swap",
        "1536m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--volumes-from",
        &id,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m",
        "--mount",
        &format!(
            "type=bind,src={},dst=/etc/recount-schema,readonly",
            directory.display()
        ),
        "--mount",
        &format!(
            "type=bind,src={}/schemas,dst=/etc/clickhouse-server/format_schemas,readonly",
            directory.display()
        ),
        "--mount",
        &format!(
            "type=bind,src={},dst={verifier_path},readonly",
            trace_verifier.display()
        ),
        "--entrypoint",
        &entrypoint[0],
    ]);
    for (key, value) in &environment {
        launch.args(["--env", key]).env(key, value);
    }
    let failed = launch
        .arg(&image)
        .args(&entrypoint[1..])
        .args(&command)
        .output()
        .unwrap();
    assert!(
        failed.status.success(),
        "could not launch owned startup fault container"
    );
    storage
        .wait(
            "invalid schema did not stop before server startup",
            15,
            || {
                let state = Command::new("docker")
                    .args([
                        "inspect",
                        "--format",
                        "{{.State.Running}}|{{.State.ExitCode}}",
                        &failed_name,
                    ])
                    .output()
                    .unwrap();
                assert!(state.status.success());
                let state = String::from_utf8(state.stdout).unwrap();
                if state.trim().starts_with("false|") {
                    assert_ne!(
                        state.trim(),
                        "false|0",
                        "invalid initialized image started successfully"
                    );
                    true
                } else {
                    let processes = Command::new("docker")
                        .args(["top", &failed_name, "-eo", "comm"])
                        .output()
                        .unwrap();
                    if processes.status.success() {
                        let processes = String::from_utf8_lossy(&processes.stdout);
                        assert!(
                            !processes
                                .lines()
                                .any(|line| line.trim().starts_with("clickhouse")),
                            "ClickHouse process started before checksum rejection: {processes}"
                        );
                    }
                    false
                }
            },
        )
        .await;
    let logs = Command::new("docker")
        .args(["logs", &failed_name])
        .output()
        .unwrap();
    let diagnostic = format!(
        "{}{}",
        String::from_utf8_lossy(&logs.stderr),
        String::from_utf8_lossy(&logs.stdout)
    );
    assert!(
        diagnostic.contains("sha256sum --check --status"),
        "failure was not the pre-server checksum guard: {diagnostic}"
    );
    for marker in [
        "Processing configuration file",
        "Starting ClickHouse",
        "Ready for connections",
        "Listening for http",
    ] {
        assert!(
            !diagnostic.contains(marker),
            "server started before checksum rejection: {diagnostic}"
        );
    }
    assert_eq!(
        files(),
        before,
        "invalid startup modified stored target files"
    );
    assert_eq!(
        storage.checkpoint(),
        Offset::Offset(15),
        "invalid startup acknowledged pending input"
    );
    drop(failed_container);
    drop(restore);
    storage
        .wait("valid image did not regain HTTP readiness", 60, || {
            Command::new("curl")
                .args([
                    "--silent",
                    "--fail",
                    "--max-time",
                    "1",
                    &format!(
                        "{}/ping",
                        setting("RECOUNT_CLICKHOUSE_TEST_URL").trim_end_matches('/')
                    ),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .await;
    storage
        .wait("pending new unique samples were lost", 30, || {
            storage.count(true) == 19
        })
        .await;
    storage
        .wait("recovered input not acknowledged", 30, || {
            storage.checkpoint() == Offset::Offset(19)
        })
        .await;
    assert_eq!(
        storage.sql(&sentinel_query),
        sentinel,
        "unrelated fixture changed during failed initialized startup"
    );
    storage.close().await;
}
