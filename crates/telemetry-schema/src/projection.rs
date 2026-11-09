use crate::{
    common::{AnyValue, KeyValue, any_value::Value},
    identity,
    metrics::{Metric, metric::Data},
    point::{Observation, observations},
    wire::{AnalyticalPoint, AttributeNode, NormalizedPoint, PointLineage},
};
use prost::Message;

// SQL's repeated named tuple is the query projection of the generated OTLP tree.
// Paths retain container type and array position; repeated order retains map order.
pub fn attributes(attrs: &[KeyValue]) -> Result<Vec<AttributeNode>, &'static str> {
    fn escape(key: &str) -> String {
        key.replace('~', "~0").replace('/', "~1")
    }
    fn walk(
        out: &mut Vec<AttributeNode>,
        path: String,
        value: Option<&AnyValue>,
        depth: usize,
    ) -> Result<(), &'static str> {
        if depth > 16 {
            return Err("attribute depth limit");
        }
        let mut node = AttributeNode {
            path: path.clone(),
            ..Default::default()
        };
        match value.map(|v| &v.value) {
            None => {}
            Some(None) => node.kind = 1,
            Some(Some(Value::StringValue(v))) => {
                node.kind = 2;
                node.string_value = Some(v.clone());
            }
            Some(Some(Value::IntValue(v))) => {
                node.kind = 3;
                node.int_value = Some(*v);
            }
            Some(Some(Value::DoubleValue(v))) if v.is_finite() => {
                node.kind = 4;
                node.double_value = Some(*v);
            }
            Some(Some(Value::DoubleValue(_))) => return Err("nonfinite attribute"),
            Some(Some(Value::BoolValue(v))) => {
                node.kind = 5;
                node.bool_value = Some(*v);
            }
            Some(Some(Value::BytesValue(v))) => {
                node.kind = 6;
                node.bytes_value = Some(v.clone());
            }
            Some(Some(Value::ArrayValue(_))) => node.kind = 7,
            Some(Some(Value::KvlistValue(_))) => node.kind = 8,
            Some(Some(Value::StringValueStrindex(_))) => {
                return Err("dictionary strings are not admitted for metrics");
            }
        }
        out.push(node);
        match value.and_then(|v| v.value.as_ref()) {
            Some(Value::ArrayValue(v)) => {
                for (i, value) in v.values.iter().enumerate() {
                    walk(out, format!("{path}/{i}"), Some(value), depth + 1)?;
                }
            }
            Some(Value::KvlistValue(v)) => {
                for kv in &v.values {
                    walk(
                        out,
                        format!("{path}/{}", escape(&kv.key)),
                        kv.value.as_ref(),
                        depth + 1,
                    )?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    identity::canonical_attributes(attrs)?;
    let mut out = Vec::new();
    for kv in attrs {
        walk(
            &mut out,
            format!("/{}", escape(&kv.key)),
            kv.value.as_ref(),
            0,
        )?;
    }
    Ok(out)
}

pub fn project(point: &NormalizedPoint) -> Result<AnalyticalPoint, &'static str> {
    let security = point.security.as_ref().ok_or("missing security")?;
    let context = point.context.as_ref().ok_or("missing context")?;
    let reference = context
        .resource
        .as_ref()
        .ok_or("missing resource reference")?;
    let resource =
        crate::resource::Resource::decode(point.otlp_resource.as_deref().unwrap_or_default())
            .map_err(|_| "invalid resource")?;
    let scope = crate::common::InstrumentationScope::decode(
        point.otlp_scope.as_deref().unwrap_or_default(),
    )
    .map_err(|_| "invalid scope")?;
    let metric = Metric::decode(point.otlp_metric.as_slice()).map_err(|_| "invalid metric")?;
    let observations = observations(&metric);
    if observations.len() != 1 {
        return Err("one observation required");
    }
    let observation = &observations[0];
    let exemplars = match observation {
        Observation::Number(v) => &v.exemplars,
        Observation::Histogram(v) => &v.exemplars,
        Observation::Exponential(v) => &v.exemplars,
        Observation::Summary(_) => &[][..],
    };
    let lineage = PointLineage {
        original: point.original,
        batch: point.batch.clone(),
        record_id: point.record_id.clone(),
        received_unix_nano: point.received_unix_nano,
        payload_kind: point.payload_kind,
        relationships: context.relationships.clone(),
        access: context.access.clone(),
    };
    let mut row = AnalyticalPoint {
        project_id: security.project_id.clone(),
        source_id: security.source_id.clone(),
        resource_id: reference.id.clone(),
        resource_kind: reference.kind,
        host_id: context.host_id.clone(),
        device_id: context.device_id.clone(),
        metric_name: point.metric_name.clone(),
        unit: point.unit.clone(),
        metric_kind: point
            .metric_kind
            .try_into()
            .map_err(|_| "metric kind overflow")?,
        sample_id: point.sample_id.clone(),
        stream_id: point.stream_id.clone(),
        time_unix_nano: point.time_unix_nano,
        start_time_unix_nano: point.start_time_unix_nano,
        event_day: point.event_day,
        continuity: point.continuity.clone(),
        flags: point.flags,
        int_value: point.int_value,
        double_value: point.double_value,
        resource_present: point.otlp_resource.is_some(),
        scope_present: point.otlp_scope.is_some(),
        scope_name: scope.name,
        scope_version: scope.version,
        resource_schema_url: point.resource_schema_url.clone(),
        scope_schema_url: point.scope_schema_url.clone(),
        resource_attributes: attributes(&resource.attributes)?,
        scope_attributes: attributes(&scope.attributes)?,
        point_attributes: attributes(observation.attributes())?,
        metric_metadata: attributes(&metric.metadata)?,
        description: metric.description.clone(),
        resource_dropped_attributes_count: resource.dropped_attributes_count,
        scope_dropped_attributes_count: scope.dropped_attributes_count,
        exemplars: exemplars.iter().map(Message::encode_to_vec).collect(),
        resource_entity_refs: resource
            .entity_refs
            .iter()
            .map(Message::encode_to_vec)
            .collect(),
        lineage: lineage.encode_to_vec(),
        ..Default::default()
    };
    match metric.data.as_ref().ok_or("missing metric data")? {
        Data::Gauge(_) => {}
        Data::Sum(v) => {
            row.temporality = v.aggregation_temporality;
            row.monotonic = Some(v.is_monotonic);
        }
        Data::Histogram(v) => {
            let p = &v.data_points[0];
            row.temporality = v.aggregation_temporality;
            row.count = Some(p.count);
            row.sum = p.sum;
            row.min = p.min;
            row.max = p.max;
            row.explicit_bounds = p.explicit_bounds.clone();
            row.bucket_counts = p.bucket_counts.clone();
        }
        Data::ExponentialHistogram(v) => {
            let p = &v.data_points[0];
            row.temporality = v.aggregation_temporality;
            row.count = Some(p.count);
            row.sum = p.sum;
            row.min = p.min;
            row.max = p.max;
            row.scale = Some(p.scale);
            row.zero_count = Some(p.zero_count);
            row.zero_threshold = Some(p.zero_threshold);
            if let Some(b) = &p.positive {
                row.positive_offset = Some(b.offset);
                row.positive_counts = b.bucket_counts.clone();
            }
            if let Some(b) = &p.negative {
                row.negative_offset = Some(b.offset);
                row.negative_counts = b.bucket_counts.clone();
            }
        }
        Data::Summary(v) => {
            let p = &v.data_points[0];
            row.count = Some(p.count);
            row.sum = Some(p.sum);
            row.quantiles = p.quantile_values.iter().map(|v| v.quantile).collect();
            row.quantile_values = p.quantile_values.iter().map(|v| v.value).collect();
        }
    }
    Ok(row)
}

// Kafka carries one bare message, consumed by ClickHouse ProtobufSingle.
pub fn serialize(row: &AnalyticalPoint) -> Vec<u8> {
    row.encode_to_vec()
}
pub fn encode(point: &NormalizedPoint) -> Result<Vec<u8>, &'static str> {
    Ok(serialize(&project(point)?))
}
