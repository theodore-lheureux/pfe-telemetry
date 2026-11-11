use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use prost::Message;
use rdkafka::{
    ClientConfig, Message as KafkaMessage, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    client::DefaultClientContext,
    consumer::{Consumer, StreamConsumer},
};
use recount_ingestion_api::{
    broker::{KafkaSink, Sink},
    live::shard,
};
use recount_telemetry_schema::{
    metrics::{Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric},
    wire::{LiveNotification, RawRecord, SecurityScope},
};
use std::time::Duration;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires an explicitly allocated reused Kafka endpoint"]
async fn notifications_reference_confirmed_raw_records_and_live_failure_cannot_reject_raw() {
    let bootstrap =
        std::env::var("RECOUNT_LIVE_TEST_KAFKA_BOOTSTRAP").expect("explicit Kafka endpoint");
    let prefix = format!("recount.test.activity.{}", Uuid::now_v7());
    let raw_topic = format!("{prefix}.raw");
    let live_topic = format!("{prefix}.live");
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap)
        .create()
        .unwrap();
    let options = AdminOptions::new().request_timeout(Some(Duration::from_secs(5)));
    let results = admin
        .create_topics(
            [
                &NewTopic::new(&raw_topic, 1, TopicReplication::Fixed(1))
                    .set("max.message.bytes", "6291456"),
                &NewTopic::new(&live_topic, 8, TopicReplication::Fixed(1))
                    .set("max.message.bytes", "65536"),
            ],
            &options,
        )
        .await
        .unwrap();
    assert!(results.iter().all(Result::is_ok));
    let project_id = "019a4790-d1da-7000-8000-000000000002";
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap)
        .set("group.id", format!("{prefix}.observer"))
        .set("enable.auto.commit", "false")
        .set("auto.offset.reset", "error")
        .create()
        .unwrap();
    let mut assignment = TopicPartitionList::new();
    assignment
        .add_partition_offset(&live_topic, shard(project_id, 8), Offset::Beginning)
        .unwrap();
    consumer.assign(&assignment).unwrap();
    let body = ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            scope_metrics: vec![ScopeMetrics {
                metrics: vec![Metric {
                    data: Some(metric::Data::Gauge(Gauge {
                        data_points: (0..1000)
                            .map(|_| NumberDataPoint {
                                time_unix_nano: 1794300000000000000,
                                ..Default::default()
                            })
                            .collect(),
                    })),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };
    let raw = RawRecord {
        security: Some(SecurityScope {
            project_id: project_id.into(),
            source_id: "source".into(),
        }),
        record_id: Uuid::now_v7().to_string(),
        received_unix_nano: 1794300000000000000,
        otlp_request: body.encode_to_vec(),
        ..Default::default()
    };
    let sink = KafkaSink::new(
        &bootstrap,
        &raw_topic,
        1,
        4194304,
        6291456,
        live_topic.clone(),
        8,
    )
    .unwrap();
    sink.publish(&raw, &body).await.unwrap();
    let message = tokio::time::timeout(Duration::from_secs(15), consumer.recv())
        .await
        .unwrap()
        .unwrap();
    let notification = LiveNotification::decode(message.payload().unwrap()).unwrap();
    assert_eq!(notification.project_id, project_id);
    assert_eq!(notification.record_id, raw.record_id);
    assert_eq!(notification.raw_partition, 0);
    assert_eq!(notification.raw_offset, 0);
    assert_eq!(notification.points, 1000);
    assert!(message.payload().unwrap().len() < raw.encoded_len() / 10);
    drop(message);
    let mut raw_assignment = TopicPartitionList::new();
    raw_assignment
        .add_partition_offset(&raw_topic, 0, Offset::Beginning)
        .unwrap();
    consumer.assign(&raw_assignment).unwrap();
    let message = tokio::time::timeout(Duration::from_secs(10), consumer.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(message.payload().unwrap(), raw.encode_to_vec());
    drop(message);
    admin
        .delete_topics(&[&live_topic], &options)
        .await
        .unwrap()
        .into_iter()
        .for_each(|v| {
            v.unwrap();
        });
    sink.publish(&raw, &body)
        .await
        .expect("notification outage must not reject confirmed raw packet");
    let message = tokio::time::timeout(Duration::from_secs(10), consumer.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(message.offset(), 1);
    assert_eq!(message.payload().unwrap(), raw.encode_to_vec());
    drop(message);
    admin
        .delete_topics(&[&raw_topic], &options)
        .await
        .unwrap()
        .into_iter()
        .for_each(|v| {
            v.unwrap();
        });
}
