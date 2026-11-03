mod common;
use clickhouse::{Client, Row};
use common::*;
use opentelemetry_proto::tonic::metrics::v1::{Histogram, HistogramDataPoint, Metric, metric};
use pfe_server::analytics::{Batch, LogPosition, Store};
use prost::Message;
use serde::Deserialize;
use uuid::Uuid;

fn position(offset: i64) -> LogPosition<'static> {
    LogPosition {
        topic: "storage-test",
        partition: 0,
        offset,
    }
}
fn store() -> Store {
    Store::new(
        &std::env::var("TELEMETRY_CLICKHOUSE_URL").unwrap(),
        "telemetry_writer",
        &std::env::var("TELEMETRY_CLICKHOUSE_PASSWORD").unwrap(),
    )
}
fn reader() -> Client {
    Client::default()
        .with_url(std::env::var("TELEMETRY_CLICKHOUSE_URL").unwrap())
        .with_user("telemetry_reader")
        .with_password(std::env::var("TELEMETRY_CLICKHOUSE_READER_PASSWORD").unwrap())
        .with_database("telemetry")
}
fn writer() -> Client {
    Client::default()
        .with_url(std::env::var("TELEMETRY_CLICKHOUSE_URL").unwrap())
        .with_user("telemetry_writer")
        .with_password(std::env::var("TELEMETRY_CLICKHOUSE_PASSWORD").unwrap())
        .with_database("telemetry")
}

#[derive(Row, Deserialize)]
struct Values {
    time: u64,
    integer: Option<i64>,
    double: Option<f64>,
    payload: String,
}

#[tokio::test]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn publication_replay_conflicts_and_native_values() {
    let mut envelope = envelope();
    envelope.source_id = Uuid::now_v7().to_string();
    let batch = Batch::from_envelope(&envelope, position(0)).unwrap();
    let storage = store();
    assert!(storage.ready().await);
    assert!(storage.publish_batch(&batch).await.unwrap());
    assert!(!storage.publish_batch(&batch).await.unwrap());
    drop(storage);
    let storage = store();
    let mut replay = envelope.clone();
    replay.record_id = Uuid::now_v7().to_string();
    replay.received_unix_nano += 100;
    assert!(
        !storage
            .publish_batch(&Batch::from_envelope(&replay, position(1)).unwrap())
            .await
            .unwrap()
    );
    let mut conflict = envelope.clone();
    conflict.client_created_unix_nano += 1;
    assert!(
        storage
            .publish_batch(&Batch::from_envelope(&conflict, position(2)).unwrap())
            .await
            .is_err()
    );
    assert!(
        storage
            .publish_batch(
                &Batch::from_envelope(
                    &envelope,
                    LogPosition {
                        topic: "changed-topic",
                        partition: 0,
                        offset: 0
                    }
                )
                .unwrap()
            )
            .await
            .is_err()
    );
    // Simulate an unconfirmed INSERT followed by a retry which also inserted.
    let client = writer();
    for _ in 0..2 {
        let mut insert = client.insert::<Batch>("batches").await.unwrap();
        insert.write(&batch).await.unwrap();
        insert.end().await.unwrap();
    }
    let result = reader().query("SELECT tupleElement(first, 1) AS time, tupleElement(first, 2) AS integer, tupleElement(first, 3) AS double, tupleElement(first, 4) AS payload FROM (SELECT argMin(tuple(points.time_ns[1], points.integer_value[1], points.double_value[1], payload_hex), tuple(log_offset, record_id)) AS first FROM batches WHERE project_id = ? AND source_id = ? GROUP BY storage_key)")
        .bind(&envelope.project_id).bind(&envelope.source_id).fetch_all::<Values>().await.unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].time, u64::MAX - 1);
    assert_eq!(result[0].integer, Some(9_007_199_254_740_993));
    assert_eq!(result[0].double, None);
    let expected = envelope
        .payload
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    assert_eq!(result[0].payload, expected);
    assert_eq!(
        reader()
            .query("SELECT count() FROM batches WHERE project_id = ? AND source_id = ?")
            .bind(&envelope.project_id)
            .bind(&envelope.source_id)
            .fetch_one::<u64>()
            .await
            .unwrap(),
        3
    );
}

