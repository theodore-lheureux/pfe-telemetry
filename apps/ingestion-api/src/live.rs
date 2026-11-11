use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest, common::v1::any_value,
    metrics::v1::metric::Data,
};
use prost::Message;
use rdkafka::{
    ClientConfig,
    producer::{FutureProducer, FutureRecord},
};
use recount_telemetry_schema::wire::{LiveNode, LiveNotification, RawRecord};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tokio::sync::mpsc;

pub const MAX_NOTIFICATION_BYTES: usize = 32768;

pub fn notification(raw: &RawRecord, body: &ExportMetricsServiceRequest) -> LiveNotification {
    let bindings: BTreeMap<_, _> = raw
        .bindings
        .iter()
        .filter_map(|b| {
            b.context
                .as_ref()
                .map(|c| (b.original_resource as usize, c))
        })
        .collect();
    let mut nodes = BTreeMap::<String, LiveNode>::new();
    let mut latest = 0;
    let mut metrics = 0;
    let mut points = 0;
    for (index, resource) in body.resource_metrics.iter().enumerate() {
        let mut resource_latest = 0;
        for scope in &resource.scope_metrics {
            for metric in &scope.metrics {
                metrics += 1;
                let (count, time) = match &metric.data {
                    Some(Data::Gauge(v)) => {
                        count_times(v.data_points.iter().map(|p| p.time_unix_nano))
                    }
                    Some(Data::Sum(v)) => {
                        count_times(v.data_points.iter().map(|p| p.time_unix_nano))
                    }
                    Some(Data::Histogram(v)) => {
                        count_times(v.data_points.iter().map(|p| p.time_unix_nano))
                    }
                    Some(Data::ExponentialHistogram(v)) => {
                        count_times(v.data_points.iter().map(|p| p.time_unix_nano))
                    }
                    Some(Data::Summary(v)) => {
                        count_times(v.data_points.iter().map(|p| p.time_unix_nano))
                    }
                    None => (0, 0),
                };
                points += count;
                resource_latest = resource_latest.max(time);
            }
        }
        latest = latest.max(resource_latest);
        let context = bindings.get(&index);
        let host = context
            .and_then(|c| {
                c.host_id.as_deref().or_else(|| {
                    c.resource
                        .as_ref()
                        .filter(|r| r.kind == 1)
                        .map(|r| r.id.as_str())
                })
            })
            .filter(|id| !id.is_empty());
        if let Some(id) = host {
            let name = resource
                .resource
                .as_ref()
                .and_then(|r| r.attributes.iter().find(|a| a.key == "host.name"))
                .and_then(|a| a.value.as_ref())
                .and_then(|v| match &v.value {
                    Some(any_value::Value::StringValue(v)) => {
                        Some(v.chars().take(128).collect::<String>())
                    }
                    _ => None,
                })
                .unwrap_or_else(|| id.to_owned());
            let node = nodes.entry(id.to_owned()).or_insert_with(|| LiveNode {
                id: id.to_owned(),
                name,
                measured_unix_nano: 0,
            });
            node.measured_unix_nano = node.measured_unix_nano.max(resource_latest);
        }
    }
    let scope = raw.security.as_ref().expect("authorized raw scope");
    LiveNotification {
        project_id: scope.project_id.clone(),
        source_id: scope.source_id.clone(),
        record_id: raw.record_id.clone(),
        received_unix_nano: raw.received_unix_nano,
        measured_unix_nano: latest,
        nodes_truncated: nodes.len() > 64,
        nodes: nodes.into_values().take(64).collect(),
        resources: body.resource_metrics.len() as u32,
        metrics,
        points,
        bytes: raw.encoded_len() as u32,
        raw_partition: 0,
        raw_offset: 0,
    }
}

fn count_times(times: impl Iterator<Item = u64>) -> (u32, u64) {
    times.fold((0, 0), |(count, latest), time| {
        (count + 1, latest.max(time))
    })
}

pub fn shard(project_id: &str, partitions: u32) -> i32 {
    let digest = Sha256::digest(project_id.as_bytes());
    (u32::from_be_bytes(digest[..4].try_into().expect("hash prefix")) % partitions) as i32
}

