use super::{RunState, app, cases, unix_nanos};
use crate::{config::Cli, prepare_rows};
use clap::Parser;
use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, Consumer},
    message::{Headers, Message as KafkaMessage},
    producer::{FutureProducer, FutureRecord},
};
use recount_telemetry_schema::{
    ExportMetricsServiceRequest, RAW_RECEIVED_MS_HEADER, ddl::Schema, identity,
    metrics::metric::Data, series, wire::AnalyticalPoint,
};
use ruststream_rdkafka::prelude::*;
use std::{
    process::Command,
    time::{Duration, Instant},
};

fn local(args: &[&str]) -> String {
    let result = Command::new("docker").args(args).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

fn sql(query: &str) -> String {
    local(&[
        "exec",
        &setting("RECOUNT_PACKING_TEST_CLICKHOUSE_CONTAINER"),
        "clickhouse-client",
        "--max_execution_time=5",
        "--query",
        query,
    ])
}

fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing explicit test setting: {name}"))
}

struct Database(String);
impl Drop for Database {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args([
                "exec",
                &setting("RECOUNT_PACKING_TEST_CLICKHOUSE_CONTAINER"),
                "clickhouse-client",
                "--query",
                &format!("DROP DATABASE IF EXISTS {} SYNC", self.0),
            ])
            .status();
    }
}

fn batch(time: u64, submission: usize) -> Vec<u8> {
    let mut raw = cases::ordinary_cpu_process();
    raw.received_unix_nano = time + 1_000_000;
    let identity = raw.batch.as_mut().unwrap();
    identity.created_unix_nano = time;
    identity.client_id = format!("packing-{submission}");
    let mut request = ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice()).unwrap();
    for metric in request
        .resource_metrics
        .iter_mut()
        .flat_map(|r| &mut r.scope_metrics)
        .flat_map(|s| &mut s.metrics)
    {
        match metric.data.as_mut().unwrap() {
            Data::Sum(sum) => {
                sum.data_points[0].time_unix_nano = time;
                sum.data_points[0].start_time_unix_nano = time - 1_000_000_000;
            }
            Data::Gauge(gauge) => {
                gauge.data_points[0].time_unix_nano = time;
            }
            _ => unreachable!(),
        }
    }
    raw.otlp_request = request.encode_to_vec();
    raw.encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized disposable topics on the initialized OrbStack services"]
