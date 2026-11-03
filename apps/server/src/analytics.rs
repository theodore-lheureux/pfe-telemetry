use std::time::Duration;

use clickhouse::{Client, Row};
use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{InstrumentationScope, KeyValue, any_value::Value},
    metrics::v1::number_data_point,
    resource::v1::Resource,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{Result, broker::BatchStore, envelope::Envelope, metrics};

pub fn normalization_capacity(body: &ExportMetricsServiceRequest) -> Result<()> {
    let mut bytes = 0usize;
    let mut count = 0usize;
    for resource in &body.resource_metrics {
        let attrs = resource
            .resource
            .as_ref()
            .map_or(&[][..], |r| r.attributes.as_slice());
        let resource_size = metrics::string(attrs, "host.id").map_or(0, str::len)
            + metrics::string(attrs, "pfe.collection.scope").map_or(0, str::len);
        for scope in &resource.scope_metrics {
            for metric in &scope.metrics {
                for point in metrics::points(metric) {
                    bytes += 160
                        + resource_size
                        + metric.name.len()
                        + metric.unit.len()
                        + metrics::kind(metric).0.len()
                        + metrics::string(point.attributes(), "cpu.mode").map_or(0, str::len);
                    count += 1;
                    if bytes > 64 * 1024 * 1024 || count > 100_000 {
                        return Err("Batch exceeds analytical normalization capacity".into());
                    }
                }
            }
        }
    }
    Ok(())
}

fn canonical_attributes(attributes: &[KeyValue]) -> Vec<KeyValue> {
    fn canonical_value(value: &mut Value) {
        match value {
            Value::KvlistValue(list) => list.values = canonical_attributes(&list.values),
            Value::ArrayValue(array) => {
                for item in &mut array.values {
                    if let Some(value) = &mut item.value {
                        canonical_value(value);
                    }
                }
            }
            _ => {}
        }
    }
    let mut attributes = attributes.to_vec();
    attributes.sort_by(|a, b| a.key.cmp(&b.key));
    for attribute in &mut attributes {
        if let Some(value) = attribute
            .value
            .as_mut()
            .and_then(|value| value.value.as_mut())
        {
            canonical_value(value);
        }
    }
    attributes
}

fn identity_part(identity: &mut Sha256, part: &[u8]) {
    identity.update((part.len() as u64).to_be_bytes());
    identity.update(part);
}

#[derive(Row, Serialize)]
pub struct Batch {
    project_id: String,
    source_id: String,
    storage_key: String,
    content_digest: String,
    record_id: String,
    received_ns: u64,
    created_ns: u64,
    profile: String,
    client_batch_id: String,
    log_topic: String,
    log_partition: i32,
    log_offset: u64,
    payload_hex: String,
    #[serde(rename = "points.series_id")]
    series_ids: Vec<String>,
    #[serde(rename = "points.host_id")]
    hosts: Vec<Option<String>>,
    #[serde(rename = "points.collection_scope")]
    collection_scopes: Vec<String>,
    #[serde(rename = "points.metric")]
    metrics: Vec<String>,
    #[serde(rename = "points.unit")]
    units: Vec<String>,
    #[serde(rename = "points.kind")]
    kinds: Vec<String>,
    #[serde(rename = "points.temporality")]
    temporalities: Vec<i32>,
    #[serde(rename = "points.monotonic")]
    monotonic: Vec<bool>,
    #[serde(rename = "points.time_ns")]
    times: Vec<u64>,
    #[serde(rename = "points.start_ns")]
    starts: Vec<u64>,
    #[serde(rename = "points.flags")]
    flags: Vec<u32>,
    #[serde(rename = "points.integer_value")]
    integers: Vec<Option<i64>>,
    #[serde(rename = "points.double_value")]
    doubles: Vec<Option<f64>>,
    #[serde(rename = "points.cpu_mode")]
    cpu_modes: Vec<Option<String>>,
}

#[derive(Clone, Copy)]
pub struct LogPosition<'a> {
    pub topic: &'a str,
    pub partition: i32,
    pub offset: i64,
}

