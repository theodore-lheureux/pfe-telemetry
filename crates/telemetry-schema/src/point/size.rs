use super::{
    Observation, binding_contexts, delivery_address_matches, delivery_interfaces, empty_metric,
    metric_shape, observation_iter, position,
};
use crate::{
    ExportMetricsServiceRequest,
    common::{AnyValue, KeyValue, any_value::Value},
    identity::check_projected_attributes,
    metrics::number_data_point,
    series::{POINT_MARKERS, RESOURCE_MARKERS, receipt_tag, singleton_overhead_for_markers},
    wire::{DeliveryObservation, RawRecord},
};
use prost::{
    Message,
    encoding::{encoded_len_varint, key_len},
    length_delimiter_len,
};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DeliverySize {
    /// Largest singleton size including its packing allowance and, on the first point, evidence.
    pub record_bytes: usize,
    /// Total admission budget, including the delivery-evidence allowance.
    pub batch_bytes: usize,
}

pub(super) struct Budget {
    record_limit: usize,
    batch_limit: usize,
    first: Option<usize>,
    largest: usize,
    bytes: usize,
}

impl Budget {
    pub(super) fn new(record_limit: usize, batch_limit: usize) -> Self {
        Self {
            record_limit,
            batch_limit,
            first: None,
            largest: 0,
            bytes: 0,
        }
    }

    pub(super) fn point(&mut self, size: usize) -> Result<(), &'static str> {
        if size > self.record_limit {
            return Err("normalized record byte limit");
        }
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or("normalized byte overflow")?;
        if self.bytes > self.batch_limit {
            return Err("normalized batch byte limit");
        }
        self.first.get_or_insert(size);
        self.largest = self.largest.max(size);
        Ok(())
    }

    pub(super) fn delivery(&mut self, evidence: usize) -> Result<(), &'static str> {
        if let Some(first) = self.first {
            self.largest = self.largest.max(first + bytes(62, evidence));
            self.bytes = self
                .bytes
                .checked_add(evidence + 8)
                .ok_or("normalized byte overflow")?;
            if self.largest > self.record_limit || self.bytes > self.batch_limit {
                return Err("normalized delivery byte limit");
            }
        }
        Ok(())
    }
}

