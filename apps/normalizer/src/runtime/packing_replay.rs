use super::{app, unix_nanos};
use crate::{config::Cli, prepare};
use clap::Parser;
use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, Consumer},
    producer::{FutureProducer, FutureRecord},
};
use recount_telemetry_schema::{
    ExportMetricsServiceRequest, identity, metrics::metric::Data, wire::AnalyticalPoint,
};
use ruststream_rdkafka::prelude::*;
use std::{
    process::Command,
    time::{Duration, Instant},
};

#[allow(dead_code)]
#[path = "../../../../tests/fixtures/telemetry/cases.rs"]
mod cases;

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

async fn scenario(broker: &str, input: &[Vec<u8>], packed: bool) -> String {
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
        "1",
        "--normalized-partitions",
        "1",
    ])
    .unwrap()
    .into_config()
    .unwrap();
    let admin_options = AdminOptions::new().request_timeout(Some(Duration::from_secs(5)));
    assert!(
        admin
            .create_topics(
                &[
                    NewTopic::new(&raw, 1, TopicReplication::Fixed(1)).set(
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
    sql(&format!("CREATE DATABASE {db}"));
    for table in ["metric_points", "normalized_kafka", "ingest_metric_points"] {
        let mut ddl = sql(&format!(
            "SHOW CREATE TABLE telemetry.{table} FORMAT TSVRaw"
        ))
        .replace("telemetry.", &format!("{db}."));
        if table == "normalized_kafka" {
            for (setting, value) in [
                ("kafka_topic_list", format!("'{recent}'")),
                ("kafka_group_name", format!("'{storage_group}'")),
                (
                    "kafka_format",
                    if packed {
                        "'Protobuf'"
                    } else {
                        "'ProtobufSingle'"
                    }
                    .into(),
                ),
                ("kafka_max_block_size", "16384".into()),
                (
                    "kafka_poll_max_batch_size",
                    if packed { "16" } else { "1024" }.into(),
                ),
            ] {
                let prefix = format!("{setting} = ");
                let start = ddl.find(&prefix).unwrap() + prefix.len();
                let end = ddl[start..].find(',').map_or(ddl.len(), |n| start + n);
                ddl.replace_range(start..end, &value);
            }
            assert!(
                ddl.contains(&format!("'{recent}'")) && ddl.contains(&format!("'{storage_group}'"))
            );
        }
        sql(&ddl);
    }
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let run = tokio::spawn(async move {
        app(config, packed)
            .run_until(async {
                let _ = stopped.await;
            })
            .await
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
    let start = Instant::now();
    let mut delays = Vec::new();
    for bytes in input {
        let key = identity::raw_routing_key(
            &recount_telemetry_schema::wire::RawRecord::decode(bytes.as_slice()).unwrap(),
        )
        .unwrap();
        let points = prepare(bytes, Some(&key), 1, Default::default()).unwrap();
        expected.extend(points.into_iter().map(|r| {
            AnalyticalPoint::decode(r.payload.as_slice())
                .unwrap()
                .sample_id
        }));
        let sent = Instant::now();
        producer
            .send(
                FutureRecord::to(&raw).partition(0).key(&key).payload(bytes),
                timeout,
            )
            .await
            .unwrap();
        loop {
            let count: usize = sql(&format!(
                "SELECT uniqExact(sample_id) FROM {db}.metric_points"
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
    assignment.add_partition(&raw, 0);
    loop {
        if observer
            .committed_offsets(assignment.clone(), timeout)
            .unwrap()
            .find_partition(&raw, 0)
            .unwrap()
            .offset()
            == Offset::Offset(4)
        {
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
        (0, if packed { 4 } else { expected.len() as i64 })
    );
    assert_eq!(
        observer.fetch_watermarks(&late, 0, timeout).unwrap(),
        (0, 0)
    );
    let mut stored: Vec<_> = sql(&format!(
        "SELECT lower(hex(sample_id)) FROM {db}.metric_points ORDER BY sample_id"
    ))
    .lines()
    .map(str::to_owned)
    .collect();
    let mut encoded: Vec<_> = expected
        .iter()
        .map(|id| id.iter().map(|b| format!("{b:02x}")).collect::<String>())
        .collect();
    stored.sort();
    encoded.sort();
    assert_eq!(stored, encoded);
    let logical_rows = sql(&format!(
        "SELECT hex(formatRow('RowBinary', *)) FROM {db}.metric_points FINAL ORDER BY sample_id"
    ));
    eprintln!(
        "packed={packed}: {} verified points; observed visibility delays {delays:?}",
        stored.len()
    );
    stop.send(()).unwrap();
    run.await.unwrap().unwrap();
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