impl Batch {
    pub fn from_envelope(envelope: &Envelope, position: LogPosition<'_>) -> Result<Self> {
        if envelope.format_version != 1
            || envelope.payload_kind != "otlp.metrics"
            || !crate::auth::identifier(&envelope.project_id)
            || !crate::auth::identifier(&envelope.source_id)
            || !matches!(envelope.profile.as_str(), "external/1.0" | "standard")
            || envelope.payload.len() > crate::MAX_MESSAGE_BYTES
            || !Uuid::parse_str(&envelope.record_id)
                .is_ok_and(|v| v.get_version_num() == 7 && v.to_string() == envelope.record_id)
            || position.offset < 0
            || position.partition < 0
            || position.topic.is_empty()
        {
            return Err(
                "Invalid retained envelope or log position; progress was not committed".into(),
            );
        }
        let body = ExportMetricsServiceRequest::decode(envelope.payload.as_slice())?;
        normalization_capacity(&body)?;
        let mut batch = Self {
            project_id: envelope.project_id.clone(),
            source_id: envelope.source_id.clone(),
            storage_key: envelope.storage_key(),
            content_digest: envelope.content_digest(),
            record_id: envelope.record_id.clone(),
            received_ns: envelope.received_unix_nano,
            created_ns: envelope.client_created_unix_nano,
            profile: envelope.profile.clone(),
            client_batch_id: envelope.client_batch_id.clone(),
            log_topic: position.topic.to_owned(),
            log_partition: position.partition,
            log_offset: position.offset as u64,
            payload_hex: envelope
                .payload
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            series_ids: vec![],
            hosts: vec![],
            collection_scopes: vec![],
            metrics: vec![],
            units: vec![],
            kinds: vec![],
            temporalities: vec![],
            monotonic: vec![],
            times: vec![],
            starts: vec![],
            flags: vec![],
            integers: vec![],
            doubles: vec![],
            cpu_modes: vec![],
        };
        for resource in &body.resource_metrics {
            let attrs = resource
                .resource
                .as_ref()
                .map_or(&[][..], |r| r.attributes.as_slice());
            let resource_bytes = Resource {
                attributes: canonical_attributes(attrs),
                ..Default::default()
            }
            .encode_to_vec();
            let mut resource_identity = Sha256::new();
            identity_part(&mut resource_identity, &resource_bytes);
            identity_part(&mut resource_identity, resource.schema_url.as_bytes());
            for scope in &resource.scope_metrics {
                let scope_bytes = scope.scope.as_ref().map_or_else(Vec::new, |scope| {
                    InstrumentationScope {
                        name: scope.name.clone(),
                        version: scope.version.clone(),
                        attributes: canonical_attributes(&scope.attributes),
                        ..Default::default()
                    }
                    .encode_to_vec()
                });
                let mut scope_identity = resource_identity.clone();
                identity_part(&mut scope_identity, &scope_bytes);
                identity_part(&mut scope_identity, scope.schema_url.as_bytes());
                for metric in &scope.metrics {
                    let (kind, temporality, monotonic) = metrics::kind(metric);
                    let mut metric_identity = scope_identity.clone();
                    for part in [
                        metric.name.as_bytes(),
                        metric.unit.as_bytes(),
                        kind.as_bytes(),
                    ] {
                        identity_part(&mut metric_identity, part);
                    }
                    metric_identity.update(temporality.to_be_bytes());
                    metric_identity.update([u8::from(monotonic)]);
                    for point in metrics::points(metric) {
                        let mut identity = metric_identity.clone();
                        identity.update(point.start().to_be_bytes());
                        for attr in canonical_attributes(point.attributes()) {
                            let bytes = attr.encode_to_vec();
                            identity.update((bytes.len() as u64).to_be_bytes());
                            identity.update(bytes);
                        }
                        let (integer, double) =
                            match point.value().filter(|_| point.flags() & 1 == 0) {
                                Some(number_data_point::Value::AsInt(value)) => (Some(value), None),
                                Some(number_data_point::Value::AsDouble(value))
                                    if value.is_finite() =>
                                {
                                    (None, Some(value))
                                }
                                _ => (None, None),
                            };
                        let host = metrics::string(attrs, "host.id").map(str::to_owned);
                        let collection_scope = metrics::string(attrs, "pfe.collection.scope")
                            .unwrap_or("")
                            .to_owned();
                        let cpu_mode =
                            metrics::string(point.attributes(), "cpu.mode").map(str::to_owned);
                        batch
                            .series_ids
                            .push(crate::envelope::hex(identity.finalize()));
                        batch.hosts.push(host);
                        batch.collection_scopes.push(collection_scope);
                        batch.metrics.push(metric.name.clone());
                        batch.units.push(metric.unit.clone());
                        batch.kinds.push(kind.to_owned());
                        batch.temporalities.push(temporality);
                        batch.monotonic.push(monotonic);
                        batch.times.push(point.time());
                        batch.starts.push(point.start());
                        batch.flags.push(point.flags());
                        batch.integers.push(integer);
                        batch.doubles.push(double);
                        batch.cpu_modes.push(cpu_mode);
                    }
                }
            }
        }
        if batch.series_ids.is_empty() {
            return Err("Empty retained batch".into());
        }
        Ok(batch)
    }
}

