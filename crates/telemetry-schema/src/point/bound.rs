use super::{Observation, empty_metric, metric_shape, observation_iter, position};
use crate::{
    ExportMetricsServiceRequest,
    common::{AnyValue, KeyValue, any_value::Value},
    metrics::number_data_point::Value as Number,
    series::{POINT_MARKERS, RESOURCE_MARKERS, singleton_overhead_for_markers},
    wire::RawRecord,
};
use prost::{Message, encoding::encoded_len_varint, length_delimiter_len};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DeliveryBound {
    pub record_bytes: usize,
    pub batch_bytes: usize,
}

/// Admission checks the validated body against the authorized, position-ordered
/// bindings produced by ingestion. Retained replay accepts bindings in any order.
pub fn delivery_bound(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
) -> Result<DeliveryBound, &'static str> {
    if max_points == 0 || max_record_bytes == 0 || max_record_bytes > max_batch_bytes {
        return Err("positive coherent normalized bounds required");
    }
    let security = raw.security.as_ref().ok_or("missing trusted scope")?;
    if raw.bindings.len() != request.resource_metrics.len() {
        return Err("one binding per original resource required");
    }
    // AnalyticalPoint: security strings, 16-byte stream ID, raw coordinates
    // and the fixed part of the singleton packing allowance.
    let common = text(security.project_id.len(), 1)
        + text(security.source_id.len(), 1)
        + 18
        + 17
        + singleton_overhead_for_markers(0);
    let mut count = 0;
    let mut sum = 0usize;
    let mut largest = 0;
    let mut first = 0;
    let mut evidence = 0;
    for (r, (resource, binding)) in request
        .resource_metrics
        .iter()
        .zip(&raw.bindings)
        .enumerate()
    {
        if binding.original_resource as usize != r {
            return Err("resource bindings must follow original positions");
        }
        let context = binding.context.as_ref().ok_or("missing resource context")?;
        let reference = context
            .resource
            .as_ref()
            .ok_or("missing resource reference")?;
        let before_resource = count;
        let mut shared = text(reference.id.len(), 1)
            + if reference.kind == 0 {
                0
            } else {
                1 + encoded_len_varint(reference.kind as u64)
            }
            + context.host_id.as_ref().map_or(0, |s| field(s.len(), 1))
            + context.device_id.as_ref().map_or(0, |s| field(s.len(), 1))
            + text(resource.schema_url.len(), 2);
        if let Some(resource) = &resource.resource {
            // Presence and dropped-attribute count (UInt32).
            shared += 3
                + (7 * usize::from(resource.dropped_attributes_count != 0))
                + attributes(&resource.attributes, RESOURCE_MARKERS)?
                + repeated(&resource.entity_refs, 2);
        }
        for (s, scope) in resource.scope_metrics.iter().enumerate() {
            let before_scope = count;
            let mut scope_bytes = text(scope.schema_url.len(), 2);
            if let Some(scope) = &scope.scope {
                scope_bytes += 3
                    + text(scope.name.len(), 2)
                    + text(scope.version.len(), 2)
                    + (7 * usize::from(scope.dropped_attributes_count != 0))
                    + attributes(&scope.attributes, &[])?;
            }
            for (m, metric) in scope.metrics.iter().enumerate() {
                if empty_metric(metric) {
                    continue;
                }
                let (kind, temporality, _) = metric_shape(metric)?;
                let metric_bytes = text(metric.name.len(), 1)
                    + text(metric.unit.len(), 1)
                    + text(metric.description.len(), 2)
                    + 2
                    + if temporality == 0 {
                        0
                    } else {
                        2 + encoded_len_varint(temporality as u64)
                    }
                    + 3 * usize::from(kind == 2)
                    + attributes(&metric.metadata, &[])?;
                let before_metric = count;
                for (p, observation) in observation_iter(metric).enumerate() {
                    if count >= max_points {
                        return Err("normalized point limit");
                    }
                    let pos = position(r, s, m, p)?;
                    // Time and start, event day/flags (UInt32), and original position.
                    let leaf = 18
                        + 6
                        + 7 * usize::from(observation.flags() != 0)
                        + [pos.resource, pos.scope, pos.metric, pos.point]
                            .into_iter()
                            .map(|value| 7 * usize::from(value != 0))
                            .sum::<usize>()
                        + observation_bound(observation)?
                        + attributes(observation.attributes(), POINT_MARKERS)?;
                    let path = common + shared + scope_bytes + metric_bytes + leaf;
                    if path > max_record_bytes {
                        return Err("normalized record byte limit");
                    }
                    if count == 0 {
                        first = path;
                    }
                    largest = largest.max(path);
                    sum = charge(sum, leaf, 1, max_batch_bytes)?;
                    count += 1;
                }
                sum = charge(sum, metric_bytes, count - before_metric, max_batch_bytes)?;
            }
            sum = charge(sum, scope_bytes, count - before_scope, max_batch_bytes)?;
        }
        if count != before_resource {
            let index_bytes = if r == 0 {
                0
            } else {
                1 + encoded_len_varint(r as u64)
            };
            evidence += field(
                index_bytes
                    + repeated(&context.relationships, 1)
                    + context
                        .access
                        .as_ref()
                        .map_or(0, |access| field(access.encoded_len(), 1)),
                1,
            );
            sum = charge(sum, shared, count - before_resource, max_batch_bytes)?;
        }
    }
    if count != 0 {
        // PointLineage keeps the peer and inventory time. The connection
        // snapshot keeps a subset of the collector inventory; bound that
        // subset by the original bytes and the four fields made optional.
        let request = raw
            .batch
            .as_ref()
            .map_or(0, |batch| field(batch.encoded_len(), 1))
            + text(raw.record_id.len(), 1)
            + 11
            + raw.delivery.as_ref().map_or(0, |delivery| {
                evidence += field(
                    delivery
                        .collector
                        .as_ref()
                        .map_or(0, |c| c.encoded_len() + 8),
                    1,
                );
                field(
                    delivery
                        .ingestion_peer_address
                        .as_ref()
                        .map_or(0, |peer| field(peer.len(), 1))
                        + 11 * usize::from(delivery.collector.is_some()),
                    1,
                )
            });
        // Receipt, minimum and maximum event times, request/context bytes
        // and the fixed-length context hash, on the first point only.
        let extra = 30 + text(evidence, 2) + text(request, 2) + field(32, 2);
        largest = largest.max(first + extra);
        sum = charge(sum, common, count, max_batch_bytes)?;
        sum = sum.checked_add(extra).ok_or("normalized byte overflow")?;
        if largest > max_record_bytes || sum > max_batch_bytes {
            return Err("normalized delivery byte limit");
        }
    }
    Ok(DeliveryBound {
        record_bytes: largest,
        batch_bytes: sum,
    })
}

