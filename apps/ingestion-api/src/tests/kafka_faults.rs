use super::*;
use broker::{KafkaSink, Topic};
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    client::DefaultClientContext,
    consumer::{BaseConsumer, Consumer},
    message::Message as _,
};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[path = "../../../../tests/fixtures/kafka/disposable.rs"]
mod disposable;

const RAW: &str = "recount.metrics.raw";

/// Every retained raw record, read through the observer listener.
fn retained(broker: &str) -> Vec<RawRecord> {
    let consumer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", broker)
        // Assignment requires a group name; this reader never joins or commits.
        .set("group.id", "recount.fault.observer")
        .set("enable.auto.commit", "false")
        .create()
        .unwrap();
    let mut assignment = TopicPartitionList::new();
    let mut remaining = 0;
    for p in 0..3 {
        assignment
            .add_partition_offset(RAW, p, Offset::Offset(0))
            .unwrap();
        remaining += consumer
            .fetch_watermarks(RAW, p, Duration::from_secs(5))
            .unwrap()
            .1;
    }
    consumer.assign(&assignment).unwrap();
    let mut records = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while records.len() < remaining as usize {
        assert!(Instant::now() < deadline, "retained raw records unread");
        if let Some(message) = consumer.poll(Duration::from_millis(100)) {
            records.push(RawRecord::decode(message.unwrap().payload().unwrap()).unwrap());
        }
    }
    records
}

/// Retries one immutable batch as the collector does until acceptance is confirmed.
async fn retry(
    client: &mut MetricsServiceClient<tonic::transport::Channel>,
    export: &impl Fn() -> Request<ExportMetricsServiceRequest>,
) -> usize {
    let deadline = Instant::now() + Duration::from_secs(60);
    for attempt in 1.. {
        match client.export(export()).await {
            Ok(_) => return attempt,
            Err(status) => assert_eq!(status.code(), Code::Unavailable),
        }
        assert!(Instant::now() < deadline, "batch was never accepted");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    unreachable!()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an owned disposable Kafka container and Toxiproxy"]
async fn lost_produce_acknowledgements_and_broker_restart_keep_retried_batches_exact() {
    let broker = disposable::Broker::start();
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", &broker.direct)
        .create()
        .unwrap();
    let results = admin
        .create_topics(
            &[
                NewTopic::new(RAW, 3, TopicReplication::Fixed(1))
                    .set("max.message.bytes", "6291456"),
                NewTopic::new("recount.metrics.live", 1, TopicReplication::Fixed(1))
                    .set("max.message.bytes", "65536"),
                NewTopic::new("recount.participants", 1, TopicReplication::Fixed(1))
                    .set("max.message.bytes", "6291456"),
            ],
            &AdminOptions::new(),
        )
        .await
        .unwrap();
    assert!(
        results.iter().all(std::result::Result::is_ok),
        "{results:?}"
    );
    let sink = Arc::new(
        KafkaSink::new(
            &broker.proxied,
            Topic {
                name: RAW,
                partitions: 3,
            },
            4194304,
            6291456,
            Topic {
                name: "recount.metrics.live",
                partitions: 1,
            },
            Topic {
                name: "recount.participants",
                partitions: 1,
            },
        )
        .unwrap(),
    );
    let router = configured_router(
        Arc::new(TestAuthority::default()),
        sink,
        Limits::default(),
        1,
    )
    .await
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(
                tokio_stream::wrappers::TcpListenerStream::new(listener),
                async {
                    let _ = stopped.await;
                },
            )
            .await
            .unwrap();
    });
    let mut client = MetricsServiceClient::connect(endpoint).await.unwrap();
    let created = unix_nanos().unwrap();
    let batch = |id: &'static str| {
        move || {
            let mut request = request(body_at(created + 1));
            request
                .metadata_mut()
                .insert(metadata::BATCH_ID, id.parse().unwrap());
            request.metadata_mut().insert(
                metadata::BATCH_CREATED,
                created.to_string().parse().unwrap(),
            );
            request
        }
    };

    client.export(batch("confirmed")()).await.unwrap();
    assert_eq!(retained(&broker.direct).len(), 1);

    // Kafka appends the record but the confirmation never reaches the API.
    broker.drop_responses();
    let lost = batch("acknowledgement-lost");
    assert_eq!(
        client.export(lost()).await.unwrap_err().code(),
        Code::Unavailable
    );
    assert_eq!(
        retained(&broker.direct).len(),
        2,
        "unconfirmed record was not written"
    );
    broker.restore_responses();
    let lost_attempts = retry(&mut client, &lost).await;

    // An unclean broker stop rejects acceptance until the restarted broker confirms it.
    broker.kill();
    let restarted = batch("broker-restart");
    assert_eq!(
        client.export(restarted()).await.unwrap_err().code(),
        Code::Unavailable
    );
    broker.restart();
    let restart_attempts = retry(&mut client, &restarted).await;

    let records = retained(&broker.direct);
    let mut acceptances = BTreeMap::<String, usize>::new();
    let mut samples = BTreeMap::new();
    for raw in &records {
        *acceptances
            .entry(raw.batch.as_ref().unwrap().client_id.clone())
            .or_default() += 1;
        for mut point in validate::retained_raw(raw, Limits::default()).unwrap() {
            // Lineage identifies the physical acceptance; the logical sample must not change.
            let lineage = PointLineage::decode(point.lineage.as_slice()).unwrap();
            assert_eq!(lineage.record_id, raw.record_id);
            point.lineage.clear();
            if let Some(previous) = samples.insert(point.sample_id.clone(), point.clone()) {
                assert_eq!(previous, point, "retried batch changed a sample");
            }
        }
    }
    assert_eq!(acceptances["confirmed"], 1);
    assert!(acceptances["acknowledgement-lost"] >= 2);
    assert_eq!(acceptances["broker-restart"], 1);
    assert_eq!(
        samples.len(),
        3,
        "logical samples differ from the three batches"
    );
    eprintln!(
        "ingestion_recovered raw_records={} logical_samples={} lost_acknowledgement_attempts={lost_attempts} broker_restart_attempts={restart_attempts}",
        records.len(),
        samples.len()
    );
    drop(client);
    stop.send(()).unwrap();
    server.await.unwrap();
}