#[tokio::test]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn histograms_and_explicit_missing_values_preserve_supported_payload() {
    let mut body = request();
    let Some(metric::Data::Gauge(gauge)) =
        &mut body.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!()
    };
    gauge.data_points[0].value = None;
    gauge.data_points[0].flags = 1;
    let histogram = HistogramDataPoint {
        time_unix_nano: 42,
        count: u64::MAX,
        bucket_counts: vec![u64::MAX],
        ..Default::default()
    };
    body.resource_metrics[0].scope_metrics[0]
        .metrics
        .push(Metric {
            name: "request.duration".into(),
            unit: "ms".into(),
            data: Some(metric::Data::Histogram(Histogram {
                aggregation_temporality: 1,
                data_points: vec![histogram],
            })),
            ..Default::default()
        });
    let mut envelope = envelope();
    envelope.source_id = Uuid::now_v7().to_string();
    envelope.payload = body.encode_to_vec();
    store()
        .publish_batch(&Batch::from_envelope(&envelope, position(0)).unwrap())
        .await
        .unwrap();
    assert_eq!(reader().query("SELECT count() FROM batches WHERE source_id = ? AND isNull(points.integer_value[1]) AND isNull(points.double_value[1]) AND points.flags[1] = 1 AND points.kind[2] = 'histogram' AND isNull(points.integer_value[2]) AND isNull(points.double_value[2]) AND payload_hex = ?").bind(&envelope.source_id).bind(envelope.payload.iter().map(|b| format!("{b:02x}")).collect::<String>()).fetch_one::<u64>().await.unwrap(), 1);
}

