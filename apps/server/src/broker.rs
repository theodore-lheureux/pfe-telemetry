use std::{sync::Arc, time::Duration};

use prost::Message as _;
use rdkafka::{
    ClientConfig,
    consumer::{CommitMode, Consumer, StreamConsumer},
    error::{KafkaError, RDKafkaErrorCode},
    message::Message,
    producer::{FutureProducer, FutureRecord, Producer},
    util::Timeout,
};

use crate::{Result, envelope::Envelope, storage::Store};

#[tonic::async_trait]
pub trait Sink: Send + Sync {
    async fn publish(&self, envelope: &Envelope) -> Result<()>;
    async fn ready(&self) -> bool;
}

/// Confirms Kafka publication before ingestion acknowledges a batch.
pub struct KafkaSink {
    producer: FutureProducer,
    topic: String,
}

impl KafkaSink {
    pub fn new(bootstrap: &str, topic: &str) -> Result<Self> {
        let producer = ClientConfig::new()
            .set("bootstrap.servers", bootstrap)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("allow.auto.create.topics", "false")
            .set("message.max.bytes", "6291456")
            .set("message.timeout.ms", "5000")
            .set("socket.timeout.ms", "3000")
            .set("queue.buffering.max.kbytes", "16384")
            .create()?;
        Ok(Self {
            producer,
            topic: topic.to_owned(),
        })
    }
}

#[tonic::async_trait]
impl Sink for KafkaSink {
    async fn publish(&self, envelope: &Envelope) -> Result<()> {
        let bytes = envelope.encode_to_vec();
        let key = envelope.storage_key();
        self.producer
            .send(
                FutureRecord::to(&self.topic).key(&key).payload(&bytes),
                Timeout::After(Duration::from_millis(100)),
            )
            .await
            .map_err(|_| "Kafka did not confirm publication")?;
        Ok(())
    }

    async fn ready(&self) -> bool {
        let producer = self.producer.clone();
        let topic = self.topic.clone();
        tokio::task::spawn_blocking(move || {
            producer
                .client()
                .fetch_metadata(Some(&topic), Duration::from_secs(2))
                .is_ok_and(|metadata| {
                    metadata.topics().iter().any(|v| {
                        v.name() == topic
                            && v.error().is_none()
                            && !v.partitions().is_empty()
                            && v.partitions()
                                .iter()
                                .all(|p| p.error().is_none() && p.leader() >= 0)
                    })
                })
        })
        .await
        .unwrap_or(false)
    }
}

pub fn consumer(bootstrap: &str, topic: &str, group: &str) -> Result<StreamConsumer> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", bootstrap)
        .set("group.id", group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "earliest")
        .set("allow.auto.create.topics", "false")
        .set("fetch.message.max.bytes", "6291456")
        .set("fetch.max.bytes", "12582912")
        .set("queued.max.messages.kbytes", "16384")
        .set("max.poll.interval.ms", "300000")
        .create()?;
    consumer.subscribe(&[topic])?;
    Ok(consumer)
}

pub async fn consume_one(consumer: &StreamConsumer, store: Arc<Store>) -> Result<Option<bool>> {
    // Poll group events regularly even when no telemetry arrives. The timeout
    // covers receipt only; file publication and offset commits must finish.
    let message = match tokio::time::timeout(Duration::from_secs(5), consumer.recv()).await {
        Ok(Ok(message)) => message,
        Ok(Err(error)) if temporary_consumer_error(&error) => {
            tracing::warn!(code=?error.rdkafka_error_code(), "Kafka connection interrupted; waiting for recovery");
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(None);
        }
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => return Ok(None),
    };
    let payload = message.payload().ok_or("Empty ingestion envelope")?;
    if payload.len() > 6 * 1024 * 1024 {
        return Err("Oversized ingestion envelope".into());
    }
    let envelope = Envelope::decode(payload)?;
    let topic = message.topic().to_owned();
    let partition = message.partition();
    let offset = message.offset();
    let record_id = envelope.record_id.clone();
    let written = tokio::task::spawn_blocking(move || store.publish(&envelope)).await??;
    // A replay of any earlier message is safe only after file publication succeeds.
    consumer.commit_message(&message, CommitMode::Async)?;
    tracing::info!(%topic, partition, offset, %record_id, written, "Stored telemetry; queued offset commit");
    Ok(Some(written))
}

fn temporary_consumer_error(error: &KafkaError) -> bool {
    matches!(
        error,
        KafkaError::Global(_) | KafkaError::MessageConsumption(_)
    ) && matches!(
        error.rdkafka_error_code(),
        Some(
            RDKafkaErrorCode::AllBrokersDown
                | RDKafkaErrorCode::BrokerTransportFailure
                | RDKafkaErrorCode::OperationTimedOut
                | RDKafkaErrorCode::Resolve
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_errors_do_not_hide_fatal_or_authorization_failures() {
        assert!(temporary_consumer_error(&KafkaError::MessageConsumption(
            RDKafkaErrorCode::AllBrokersDown
        )));
        assert!(!temporary_consumer_error(
            &KafkaError::MessageConsumptionFatal(RDKafkaErrorCode::AllBrokersDown)
        ));
        assert!(!temporary_consumer_error(&KafkaError::Global(
            RDKafkaErrorCode::Authentication
        )));
    }
}