async fn real_normalizer_packed_recent_points_reach_clickhouse() {
    assert_eq!(
        std::env::var("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH").as_deref(),
        Ok("1")
    );
    assert!(std::env::var_os("DOCKER_HOST").is_none());
    let endpoint = local(&[
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
        local(&["context", "show"]).trim(),
    ]);
    assert!(
        endpoint.trim().starts_with("unix://"),
        "local Docker required"
    );
    let broker = setting("RECOUNT_NORMALIZER_TEST_BROKER");
    assert!(broker.starts_with("127.0.0.1:"), "loopback Kafka required");
    let time = unix_nanos();
    let input: Vec<_> = (0..4)
        .map(|i| batch(time + i * 1_000_000, i as usize))
        .collect();
    let unpacked = scenario(&broker, &input, false).await;
    let packed = scenario(&broker, &input, true).await;
    assert_eq!(unpacked, packed, "logical ClickHouse rows changed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized disposable topics on the initialized OrbStack services"]
async fn real_normalizer_linger_preserves_points_and_checkpoints() {
    assert_eq!(
        std::env::var("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH").as_deref(),
        Ok("1")
    );
    assert!(std::env::var_os("DOCKER_HOST").is_none());
    assert_eq!(local(&["context", "show"]).trim(), "orbstack");
    let broker = setting("RECOUNT_NORMALIZER_TEST_BROKER");
    assert_eq!(broker, "127.0.0.1:19092");
    let now = unix_nanos();
    let input: Vec<_> = (0..4)
        .map(|i| batch(now + i * 1_000_000, i as usize))
        .collect();
    for burst in [false, true] {
        let baseline = scenario_with_linger(&broker, &input, true, Some("5"), burst, false).await;
        let trial = scenario_with_linger(&broker, &input, true, Some("30"), burst, false).await;
        assert_eq!(baseline, trial, "logical ClickHouse rows changed");
    }
}

async fn scenario(broker: &str, input: &[Vec<u8>], packed: bool) -> String {
    scenario_with_linger(broker, input, packed, None, false, false).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable Kafka topics and ClickHouse"]
async fn cached_series_survive_two_replicas_and_reassignment() {
    assert_eq!(
        std::env::var("RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH").as_deref(),
        Ok("1")
    );
    let broker = setting("RECOUNT_NORMALIZER_TEST_BROKER");
    assert!(broker.starts_with("127.0.0.1:"));
    let now = unix_nanos();
    let input: Vec<_> = (0..8)
        .map(|i| batch(now + i * 1_000_000, i as usize))
        .collect();
    scenario_with_linger(&broker, &input, true, None, false, true).await;
}

async fn scenario_with_linger(
    broker: &str,
    input: &[Vec<u8>],
    packed: bool,
    linger_ms: Option<&'static str>,
    burst: bool,
    replicas: bool,
) -> String {
    let database = Database(format!("recount_pack_{}", unix_nanos()));
    let db = &database.0;
    let raw = format!("recount.local.{db}.raw");
    let recent = format!("recount.local.{db}.packed");
    let late = format!("recount.local.{db}.late");
    let group = format!("recount.local.{db}.normalizer");
    let storage_group = format!("recount.local.{db}.storage");
    let topics = [&raw, &recent, &late];
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()
        .unwrap();
    let config = Cli::try_parse_from([
        "recount-normalizer",
        "--kafka-bootstrap",
        broker,
        "--raw-topic",
        &raw,
        "--normalized-topic",
        &recent,
        "--late-topic",
        &late,
        "--group",
        &group,
        "--raw-partitions",
        if replicas { "3" } else { "1" },
        "--normalized-partitions",
        "1",
        "--linger-ms",
        linger_ms.unwrap_or("30"),
        "--max-active",
        "16",
    ])
    .unwrap()
    .into_config()
    .unwrap();
    let admin_options = AdminOptions::new().request_timeout(Some(Duration::from_secs(5)));
    assert!(
        admin
            .create_topics(
                &[
                    NewTopic::new(
                        &raw,
                        if replicas { 3 } else { 1 },
                        TopicReplication::Fixed(1)
                    )
                    .set(
                        "max.message.bytes",
                        &config.raw_broker_max_bytes.to_string()
                    ),
                    NewTopic::new(&recent, 1, TopicReplication::Fixed(1)).set(
                        "max.message.bytes",
                        &config.normalized_broker_max_bytes.to_string()
                    ),
                    NewTopic::new(&late, 1, TopicReplication::Fixed(1)).set(
                        "max.message.bytes",
                        &config.normalized_broker_max_bytes.to_string()
                    ),
                ],
                &admin_options
            )
            .await
            .unwrap()
            .iter()
            .all(Result::is_ok)
    );
    let ddl = Schema {
        database: db,
        bootstrap: &setting("RECOUNT_PACKING_TEST_NATIVE_BOOTSTRAP"),
        topic: &recent,
        group: &storage_group,
        late_topic: &late,
        late_group: &format!("{storage_group}.late"),
        partition_limit: 128,
        poll_ms: 100,
        flush_ms: 2000,
        if_not_exists: false,
    }
    .render()
    .unwrap();
    let ddl = if packed {
        ddl
    } else {
        ddl.replacen(
            "kafka_format = 'Protobuf'",
            "kafka_format = 'ProtobufSingle'",
            1,
        )
    };
    for statement in ddl.split(';').map(str::trim).filter(|q| !q.is_empty()) {
        sql(statement);
    }
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let second_config = config.clone();
    let mut first = Some((
        stop,
        tokio::spawn(async move {
            app(RunState::new(config, packed))
                .run_until(async {
                    let _ = stopped.await;
                })
                .await
        }),
    ));
    let second = replicas.then(|| {
        let (stop, stopped) = tokio::sync::oneshot::channel();
        (
            stop,
            tokio::spawn(async move {
                app(RunState::new(second_config, packed))
                    .run_until(async {
                        let _ = stopped.await;
                    })
                    .await
            }),
        )
    });
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()
        .unwrap();
    let observer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .set("group.id", &group)
        .set("enable.auto.commit", "false")
        .create()
        .unwrap();
    let timeout = Duration::from_secs(3);
    let mut expected = Vec::new();
    let mut expected_ids = Vec::new();
    let start = Instant::now();
    let members = |expected| {
        observer
            .fetch_group_list(Some(&group), timeout)
            .is_ok_and(|list| {
                list.groups()
                    .iter()
                    .any(|g| g.state() == "Stable" && g.members().len() == expected)
            })
    };
    if replicas {
        while !members(2) {
            assert!(start.elapsed() < Duration::from_secs(30));
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }
    let received_ms = (unix_nanos() / 1_000_000) as i64 - 60_000;
    let mut delays = Vec::new();
    for (index, bytes) in input.iter().enumerate() {
        if replicas && index == input.len() / 2 {
            let (stop, run) = first.take().unwrap();
            stop.send(()).unwrap();
            run.await.unwrap().unwrap();
            while !members(1) {
                assert!(start.elapsed() < Duration::from_secs(60));
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        let key = identity::raw_routing_key(
            &recount_telemetry_schema::wire::RawRecord::decode(bytes.as_slice()).unwrap(),
        )
        .unwrap();
        let points = prepare_rows(bytes, Some(&key), Default::default()).unwrap();
        for mut point in points {
            let dimensions = series::split(&mut point);
            expected_ids.push(format!(
                "{}\t{}\t{}\t{}\t{}",
                point.time_unix_milli,
                dimensions.series_id,
                identity::hex(&point.stream_id),
                dimensions.logical_series_id,
                index / if replicas { 3 } else { 1 },
            ));
            expected.push(point.time_unix_milli);
        }
        let sent = Instant::now();
        producer
            .send(
                FutureRecord::to(&raw)
                    .partition(if replicas { (index % 3) as i32 } else { 0 })
                    .key(&key)
                    .payload(bytes)
                    .timestamp(received_ms + index as i64),
                timeout,
            )
            .await
            .unwrap();
        if burst && index + 1 < input.len() {
            continue;
        }
        loop {
            let count: usize = sql(&format!(
                "SELECT uniqExact(series_id,stream_id,time_unix_milli) FROM {db}.metric_points"
            ))
            .trim()
            .parse()
            .unwrap();
            if count == expected.len() {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(45),
                "packed submission was not queryable"
            );
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        delays.push(sent.elapsed());
    }
    let mut assignment = TopicPartitionList::new();
    for p in 0..if replicas { 3 } else { 1 } {
        assignment.add_partition(&raw, p);
    }
    loop {
        let offsets = observer
            .committed_offsets(assignment.clone(), timeout)
            .unwrap();
        if offsets.elements().iter().all(|p| {
            let count = if replicas {
                (input.len() + 2 - p.partition() as usize) / 3
            } else {
                input.len()
            };
            p.offset() == Offset::Offset(count as i64)
        }) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(45),
            "raw checkpoint did not advance"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        observer.fetch_watermarks(&recent, 0, timeout).unwrap(),
        (
            0,
            if packed {
                input.len() as i64
            } else {
                expected.len() as i64
            }
        )
    );
    let mut assignment = TopicPartitionList::new();
    assignment
        .add_partition_offset(&recent, 0, Offset::Beginning)
        .unwrap();
    observer.assign(&assignment).unwrap();
    let records = if packed { input.len() } else { expected.len() };
    let mut stamps = Vec::new();
    let mut series_frames = std::collections::BTreeMap::<u64, usize>::new();
    for _ in 0..records {
        let message = observer.poll(timeout).expect("normalized record").unwrap();
        if replicas {
            let mut payload = message.payload().unwrap();
            while !payload.is_empty() {
                let point = AnalyticalPoint::decode_length_delimited(&mut payload).unwrap();
                if point.last_seen_unix_milli != 0 {
                    *series_frames.entry(point.series_id).or_default() += 1;
                }
            }
        }
        let stamp = message
            .headers()
            .unwrap()
            .iter()
            .find(|header| header.key == RAW_RECEIVED_MS_HEADER)
            .unwrap();
        stamps.push(
            std::str::from_utf8(stamp.value.unwrap())
                .unwrap()
                .parse::<i64>()
                .unwrap(),
        );
        assert!(message.timestamp().to_millis().unwrap() >= received_ms + 60_000);
    }
    assert!(
        stamps
            .iter()
            .all(|stamp| (received_ms..received_ms + input.len() as i64).contains(stamp))
    );
    stamps.sort_unstable();
    stamps.dedup();
    assert_eq!(
        stamps,
        (received_ms..received_ms + input.len() as i64).collect::<Vec<_>>()
    );
    assert_eq!(
        observer.fetch_watermarks(&late, 0, timeout).unwrap(),
        (0, 0)
    );
    if replicas {
        assert!(
            series_frames
                .values()
                .all(|count| *count >= 2 && *count < input.len())
        );
    }
    let actual = sql(&format!(
            "SELECT p.time_unix_milli, p.series_id, lower(hex(p.stream_id)), s.logical_series_id, p.raw_offset
            FROM (SELECT * FROM {db}.metric_points FINAL) AS p
            INNER JOIN (SELECT * FROM {db}.metric_series FINAL) AS s USING (project_id, series_id)
            INNER JOIN (SELECT * FROM {db}.deliveries FINAL) AS d
                ON p.project_id=d.project_id AND s.source_id=d.source_id
                AND p.raw_partition=d.raw_partition AND p.raw_offset=d.raw_offset"
        ));
    let mut actual: Vec<_> = actual.lines().collect();
    actual.sort_unstable();
    expected_ids.sort_unstable();
    assert_eq!(
        actual,
        expected_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(
        sql(&format!("SELECT count() FROM {db}.deliveries")).trim(),
        input.len().to_string(),
        "one delivery row per raw request",
    );
    let logical_rows = sql(&format!(
        "SELECT hex(formatRow('RowBinary', *)) FROM {db}.metric_points FINAL ORDER BY series_id,stream_id,time_unix_milli"
    ));
    eprintln!(
        "packed={packed} linger={linger_ms:?} burst={burst}: {} verified points; observed visibility delays {delays:?}",
        actual.len()
    );
    for (stop, run) in first.into_iter().chain(second) {
        stop.send(()).unwrap();
        run.await.unwrap().unwrap();
    }
    drop(database);
    assert!(
        admin
            .delete_topics(&topics.map(String::as_str), &admin_options)
            .await
            .unwrap()
            .iter()
            .all(Result::is_ok)
    );
    logical_rows
}