// Size the same compact singleton projection as normalize_delivery, in projection
// order. Field numbers and default/presence rules are from recount.proto; the
// parity test compares these formulas against the generated Prost messages.
pub fn delivery_size(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
) -> Result<DeliverySize, &'static str> {
    if max_points == 0 || max_record_bytes == 0 || max_record_bytes > max_batch_bytes {
        return Err("positive coherent normalized bounds required");
    }
    let security = raw.security.as_ref().ok_or("missing trusted scope")?;
    let contexts = binding_contexts(raw, request)?;
    let mut budget = Budget::new(max_record_bytes, max_batch_bytes);
    let mut scratch = Vec::new();
    let common = bytes(1, security.project_id.len())
        + bytes(2, security.source_id.len())
        + delimited(11, 32) // Stream hashes always have the same length.
        + fixed64(60, raw.received_unix_nano != 0)
        // The hash is needed once: a zero receipt tag is omitted by Prost.
        + (key_len(61) + 4) * usize::from(receipt_tag(&raw.record_id) != 0);
    let mut evidence = delimited(
        1,
        message(2, raw.batch.as_ref())
            + bytes(3, raw.record_id.len())
            + fixed64(4, raw.received_unix_nano != 0)
            + scalar(5, raw.payload_kind as u64)
            + raw
                .delivery
                .as_ref()
                .map_or(0, |d| delimited(8, delivery_context_size(d))),
    );
    let mut count = 0;
    for (r, resource) in request.resource_metrics.iter().enumerate() {
        if resource
            .scope_metrics
            .iter()
            .all(|s| s.metrics.iter().all(empty_metric))
        {
            continue;
        }
        let context = contexts[r].ok_or("missing authorized resource binding")?;
        let reference = context
            .resource
            .as_ref()
            .ok_or("missing resource reference")?;
        let resource_attrs = resource
            .resource
            .as_ref()
            .map_or(&[][..], |r| &r.attributes);
        check_projected_attributes(resource_attrs, &mut scratch)?;
        let (attrs, resource_markers) = attributes_size::<25>(resource_attrs, RESOURCE_MARKERS);
        let mut base = common
            + bytes(3, reference.id.len())
            + scalar(4, reference.kind as u64)
            + optional_str(5, context.host_id.as_deref())
            + optional_str(6, context.device_id.as_deref())
            + bytes(23, resource.schema_url.len())
            + attrs;
        if let Some(resource) = &resource.resource {
            base += scalar(19, 1)
                + scalar(47, resource.dropped_attributes_count.into())
                + repeated_messages(50, &resource.entity_refs);
        }
        let resource_index = position(r, 0, 0, 0)?.resource;
        evidence += delimited(
            2,
            scalar(1, resource_index.into())
                + repeated_messages(2, &context.relationships)
                + message(3, context.access.as_ref()),
        );
        for (s, scope) in resource.scope_metrics.iter().enumerate() {
            let mut scope_size = None;
            for (m, metric) in scope.metrics.iter().enumerate() {
                if empty_metric(metric) {
                    continue;
                }
                let (kind, temporality, monotonic) = metric_shape(metric)?;
                let scope_size = match scope_size {
                    Some(size) => size,
                    None => {
                        let mut size = base + bytes(24, scope.schema_url.len());
                        if let Some(scope) = &scope.scope {
                            check_projected_attributes(&scope.attributes, &mut scratch)?;
                            size += scalar(20, 1)
                                + bytes(21, scope.name.len())
                                + bytes(22, scope.version.len())
                                + attributes_size::<26>(&scope.attributes, &[]).0
                                + scalar(48, scope.dropped_attributes_count.into());
                        }
                        scope_size = Some(size);
                        size
                    }
                };
                check_projected_attributes(&metric.metadata, &mut scratch)?;
                let metric_size = scope_size
                    + bytes(7, metric.name.len())
                    + bytes(8, metric.unit.len())
                    + scalar(9, kind as u64)
                    + attributes_size::<28>(&metric.metadata, &[]).0
                    + scalar(29, temporality as u64)
                    + optional_varint(30, (kind == 2).then_some(u64::from(monotonic)))
                    + bytes(46, metric.description.len());
                for (p, observation) in observation_iter(metric).enumerate() {
                    if count >= max_points {
                        return Err("normalized point limit");
                    }
                    let pos = position(r, s, m, p)?;
                    check_projected_attributes(observation.attributes(), &mut scratch)?;
                    let (attrs, point_markers) =
                        attributes_size::<27>(observation.attributes(), POINT_MARKERS);
                    let size = metric_size
                        + attrs
                        + fixed64(12, observation.time() != 0)
                        + fixed64(13, observation.start() != 0)
                        + scalar(
                            14,
                            u64::from((observation.time() / 86_400_000_000_000) as u32),
                        )
                        + scalar(16, observation.flags().into())
                        + bytes(59, pos.encoded_len())
                        + observation_size(observation)?
                        + singleton_overhead_for_markers(resource_markers + point_markers);
                    budget.point(size)?;
                    count += 1;
                }
            }
        }
    }
    budget.delivery(evidence)?;
    Ok(DeliverySize {
        record_bytes: budget.largest,
        batch_bytes: budget.bytes,
    })
}

fn delimited(tag: u32, len: usize) -> usize {
    key_len(tag) + length_delimiter_len(len) + len
}

fn bytes(tag: u32, len: usize) -> usize {
    if len == 0 { 0 } else { delimited(tag, len) }
}

fn optional_str(tag: u32, value: Option<&str>) -> usize {
    value.map_or(0, |s| delimited(tag, s.len()))
}

fn optional_varint(tag: u32, value: Option<u64>) -> usize {
    value.map_or(0, |v| key_len(tag) + encoded_len_varint(v))
}

fn scalar(tag: u32, value: u64) -> usize {
    optional_varint(tag, (value != 0).then_some(value))
}

fn fixed64(tag: u32, present: bool) -> usize {
    (key_len(tag) + 8) * usize::from(present)
}

