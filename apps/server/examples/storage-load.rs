use std::time::{Duration, Instant};

use clap::Parser;
use opentelemetry_proto::tonic::{
    collector::metrics::v1::{
        ExportMetricsServiceRequest, metrics_service_client::MetricsServiceClient,
    },
    common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value::Value},
    metrics::v1::{
        Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum, metric,
        number_data_point,
    },
    resource::v1::Resource,
};
use pfe_server::Result;

const ORIGIN: u64 = 1_730_000_000_000_000_000;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "http://ingestion:4317")]
    endpoint: String,
    #[arg(long, env = "LOAD_TOKEN", hide_env_values = true)]
    token: String,
    #[arg(long, env = "LOAD_CREATED_ORIGIN")]
    created_origin: u64,
    #[arg(long, default_value_t = 0)]
    start: u64,
    #[arg(long, default_value_t = 500)]
    batches: u64,
    #[arg(long, default_value_t = 0)]
    interval_ms: u64,
}

fn attr(key: &str, value: Value) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue { value: Some(value) }),
        ..Default::default()
    }
}

fn batch(sequence: u64) -> ExportMetricsServiceRequest {
    let mut resources = Vec::new();
    for host in 0..8 {
        for process in 0..8 {
            let mut metrics = Vec::new();
            for (index, (name, unit)) in [
                ("system.cpu.time", "s"),
                ("system.disk.io", "By"),
                ("process.memory.usage", "By"),
            ]
            .into_iter()
            .enumerate()
            {
                let point = NumberDataPoint {
                    start_time_unix_nano: ORIGIN,
                    time_unix_nano: ORIGIN + (sequence + 1) * 1_000_000_000,
                    value: Some(number_data_point::Value::AsInt(
                        (sequence * 1000 + host * 100 + process * 10 + index as u64) as i64,
                    )),
                    ..Default::default()
                };
                let data = if index == 2 {
                    metric::Data::Gauge(Gauge {
                        data_points: vec![point],
                    })
                } else {
                    metric::Data::Sum(Sum {
                        data_points: vec![point],
                        aggregation_temporality: 2,
                        is_monotonic: true,
                    })
                };
                metrics.push(Metric {
                    name: name.into(),
                    unit: unit.into(),
                    data: Some(data),
                    ..Default::default()
                });
            }
            resources.push(ResourceMetrics {
                resource: Some(Resource {
                    attributes: vec![
                        attr("host.id", Value::StringValue(format!("load-node-{host}"))),
                        attr("process.pid", Value::IntValue(process as i64)),
                    ],
                    ..Default::default()
                }),
                scope_metrics: vec![ScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "storage-load".into(),
                        version: env!("CARGO_PKG_VERSION").into(),
                        ..Default::default()
                    }),
                    metrics,
                    ..Default::default()
                }],
                ..Default::default()
            });
        }
    }
    ExportMetricsServiceRequest {
        resource_metrics: resources,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.batches == 0
        || args
            .start
            .checked_add(args.batches)
            .is_none_or(|end| end > 1_000_000_000)
    {
        return Err("Expected 1..1,000,000,000 batches and a bounded sequence".into());
    }
    let mut client = MetricsServiceClient::connect(args.endpoint).await?;
    let run = Instant::now();
    for sequence in args.start..args.start + args.batches {
        let target = Duration::from_millis(args.interval_ms.saturating_mul(sequence - args.start));
        if let Some(delay) = target.checked_sub(run.elapsed()) {
            tokio::time::sleep(delay).await;
        }
        let mut request = tonic::Request::new(batch(sequence));
        request
            .metadata_mut()
            .insert("authorization", format!("Bearer {}", args.token).parse()?);
        request.metadata_mut().insert(
            "pfe-batch-id",
            format!("01900000-0000-7000-8000-{sequence:012x}").parse()?,
        );
        request.metadata_mut().insert(
            "pfe-batch-created-unix-nano",
            (args.created_origin + sequence).to_string().parse()?,
        );
        let sent = pfe_server::unix_nanos()?;
        let started = Instant::now();
        let response = client.export(request).await?.into_inner();
        if response
            .partial_success
            .is_some_and(|p| p.rejected_data_points != 0 || !p.error_message.is_empty())
        {
            return Err("Partial ingestion acceptance".into());
        }
        println!(
            "{}",
            serde_json::json!({"sequence":sequence,"rows":192,"sent_ns":sent,"ack_ns":pfe_server::unix_nanos()?,"ack_ms":started.elapsed().as_secs_f64()*1000.0})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn generated_batches_are_valid_repeatable_and_distinct() {
        const TOKEN: &str = "storage-experiment-test-token-at-least-32-characters";
        let policy = pfe_server::auth::Sources::parse(
            &serde_json::json!([{
                "project_id":"experiment", "source_id":"generator",
                "token_sha256":pfe_server::envelope::digest(TOKEN.as_bytes()),
                "hosts":(0..8).map(|h| format!("load-node-{h}")).collect::<Vec<_>>()
            }])
            .to_string(),
        )
        .unwrap();
        let mut metadata = tonic::metadata::MetadataMap::new();
        metadata.insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        let source = policy.authenticate(&metadata).unwrap();
        assert_eq!(
            pfe_server::metrics::validate(&batch(0), &source, false).unwrap(),
            192
        );
        assert_eq!(batch(42).encode_to_vec(), batch(42).encode_to_vec());
        assert_ne!(batch(41).encode_to_vec(), batch(42).encode_to_vec());
    }
}