fn charge(sum: usize, bytes: usize, count: usize, limit: usize) -> Result<usize, &'static str> {
    let sum = bytes
        .checked_mul(count)
        .and_then(|bytes| sum.checked_add(bytes))
        .ok_or("normalized byte overflow")?;
    if sum > limit {
        Err("normalized batch byte limit")
    } else {
        Ok(sum)
    }
}

fn field(len: usize, tag_bytes: usize) -> usize {
    tag_bytes + length_delimiter_len(len) + len
}

fn text(len: usize, tag_bytes: usize) -> usize {
    if len == 0 { 0 } else { field(len, tag_bytes) }
}

fn repeated(values: &[impl Message], tag_bytes: usize) -> usize {
    values
        .iter()
        .map(|value| field(value.encoded_len(), tag_bytes))
        .sum()
}

fn observation_bound(observation: Observation<'_>) -> Result<usize, &'static str> {
    let packed = |len| text(8 * len, 2);
    let distribution = |sum: Option<f64>, min: Option<f64>, max: Option<f64>| {
        10 * (1
            + usize::from(sum.is_some())
            + usize::from(min.is_some())
            + usize::from(max.is_some()))
    };
    let (bytes, exemplars) = match observation {
        Observation::Number(p) => (
            match p.value {
                Some(Number::AsInt(_)) => 12,
                Some(Number::AsDouble(v)) if v.is_finite() => 10,
                Some(Number::AsDouble(_)) => return Err("nonfinite value"),
                None => 0,
            },
            p.exemplars.as_slice(),
        ),
        Observation::Histogram(p) => (
            distribution(p.sum, p.min, p.max)
                + packed(p.explicit_bounds.len())
                + packed(p.bucket_counts.len()),
            p.exemplars.as_slice(),
        ),
        Observation::Exponential(p) => (
            distribution(p.sum, p.min, p.max)
                + 27
                + p.positive
                    .as_ref()
                    .map_or(0, |b| 7 + packed(b.bucket_counts.len()))
                + p.negative
                    .as_ref()
                    .map_or(0, |b| 7 + packed(b.bucket_counts.len())),
            p.exemplars.as_slice(),
        ),
        Observation::Summary(p) => (20 + 2 * packed(p.quantile_values.len()), &[][..]),
    };
    Ok(bytes + repeated(exemplars, 2))
}

fn attributes(attrs: &[KeyValue], markers: &[&str]) -> Result<usize, &'static str> {
    attribute_map(attrs, 0, 0, false, markers)
}