#[tokio::test]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn runtime_credentials_cannot_provision_or_mutate_telemetry() {
    for client in [reader(), writer()] {
        assert!(
            client
                .query("CREATE TABLE telemetry.forbidden (id UInt64) ENGINE = Memory")
                .execute()
                .await
                .is_err()
        );
        assert!(
            client
                .query("TRUNCATE TABLE telemetry.batches")
                .execute()
                .await
                .is_err()
        );
        assert!(
            client
                .query("DROP TABLE telemetry.batches")
                .execute()
                .await
                .is_err()
        );
    }
    assert!(
        reader()
            .query("INSERT INTO batches (project_id) VALUES ('forbidden')")
            .execute()
            .await
            .is_err()
    );
    assert!(
        reader()
            .query("ALTER TABLE batches DELETE WHERE project_id = 'forbidden'")
            .execute()
            .await
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn temporary_unavailability_retries_the_same_batch_until_recovery() {
    use pfe_server::broker::BatchStore;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;
    let destination =
        std::env::var("PFE_TEST_CLICKHOUSE_TCP").unwrap_or_else(|_| "clickhouse:8123".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let available = Arc::new(AtomicBool::new(false));
    let flag = available.clone();
    let proxy = tokio::spawn(async move {
        while let Ok((mut incoming, _)) = listener.accept().await {
            if !flag.load(Ordering::SeqCst) {
                continue;
            }
            let destination = destination.clone();
            tokio::spawn(async move {
                if let Ok(mut upstream) = tokio::net::TcpStream::connect(destination).await {
                    let _ = tokio::io::copy_bidirectional(&mut incoming, &mut upstream).await;
                }
            });
        }
    });
    let storage = Arc::new(Store::new(
        &format!("http://{address}"),
        "telemetry_writer",
        &std::env::var("TELEMETRY_CLICKHOUSE_PASSWORD").unwrap(),
    ));
    assert!(!storage.ready().await);
    let mut envelope = envelope();
    envelope.source_id = Uuid::now_v7().to_string();
    let pending = tokio::spawn({
        let storage = storage.clone();
        async move { storage.publish(&envelope, position(0)).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!pending.is_finished());
    available.store(true, Ordering::SeqCst);
    assert!(
        tokio::time::timeout(Duration::from_secs(15), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    );
    assert!(storage.ready().await);
    proxy.abort();
}

#[test]
fn unsupported_and_empty_envelopes_never_publish() {
    let mut value = envelope();
    value.format_version = 2;
    assert!(Batch::from_envelope(&value, position(0)).is_err());
    value.format_version = 1;
    value.payload = Default::default();
    assert!(Batch::from_envelope(&value, position(0)).is_err());
}

#[tokio::test]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn interrupted_insert_is_absent_or_complete_and_replay_becomes_visible() {
    let mut envelope = envelope();
    envelope.source_id = Uuid::now_v7().to_string();
    let mut body = request();
    let Some(metric::Data::Gauge(gauge)) =
        &mut body.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!()
    };
    gauge.data_points = vec![gauge.data_points[0].clone(); 10000];
    envelope.payload = body.encode_to_vec();
    let batch = Batch::from_envelope(&envelope, position(0)).unwrap();
    let client = writer();
    let mut unconfirmed = client.insert::<Batch>("batches").await.unwrap();
    unconfirmed.write(&batch).await.unwrap();
    drop(unconfirmed);
    let incomplete = reader().query("SELECT count() FROM batches WHERE source_id = ? AND (length(points.series_id) != 10000 OR length(points.time_ns) != 10000 OR length(points.integer_value) != 10000)").bind(&envelope.source_id).fetch_one::<u64>().await.unwrap();
    assert_eq!(incomplete, 0);
    store().publish_batch(&batch).await.unwrap();
    assert_eq!(reader().query("SELECT uniqExact(storage_key) FROM batches WHERE source_id = ? AND length(points.series_id) = 10000 AND points.integer_value[1] = 9007199254740993").bind(&envelope.source_id).fetch_one::<u64>().await.unwrap(), 1);
}

#[tokio::test]
#[ignore = "Requires provisioned disposable ClickHouse"]
async fn reordered_attribute_sets_keep_one_series_without_changing_the_payload_digest() {
    use opentelemetry_proto::tonic::common::v1::{
        AnyValue, InstrumentationScope, KeyValue, KeyValueList, any_value::Value,
    };
    let nested = |reverse: bool| {
        let mut values = vec![attr("a", "1"), attr("b", "2")];
        if reverse {
            values.reverse();
        }
        KeyValue {
            key: "nested".into(),
            value: Some(AnyValue {
                value: Some(Value::KvlistValue(KeyValueList { values })),
            }),
            ..Default::default()
        }
    };
    let mut first = envelope();
    first.source_id = Uuid::now_v7().to_string();
    let mut body = request();
    body.resource_metrics[0].scope_metrics[0].scope = Some(InstrumentationScope {
        name: "scope".into(),
        version: "1".into(),
        attributes: vec![nested(false), attr("second", "value")],
        ..Default::default()
    });
    let Some(metric::Data::Gauge(gauge)) =
        &mut body.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!()
    };
    gauge.data_points[0].attributes = vec![attr("cpu.mode", "user"), attr("dimension", "value")];
    first.payload = body.encode_to_vec();
    body.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .reverse();
    let scope = body.resource_metrics[0].scope_metrics[0]
        .scope
        .as_mut()
        .unwrap();
    scope.attributes = vec![attr("second", "value"), nested(true)];
    scope.dropped_attributes_count = 1;
    let Some(metric::Data::Gauge(gauge)) =
        &mut body.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!()
    };
    gauge.data_points[0].attributes.reverse();
    let mut second = first.clone();
    second.client_batch_id = Uuid::now_v7().to_string();
    second.payload = body.encode_to_vec();
    assert_ne!(first.content_digest(), second.content_digest());
    for (offset, envelope) in [&first, &second].into_iter().enumerate() {
        store()
            .publish_batch(&Batch::from_envelope(envelope, position(offset as i64)).unwrap())
            .await
            .unwrap();
    }
    assert_eq!(reader().query("SELECT uniqExact(points.series_id[1]) FROM batches WHERE project_id = ? AND source_id = ?").bind(&first.project_id).bind(&first.source_id).fetch_one::<u64>().await.unwrap(), 1);
}