pub struct Store {
    client: Client,
}

#[derive(Row, Deserialize)]
struct Existing {
    digest: String,
    topic: String,
    partition: i32,
    provenances: u64,
}

impl Store {
    pub fn new(url: &str, user: &str, password: &str) -> Self {
        Self {
            client: Client::default()
                .with_url(url)
                .with_user(user)
                .with_password(password)
                .with_database("telemetry")
                .with_setting("async_insert", "0")
                .with_setting("wait_end_of_query", "1")
                .with_setting("print_pretty_type_names", "0")
                .with_setting("max_execution_time", "10")
                .with_setting("max_memory_usage", "268435456")
                .with_setting("max_threads", "1"),
        }
    }

    pub async fn ready(&self) -> bool {
        tokio::time::timeout(
            Duration::from_secs(3),
            self.client
                .query("SELECT count() FROM batches WHERE 0")
                .fetch_one::<u64>(),
        )
        .await
        .is_ok_and(|r| r.is_ok())
    }

    pub async fn publish_batch(&self, batch: &Batch) -> Result<bool> {
        let operation = async {
            let previous = self.client.query(
                "SELECT tupleElement(first, 1) AS digest, tupleElement(first, 2) AS topic, tupleElement(first, 3) AS partition, provenances FROM (SELECT argMin(tuple(content_digest, log_topic, log_partition), tuple(log_offset, record_id)) AS first, uniqExact(tuple(log_topic, log_partition)) AS provenances FROM batches WHERE project_id = ? AND source_id = ? AND storage_key = ? HAVING count() > 0)"
            ).bind(&batch.project_id).bind(&batch.source_id).bind(&batch.storage_key).fetch_all::<Existing>().await?;
            if let Some(previous) = previous.first() {
                if previous.digest != batch.content_digest
                    || previous.topic != batch.log_topic
                    || previous.partition != batch.log_partition
                    || previous.provenances != 1
                {
                    return Err(
                        "Conflicting batch or changed Kafka provenance; first batch preserved"
                            .into(),
                    );
                }
                return Ok(false);
            }
            // One row is one complete batch and one partition. No separate ledger or partially visible point insert.
            let mut insert = self.client.insert::<Batch>("batches").await?;
            insert.write(batch).await?;
            insert.end().await?;
            Ok(true)
        };
        tokio::time::timeout(Duration::from_secs(20), operation)
            .await
            .map_err(|_| "ClickHouse publication deadline exceeded")?
    }
}

#[tonic::async_trait]
impl BatchStore for Store {
    async fn publish(&self, envelope: &Envelope, position: LogPosition<'_>) -> Result<bool> {
        let batch = Batch::from_envelope(envelope, position)?;
        // An ambiguous response may have committed. Queries always deduplicate the complete row.
        let mut delay = 1;
        loop {
            match self.publish_batch(&batch).await {
                Ok(written) => return Ok(written),
                Err(error)
                    if error.downcast_ref::<clickhouse::error::Error>().is_some()
                        || error.to_string() == "ClickHouse publication deadline exceeded" =>
                {
                    tracing::warn!("ClickHouse publication unconfirmed; offset retained, retrying");
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                    delay = (delay * 2).min(10);
                }
                Err(error) => return Err(error),
            }
        }
    }
}