fn packed64(tag: u32, count: usize) -> usize {
    bytes(tag, count * 8)
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

fn message(tag: u32, value: Option<&impl Message>) -> usize {
    value.map_or(0, |v| delimited(tag, v.encoded_len()))
}

fn repeated_messages(tag: u32, values: &[impl Message]) -> usize {
    values.iter().map(|v| delimited(tag, v.encoded_len())).sum()
}

fn delivery_context_size(delivery: &DeliveryObservation) -> usize {
    let mut size = optional_str(8, delivery.ingestion_peer_address.as_deref());
    if let Some(c) = &delivery.collector {
        size += delimited(1, c.connection_id.len())
            + optional_varint(2, Some(c.connected_unix_nano))
            + delimited(3, c.local_address.len())
            + delimited(4, c.peer_address.len())
            + optional_varint(5, Some(c.inventory_observed_unix_nano))
            + optional_str(6, c.hostname.as_deref());
        for (interface, local) in delivery_interfaces(c) {
            size += delimited(
                7,
                bytes(1, interface.name.len())
                    + optional_str(2, interface.mac_address.as_deref())
                    + interface
                        .addresses
                        .iter()
                        .filter(|a| delivery_address_matches(a, local))
                        .map(|a| delimited(3, a.len()))
                        .sum::<usize>()
                    + scalar(4, interface.up.into())
                    + scalar(5, interface.loopback.into()),
            );
        }
    }
    size
}

fn observation_size(observation: Observation<'_>) -> Result<usize, &'static str> {
    let (size, exemplars) = match observation {
        Observation::Number(p) => {
            let size = match p.value {
                Some(number_data_point::Value::AsInt(v)) => optional_varint(17, Some(zigzag(v))),
                Some(number_data_point::Value::AsDouble(v)) if v.is_finite() => fixed64(18, true),
                Some(number_data_point::Value::AsDouble(_)) => return Err("nonfinite value"),
                None => 0,
            };
            (size, p.exemplars.as_slice())
        }
        Observation::Histogram(p) => (
            distribution_size(p.sum, p.min, p.max)
                + packed64(35, p.explicit_bounds.len())
                + packed64(36, p.bucket_counts.len()),
            p.exemplars.as_slice(),
        ),
        Observation::Exponential(p) => (
            distribution_size(p.sum, p.min, p.max)
                + optional_varint(37, Some(zigzag(p.scale.into())))
                + fixed64(38, true)
                + fixed64(39, true)
                + p.positive.as_ref().map_or(0, |b| {
                    optional_varint(40, Some(zigzag(b.offset.into())))
                        + packed64(41, b.bucket_counts.len())
                })
                + p.negative.as_ref().map_or(0, |b| {
                    optional_varint(42, Some(zigzag(b.offset.into())))
                        + packed64(43, b.bucket_counts.len())
                }),
            p.exemplars.as_slice(),
        ),
        Observation::Summary(p) => (
            fixed64(31, true)
                + fixed64(32, true)
                + packed64(44, p.quantile_values.len())
                + packed64(45, p.quantile_values.len()),
            &[][..],
        ),
    };
    Ok(size + repeated_messages(49, exemplars))
}

fn distribution_size(sum: Option<f64>, min: Option<f64>, max: Option<f64>) -> usize {
    fixed64(31, true)
        + fixed64(32, sum.is_some())
        + fixed64(33, min.is_some())
        + fixed64(34, max.is_some())
}

fn key_path_len(key: &str) -> usize {
    1 + key.len() + key.bytes().filter(|b| matches!(b, b'/' | b'~')).count()
}

fn attributes_size<const TAG: u32>(attrs: &[KeyValue], markers: &[&str]) -> (usize, usize) {
    let mut size = 0;
    let mut marker_count = 0;
    for kv in attrs {
        attribute_size::<TAG>(
            kv.value.as_ref(),
            key_path_len(&kv.key),
            markers.contains(&kv.key.as_str()),
            &mut size,
            &mut marker_count,
        );
    }
    (size, marker_count)
}

fn attribute_size<const TAG: u32>(
    value: Option<&AnyValue>,
    path_len: usize,
    marker: bool,
    size: &mut usize,
    marker_count: &mut usize,
) {
    // A validated, present AnyValue always sets a nonzero one-byte kind.
    let value_size = match value.map(|v| v.value.as_ref()) {
        None | Some(None) => 0,
        Some(Some(Value::StringValue(v))) => delimited(3, v.len()),
        Some(Some(Value::IntValue(v))) => optional_varint(4, Some(zigzag(*v))),
        Some(Some(Value::DoubleValue(_))) => fixed64(5, true),
        Some(Some(Value::BoolValue(_))) => scalar(6, 1),
        Some(Some(Value::BytesValue(v))) => delimited(7, v.len()),
        Some(Some(Value::ArrayValue(v))) => {
            for (i, child) in v.values.iter().enumerate() {
                attribute_size::<TAG>(
                    Some(child),
                    path_len + 2 + i.checked_ilog10().unwrap_or(0) as usize,
                    marker,
                    size,
                    marker_count,
                );
            }
            0
        }
        Some(Some(Value::KvlistValue(v))) => {
            for kv in &v.values {
                attribute_size::<TAG>(
                    kv.value.as_ref(),
                    path_len + key_path_len(&kv.key),
                    marker,
                    size,
                    marker_count,
                );
            }
            0
        }
        Some(Some(Value::StringValueStrindex(_))) => unreachable!("validated metric attributes"),
    };
    *size += delimited(
        TAG,
        delimited(1, path_len) + scalar(2, value.is_some().into()) + value_size,
    );
    *marker_count += usize::from(marker);
}
