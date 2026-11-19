use crate::Result;
use crate::live::{LivePublisher, notification};
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use prost::Message;
use rdkafka::{
    ClientConfig,
    admin::{AdminClient, AdminOptions, ResourceSpecifier},
    client::DefaultClientContext,
    producer::{FutureProducer, FutureRecord, Producer},
    util::Timeout,
};
use recount_telemetry_schema::{
    execution,
    identity::{partition, raw_routing_key},
    wire::{AnalyticalParticipant, RawRecord},
};
use recount_telemetry_validation::{execution::routing_key, transport::body_fits};
use std::time::Duration;

#[tonic::async_trait]
pub trait Sink: Send + Sync {
    async fn publish(&self, raw: &RawRecord, body: &ExportMetricsServiceRequest) -> Result<()>;
    async fn publish_participant(&self, row: &AnalyticalParticipant) -> Result<()>;
    async fn ready(&self) -> bool;
}

pub struct KafkaSink {
    producer: FutureProducer,
    admin: AdminClient<DefaultClientContext>,
    topic: String,
    partitions: i32,
    max_bytes: usize,
    broker_max_bytes: usize,
    live: LivePublisher,
    participant_topic: String,
    participant_partitions: u32,
}

pub struct Topic<'a> {
    pub name: &'a str,
    pub partitions: u32,
}

impl KafkaSink {
    pub fn new(
        bootstrap: &str,
        raw: Topic<'_>,
        max_bytes: usize,
        broker_max_bytes: usize,
        live: Topic<'_>,
        participants: Topic<'_>,
    ) -> Result<Self> {
        if raw.partitions == 0 || participants.partitions == 0 {
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
            // Matches the raw topic's codec, so the broker stores batches unchanged.
            .set("compression.type", "zstd")
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
            topic: raw.name.into(),
            partitions: raw.partitions as i32,
            max_bytes,
            broker_max_bytes,
            live: LivePublisher::new(bootstrap, live.name.into(), live.partitions)?,
            participant_topic: participants.name.into(),
            participant_partitions: participants.partitions,
        })
    }
}

#[tonic::async_trait]
impl Sink for KafkaSink {
    async fn publish_participant(&self, row: &AnalyticalParticipant) -> Result<()> {
        let bytes = row.encode_to_vec();
        if bytes.len() > execution::MAX_ANALYTICAL_RECORD_BYTES {
            return Err("Participant byte limit exceeded".into());
        }
        let key = routing_key(&row.project_id, &row.execution_key);
        self.producer
            .send(
                FutureRecord::to(&self.participant_topic)
                    .key(&key)
                    .payload(&bytes)
                    .partition(
                        partition(&key, self.participant_partitions)
                            .ok_or("Invalid partition count")? as i32,
                    ),
                Timeout::After(Duration::from_millis(100)),
            )
            .await
            .map_err(|_| "Kafka did not confirm participant publication")?;
        Ok(())
    }
    async fn publish(&self, raw: &RawRecord, body: &ExportMetricsServiceRequest) -> Result<()> {
        let bytes = raw.encode_to_vec();
        if bytes.len() > self.max_bytes {
            return Err("Raw record exceeds configured producer bound".into());
        }
        let key = raw_routing_key(raw)?;
        let delivery = self
            .producer
            .send(
                FutureRecord::to(&self.topic)
                    .key(&key)
                    .payload(&bytes)
                    .timestamp((raw.received_unix_nano / 1_000_000) as i64),
                Timeout::After(Duration::from_millis(100)),
            )
            .await
            .map_err(|_| "Kafka did not confirm raw publication")?;
        let mut live = notification(raw, body);
        live.raw_partition = delivery.partition as u32;
        live.raw_offset = delivery.offset as u64;
        self.live.publish(live);
        Ok(())
    }
    async fn ready(&self) -> bool {
        self.topic_ready(&self.topic, self.partitions).await
            && self
                .topic_ready(&self.participant_topic, self.participant_partitions as i32)
                .await
    }
}

impl KafkaSink {
    async fn topic_ready(&self, topic: &str, partitions: i32) -> bool {
        let resources = [ResourceSpecifier::Topic(topic)];
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
        let topic = topic.to_owned();
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
