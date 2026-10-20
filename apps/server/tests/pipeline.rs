mod common;
use common::*;
use pfe_server::{
    Result,
    broker::{self, KafkaSink, Sink},
    envelope::Envelope,
    storage::Store,
};
use prost::Message as _;
use rdkafka::{
    ClientConfig,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::Consumer,
    message::Message as _,
};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

struct LoseResponse(Arc<KafkaSink>);
#[tonic::async_trait]
impl Sink for LoseResponse {
    async fn publish(&self, envelope: &Envelope) -> Result<()> {
        self.0.publish(envelope).await?;
        Err("Publication succeeded but its response was lost".into())
    }
    async fn ready(&self) -> bool {
        self.0.ready().await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires a real Kafka broker; set TELEMETRY_KAFKA_BOOTSTRAP"]
async fn retained_batches_recover_after_worker_restart_and_lost_acknowledgement() {
    let bootstrap = std::env::var("TELEMETRY_KAFKA_BOOTSTRAP").expect("TELEMETRY_KAFKA_BOOTSTRAP");
    let topic = format!("pfe-test-{}", Uuid::now_v7());
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", &bootstrap)
        .create()
        .unwrap();
    let results = admin
        .create_topics(
            &[NewTopic::new(&topic, 1, TopicReplication::Fixed(1))],
            &AdminOptions::new().operation_timeout(Some(Duration::from_secs(10))),
        )
        .await
        .unwrap();
    assert!(results[0].is_ok());
    eprintln!("Created test topic");
    let sink = Arc::new(KafkaSink::new(&bootstrap, &topic).unwrap());
    let (mut client, stop, task) = server(Arc::new(LoseResponse(sink.clone()))).await;
    let id = Uuid::now_v7().to_string();
    let body = request();
    let first = export(body.clone(), &id);
    let created = first
        .metadata()
        .get("pfe-batch-created-unix-nano")
        .unwrap()
        .clone();
    assert_eq!(
        client.export(first).await.unwrap_err().code(),
        tonic::Code::Unavailable
    );
    drop(client);
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    let (mut client, stop, task) = server(sink).await;
    let mut retry = export(body, &id);
    retry
        .metadata_mut()
        .insert("pfe-batch-created-unix-nano", created);
    client.export(retry).await.unwrap();
    eprintln!("Accepted original batch and retry");
    let directory = Directory::new();
    let store = Arc::new(Store::open(&directory.0).unwrap());
    let group = format!("pfe-test-{}", Uuid::now_v7());
    let consumer = broker::consumer(&bootstrap, &topic, &group).unwrap();
    // Simulate a worker dying after durable publication and before offset commit.
    let retained = tokio::time::timeout(Duration::from_secs(20), consumer.recv())
        .await
        .unwrap()
        .unwrap();
    let envelope = Envelope::decode(retained.payload().unwrap()).unwrap();
    assert!(store.publish(&envelope).unwrap());
    eprintln!("Published before offset commit");
    assert_eq!(retained.offset(), 0);
    drop(retained);
    consumer.unsubscribe();
    drop(consumer);
    eprintln!("Closed consumer");
    drop(store);
    let store = Arc::new(Store::open(&directory.0).unwrap());
    let consumer = broker::consumer(&bootstrap, &topic, &group).unwrap();
    // Both the original and the client retry resolve to the existing analytical file.
    for _ in 0..2 {
        assert!(
            !tokio::time::timeout(
                Duration::from_secs(20),
                broker::consume_one(&consumer, store.clone())
            )
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        );
    }
    assert_eq!(
        broker::consume_one(&consumer, store.clone()).await.unwrap(),
        None
    );
    let additional = export(request(), &Uuid::now_v7().to_string());
    client.export(additional).await.unwrap();
    assert_eq!(
        broker::consume_one(&consumer, store.clone()).await.unwrap(),
        Some(true)
    );
    eprintln!("Replay was duplicate-safe and processing resumed after an idle interval");
    assert_eq!(directory.files().len(), 2);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            // Offset metadata owns native partition references. Release it before awaiting or destroying the consumer.
            let committed = {
                let position = consumer.committed(Duration::from_secs(2)).unwrap();
                position.elements()[0].offset() == rdkafka::Offset::Offset(3)
            };
            if committed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    consumer.unsubscribe();
    drop(consumer);
    eprintln!("Closed consumer");
    drop(client);
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    eprintln!("Stopped test server");
    let results = admin
        .delete_topics(
            &[topic.as_str()],
            &AdminOptions::new().operation_timeout(Some(Duration::from_secs(10))),
        )
        .await
        .unwrap();
    assert!(results[0].is_ok());
}
