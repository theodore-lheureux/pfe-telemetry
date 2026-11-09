use crate::Result;
use prost::Message;
use rdkafka::{
    ClientConfig,
    admin::{AdminClient, AdminOptions, ResourceSpecifier},
    client::DefaultClientContext,
    producer::{FutureProducer, FutureRecord, Producer},
    util::Timeout,
};
use recount_telemetry_schema::{identity::raw_routing_key, wire::RawRecord};
use recount_telemetry_validation::transport::body_fits;
use std::time::Duration;

#[tonic::async_trait]
pub trait Sink: Send + Sync {
    async fn publish(&self, raw: &RawRecord) -> Result<()>;
    async fn ready(&self) -> bool;
}

pub struct KafkaSink {
    producer: FutureProducer,
    admin: AdminClient<DefaultClientContext>,
    topic: String,
    partitions: i32,
    max_bytes: usize,
    broker_max_bytes: usize,
}

impl KafkaSink {
    pub fn new(
        bootstrap: &str,
        topic: &str,
        partitions: i32,
        max_bytes: usize,
        broker_max_bytes: usize,
    ) -> Result<Self> {
        if partitions <= 0 {
            return Err("raw partition count must be positive".into());
        }
        body_fits(max_bytes, broker_max_bytes)?;
        let admin = ClientConfig::new()
            .set("bootstrap.servers", bootstrap)
            .create()?;
        let producer = ClientConfig::new()
            .set("bootstrap.servers", bootstrap)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("allow.auto.create.topics", "false")
            .set("message.max.bytes", broker_max_bytes.to_string())
            .set("message.timeout.ms", "5000")
            .set("socket.timeout.ms", "3000")
            .set(
                "queue.buffering.max.kbytes",
                (max_bytes / 1024 + 1024).to_string(),
            )
            .create()?;
        Ok(Self {
            producer,
            admin,
            topic: topic.into(),
            partitions,
            max_bytes,
            broker_max_bytes,
        })
    }
}

#[tonic::async_trait]
impl Sink for KafkaSink {
    async fn publish(&self, raw: &RawRecord) -> Result<()> {
        let bytes = raw.encode_to_vec();
        if bytes.len() > self.max_bytes {
            return Err("Raw record exceeds configured producer bound".into());
        }
        let key = raw_routing_key(raw)?;
        self.producer
            .send(
                FutureRecord::to(&self.topic).key(&key).payload(&bytes),
                Timeout::After(Duration::from_millis(100)),
            )
            .await
            .map_err(|_| "Kafka did not confirm raw publication")?;
        Ok(())
    }
    async fn ready(&self) -> bool {
        let resources = [ResourceSpecifier::Topic(&self.topic)];
        let options = AdminOptions::new().request_timeout(Some(Duration::from_secs(2)));
        let config_matches = match tokio::time::timeout(
            Duration::from_secs(3),
            self.admin.describe_configs(&resources, &options),
        )
        .await
        {
            Ok(Ok(results)) => results.into_iter().any(|result| {
                result.is_ok_and(|resource| {
                    resource
                        .get("max.message.bytes")
                        .and_then(|entry| entry.value.as_ref())
                        .and_then(|v| v.parse::<usize>().ok())
                        == Some(self.broker_max_bytes)
                })
            }),
            _ => false,
        };
        if !config_matches {
            return false;
        }
        let producer = self.producer.clone();
        let topic = self.topic.clone();
        let partitions = self.partitions;
        tokio::task::spawn_blocking(move || {
            producer
                .client()
                .fetch_metadata(Some(&topic), Duration::from_secs(2))
                .is_ok_and(|m| {
                    m.topics().iter().any(|t| {
                        t.name() == topic
                            && t.error().is_none()
                            && t.partitions().len() == partitions as usize
                            && t.partitions()
                                .iter()
                                .all(|p| p.error().is_none() && p.leader() >= 0)
                    })
                })
        })
        .await
        .unwrap_or(false)
    }
}