fn attribute_map(
    attrs: &[KeyValue],
    path: usize,
    depth: usize,
    marker: bool,
    markers: &[&str],
) -> Result<usize, &'static str> {
    let mut sum = 0;
    for (i, kv) in attrs.iter().enumerate() {
        if kv.key_strindex != 0 {
            return Err("dictionary keys are not admitted for metrics");
        }
        if kv.key.is_empty() {
            return Err("empty attribute key");
        }
        if attrs[..i].iter().any(|other| other.key == kv.key) {
            return Err("duplicate attribute key");
        }
        let path =
            path + 1 + kv.key.len() + kv.key.bytes().filter(|b| matches!(b, b'/' | b'~')).count();
        sum += attribute(
            kv.value.as_ref(),
            path,
            depth,
            marker || markers.contains(&kv.key.as_str()),
        )?;
    }
    Ok(sum)
}

fn attribute(
    value: Option<&AnyValue>,
    path: usize,
    depth: usize,
    marker: bool,
) -> Result<usize, &'static str> {
    if depth > 16 {
        return Err("attribute nesting limit");
    }
    let (payload, descendants) = match value.and_then(|v| v.value.as_ref()) {
        None => (0, 0),
        Some(Value::StringValue(v)) => (field(v.len(), 1), 0),
        Some(Value::BytesValue(v)) => (field(v.len(), 1), 0),
        Some(Value::BoolValue(_)) => (2, 0),
        Some(Value::IntValue(v)) => (1 + encoded_len_varint(((v << 1) ^ (v >> 63)) as u64), 0),
        Some(Value::DoubleValue(v)) if v.is_finite() => (9, 0),
        Some(Value::DoubleValue(_)) => return Err("nonfinite attribute"),
        Some(Value::StringValueStrindex(_)) => {
            return Err("dictionary strings are not admitted for metrics");
        }
        Some(Value::KvlistValue(v)) => (0, attribute_map(&v.values, path, depth + 1, marker, &[])?),
        Some(Value::ArrayValue(v)) => {
            let mut sum = 0;
            for (i, child) in v.values.iter().enumerate() {
                let child_path = path + 2 + i.checked_ilog10().unwrap_or(0) as usize;
                sum += attribute(Some(child), child_path, depth + 1, marker)?;
            }
            (0, sum)
        }
    };
    // Keep exact widths for repeated nodes so slack doesn't multiply with
    // attribute fanout. A tagged continuity node has a fixed packing allowance.
    Ok(field(
        field(path, 1) + 2 * usize::from(value.is_some()) + payload,
        2,
    ) + (singleton_overhead_for_markers(usize::from(marker))
        - singleton_overhead_for_markers(0))
        + descendants)
}