pub struct LivePublisher(mpsc::Sender<LiveNotification>);
impl LivePublisher {
    pub fn new(bootstrap: &str, topic: String, partitions: u32) -> crate::Result<Self> {
        if partitions == 0 || partitions > 256 {
            return Err("Live partitions must be within 1..=256".into());
        }
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", bootstrap)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("allow.auto.create.topics", "false")
            .set("linger.ms", "10")
            .set("batch.size", "32768")
            .set("message.max.bytes", "65536")
            .set("message.timeout.ms", "1000")
            .set("queue.buffering.max.kbytes", "4096")
            .set("queue.buffering.max.messages", "128")
            .create()?;
        let (sender, mut receiver) = mpsc::channel::<LiveNotification>(128);
        tokio::spawn(async move {
            let mut pending = tokio::task::JoinSet::new();
            loop {
                if pending.len() >= 128 {
                    pending.join_next().await;
                    continue;
                }
                let notification = tokio::select! {
                    value = receiver.recv() => match value { Some(value) => value, None => break },
                    _ = pending.join_next(), if !pending.is_empty() => continue,
                };
                let bytes = notification.encode_to_vec();
                if bytes.len() > MAX_NOTIFICATION_BYTES {
                    tracing::warn!("Live notification exceeds byte bound");
                    continue;
                }
                let result = producer.send_result(
                    FutureRecord::to(&topic)
                        .partition(shard(&notification.project_id, partitions))
                        .key(&notification.project_id)
                        .payload(&bytes),
                );
                match result {
                    Ok(delivery) => {
                        pending.spawn(async move {
                        if !matches!(delivery.await, Ok(Ok(_))) { tracing::warn!("Live notification publication failed; raw packet remains accepted"); }
                    });
                    }
                    Err(_) => {
                        tracing::warn!("Live producer queue full; raw packet remains accepted")
                    }
                }
            }
            while pending.join_next().await.is_some() {}
        });
        Ok(Self(sender))
    }
    pub fn publish(&self, notification: LiveNotification) {
        if notification.encoded_len() > MAX_NOTIFICATION_BYTES {
            tracing::warn!("Live notification exceeds byte bound");
            return;
        }
        if self.0.try_send(notification).is_err() {
            tracing::warn!("Live notification queue full; raw packet remains accepted");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_schema::{
        metrics::{Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, metric},
        wire::{ResourceBinding, ResourceContext, SecurityScope},
    };

    #[test]
    fn notifications_summarize_points_and_freshness_without_copying_payloads() {
        let raw = RawRecord {
            security: Some(SecurityScope {
                project_id: "019a4790-d1da-7000-8000-000000000002".into(),
                source_id: "source".into(),
            }),
            record_id: "packet".into(),
            received_unix_nano: 500,
            otlp_request: vec![1; 200000],
            bindings: (0..70)
                .map(|index| ResourceBinding {
                    original_resource: index,
                    context: Some(ResourceContext {
                        host_id: Some(format!("node-{index}")),
                        ..Default::default()
                    }),
                })
                .collect(),
            ..Default::default()
        };
        let body = ExportMetricsServiceRequest {
            resource_metrics: (0..70)
                .map(|_| ResourceMetrics {
                    scope_metrics: vec![ScopeMetrics {
                        metrics: vec![Metric {
                            data: Some(metric::Data::Gauge(Gauge {
                                data_points: vec![
                                    NumberDataPoint {
                                        time_unix_nano: 400,
                                        ..Default::default()
                                    },
                                    NumberDataPoint {
                                        time_unix_nano: 300,
                                        ..Default::default()
                                    },
                                ],
                            })),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }],
                    ..Default::default()
                })
                .collect(),
        };
        let notice = notification(&raw, &body);
        assert_eq!(
            (notice.resources, notice.metrics, notice.points),
            (70, 70, 140)
        );
        assert_eq!(notice.measured_unix_nano, 400);
        assert_eq!(notice.received_unix_nano, 500);
        assert_eq!(notice.nodes.len(), 64);
        assert!(notice.nodes_truncated);
        assert!(notice.nodes.iter().all(|n| n.measured_unix_nano == 400));
        assert_eq!(notice.bytes as usize, raw.encoded_len());
        assert!(notice.encoded_len() < MAX_NOTIFICATION_BYTES);
        assert!(notice.encoded_len() < raw.encoded_len() / 10);
        assert_eq!(shard(&notice.project_id, 8), 5);
    }
}
