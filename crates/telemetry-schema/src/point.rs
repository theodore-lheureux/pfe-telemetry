use crate::{
    ExportMetricsServiceRequest,
    common::{KeyValue, any_value::Value as AttributeValue},
    identity::{self, TypedHash},
    metrics::{self, Metric, metric::Data, number_data_point::Value},
    projection,
    wire::{
        AnalyticalPoint, DeliveryContext, DeliveryObservation, PointLineage, Position, RawRecord,
    },
};
use prost::Message;

#[derive(Clone, Copy)]
pub enum Observation<'a> {
    Number(&'a metrics::NumberDataPoint),
    Histogram(&'a metrics::HistogramDataPoint),
    Exponential(&'a metrics::ExponentialHistogramDataPoint),
    Summary(&'a metrics::SummaryDataPoint),
}
impl Observation<'_> {
    pub fn attributes(&self) -> &[KeyValue] {
        match self {
            Self::Number(p) => &p.attributes,
            Self::Histogram(p) => &p.attributes,
            Self::Exponential(p) => &p.attributes,
            Self::Summary(p) => &p.attributes,
        }
    }
    pub fn time(&self) -> u64 {
        match self {
            Self::Number(p) => p.time_unix_nano,
            Self::Histogram(p) => p.time_unix_nano,
            Self::Exponential(p) => p.time_unix_nano,
            Self::Summary(p) => p.time_unix_nano,
        }
    }
    pub fn start(&self) -> u64 {
        match self {
            Self::Number(p) => p.start_time_unix_nano,
            Self::Histogram(p) => p.start_time_unix_nano,
            Self::Exponential(p) => p.start_time_unix_nano,
            Self::Summary(p) => p.start_time_unix_nano,
        }
    }
    pub fn flags(&self) -> u32 {
        match self {
            Self::Number(p) => p.flags,
            Self::Histogram(p) => p.flags,
            Self::Exponential(p) => p.flags,
            Self::Summary(p) => p.flags,
        }
    }
}
pub fn observations(metric: &Metric) -> Vec<Observation<'_>> {
    match &metric.data {
        Some(Data::Gauge(v)) => v.data_points.iter().map(Observation::Number).collect(),
        Some(Data::Sum(v)) => v.data_points.iter().map(Observation::Number).collect(),
        Some(Data::Histogram(v)) => v.data_points.iter().map(Observation::Histogram).collect(),
        Some(Data::ExponentialHistogram(v)) => {
            v.data_points.iter().map(Observation::Exponential).collect()
        }
        Some(Data::Summary(v)) => v.data_points.iter().map(Observation::Summary).collect(),
        None => Vec::new(),
    }
}
fn empty_metric(metric: &Metric) -> bool {
    match &metric.data {
        Some(Data::Gauge(v)) => v.data_points.is_empty(),
        Some(Data::Sum(v)) => v.data_points.is_empty(),
        Some(Data::Histogram(v)) => v.data_points.is_empty(),
        Some(Data::ExponentialHistogram(v)) => v.data_points.is_empty(),
        Some(Data::Summary(v)) => v.data_points.is_empty(),
        None => false,
    }
}

pub fn string_attribute<'a>(attrs: &'a [KeyValue], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match &v.value {
            Some(AttributeValue::StringValue(v)) => Some(v.as_str()),
            _ => None,
        })
}

fn delivery_context(value: &DeliveryObservation) -> DeliveryContext {
    let mut context = DeliveryContext {
        ingestion_peer_address: value.ingestion_peer_address.clone(),
        ..Default::default()
    };
    if let Some(collector) = &value.collector {
        context.collector_connection_id = Some(collector.connection_id.clone());
        context.collector_connected_unix_nano = Some(collector.connected_unix_nano);
        context.collector_local_address = Some(collector.local_address.clone());
        context.collector_peer_address = Some(collector.peer_address.clone());
        context.inventory_observed_unix_nano = Some(collector.inventory_observed_unix_nano);
        context.collector_hostname = collector.hostname.clone();
        let local = collector
            .local_address
            .parse::<std::net::SocketAddr>()
            .ok()
            .map(|a| a.ip());
        context.local_interfaces = collector
            .interfaces
            .iter()
            .filter(|i| collector.local_interface_names.contains(&i.name))
            .map(|i| {
                let mut interface = i.clone();
                interface
                    .addresses
                    .retain(|a| a.parse::<std::net::IpAddr>().ok() == local);
                interface
            })
            .collect();
    }
    context
}

// Call only after whole-request semantic validation and resource authorization;
// consumers must validate again after decoding a retained trust boundary.
// `request` must be the unchanged decoded body represented by this raw record.
pub fn normalize_bounded(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
) -> Result<Vec<AnalyticalPoint>, &'static str> {
    if max_points == 0 || max_record_bytes == 0 || max_record_bytes > max_batch_bytes {
        return Err("positive coherent normalized bounds required");
    }
    let security = raw.security.as_ref().ok_or("missing trusted scope")?;
    if raw.bindings.len() != request.resource_metrics.len() {
        return Err("one binding per original resource required");
    }
    // The validated request's container budget bounds this index. Array order
    // is not authority: bindings are keyed by their original resource position.
    let mut contexts = vec![None; raw.bindings.len()];
    for binding in &raw.bindings {
        let slot = contexts
            .get_mut(binding.original_resource as usize)
            .ok_or("resource binding position out of range")?;
        let context = binding.context.as_ref().ok_or("missing resource context")?;
        if slot.replace(context).is_some() {
            return Err("duplicate resource binding position");
        }
    }
    let mut out = Vec::new();
    let mut bytes = 0usize;
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
        let resource_attrs = projection::PreparedAttributes::new(
            resource.resource.as_ref().map_or(&[], |r| &r.attributes),
        )?;
        let mut resource_hash = TypedHash::new("recount.stream");
        identity::security(&mut resource_hash, security);
        resource_hash.field(reference.id.as_bytes());
        resource_hash.u64(reference.kind as u64);
        resource_hash.field(&resource_attrs.canonical);
        resource_hash.field(resource.schema_url.as_bytes());
        let resource_row = AnalyticalPoint {
            project_id: security.project_id.clone(),
            source_id: security.source_id.clone(),
            resource_id: reference.id.clone(),
            resource_kind: reference.kind,
            host_id: context.host_id.clone(),
            device_id: context.device_id.clone(),
            resource_present: resource.resource.is_some(),
            resource_schema_url: resource.schema_url.clone(),
            resource_attributes: resource_attrs.nodes,
            resource_dropped_attributes_count: resource
                .resource
                .as_ref()
                .map_or(0, |r| r.dropped_attributes_count),
            resource_entity_refs: resource.resource.as_ref().map_or_else(Vec::new, |r| {
                r.entity_refs.iter().map(Message::encode_to_vec).collect()
            }),
            ..Default::default()
        };
        let lineage = PointLineage {
            batch: raw.batch.clone(),
            record_id: raw.record_id.clone(),
            received_unix_nano: raw.received_unix_nano,
            payload_kind: raw.payload_kind,
            relationships: context.relationships.clone(),
            access: context.access.clone(),
            delivery: raw.delivery.as_ref().map(delivery_context),
            ..Default::default()
        };
        for (s, scope) in resource.scope_metrics.iter().enumerate() {
            if scope.metrics.iter().all(empty_metric) {
                continue;
            }
            let scope_attrs = projection::PreparedAttributes::new(
                scope.scope.as_ref().map_or(&[], |s| &s.attributes),
            )?;
            let mut scope_hash = resource_hash.clone();
            scope_hash.field(scope.schema_url.as_bytes());
            scope_hash.field(
                scope
                    .scope
                    .as_ref()
                    .map_or("", |s| s.name.as_str())
                    .as_bytes(),
            );
            scope_hash.field(
                scope
                    .scope
                    .as_ref()
                    .map_or("", |s| s.version.as_str())
                    .as_bytes(),
            );
            scope_hash.field(&scope_attrs.canonical);
            let scope_row = AnalyticalPoint {
                scope_present: scope.scope.is_some(),
                scope_name: scope
                    .scope
                    .as_ref()
                    .map_or_else(String::new, |s| s.name.clone()),
                scope_version: scope
                    .scope
                    .as_ref()
                    .map_or_else(String::new, |s| s.version.clone()),
                scope_schema_url: scope.schema_url.clone(),
                scope_attributes: scope_attrs.nodes,
                scope_dropped_attributes_count: scope
                    .scope
                    .as_ref()
                    .map_or(0, |s| s.dropped_attributes_count),
                ..resource_row.clone()
            };
            for (m, metric) in scope.metrics.iter().enumerate() {
                if empty_metric(metric) {
                    continue;
                }
                let (kind, temporality, monotonic) = match &metric.data {
                    Some(Data::Gauge(_)) => (1, 0, false),
                    Some(Data::Sum(v)) => (2, v.aggregation_temporality, v.is_monotonic),
                    Some(Data::Histogram(v)) => (3, v.aggregation_temporality, false),
                    Some(Data::ExponentialHistogram(v)) => (4, v.aggregation_temporality, false),
                    Some(Data::Summary(_)) => (5, 0, false),
                    None => return Err("missing metric data"),
                };
                let mut metric_hash = scope_hash.clone();
                metric_hash.field(metric.name.as_bytes());
                metric_hash.field(metric.unit.as_bytes());
                metric_hash.u64(kind as u64);
                metric_hash.u64(temporality as u64);
                metric_hash.u64(u64::from(monotonic));
                let metric_row = AnalyticalPoint {
                    metric_name: metric.name.clone(),
                    unit: metric.unit.clone(),
                    description: metric.description.clone(),
                    metric_metadata: projection::attributes(&metric.metadata)?,
                    metric_kind: kind,
                    temporality,
                    monotonic: (kind == 2).then_some(monotonic),
                    ..scope_row.clone()
                };
                for (p, observation) in observations(metric).into_iter().enumerate() {
                    if out.len() >= max_points {
                        return Err("normalized point limit");
                    }
                    let original = Position {
                        resource: r.try_into().map_err(|_| "position overflow")?,
                        scope: s.try_into().map_err(|_| "position overflow")?,
                        metric: m.try_into().map_err(|_| "position overflow")?,
                        point: p.try_into().map_err(|_| "position overflow")?,
                    };
                    let attrs = projection::PreparedAttributes::new(observation.attributes())?;
                    let mut h = metric_hash.clone();
                    h.field(&attrs.canonical);
                    h.u64(observation.start());
                    let mut row = AnalyticalPoint {
                        sample_id: identity::sample_id(raw, &original)?.to_vec(),
                        stream_id: h.finish().to_vec(),
                        time_unix_nano: observation.time(),
                        start_time_unix_nano: observation.start(),
                        continuity: string_attribute(
                            observation.attributes(),
                            "recount.counter.segment_id",
                        )
                        .map(str::to_owned),
                        flags: observation.flags(),
                        event_day: (observation.time() / 86_400_000_000_000) as u32,
                        point_attributes: attrs.nodes,
                        lineage: PointLineage {
                            original: Some(original),
                            ..lineage.clone()
                        }
                        .encode_to_vec(),
                        ..metric_row.clone()
                    };
                    lower_observation(&mut row, observation)?;
                    let size = row.encoded_len();
                    if size > max_record_bytes {
                        return Err("normalized record byte limit");
                    }
                    bytes = bytes.checked_add(size).ok_or("normalized byte overflow")?;
                    if bytes > max_batch_bytes {
                        return Err("normalized batch byte limit");
                    }
                    out.push(row);
                }
            }
        }
    }
    Ok(out)
}

fn lower_observation(
    row: &mut AnalyticalPoint,
    observation: Observation<'_>,
) -> Result<(), &'static str> {
    let exemplars = match observation {
        Observation::Number(p) => {
            match p.value {
                Some(Value::AsInt(v)) => row.int_value = Some(v),
                Some(Value::AsDouble(v)) if v.is_finite() => row.double_value = Some(v),
                Some(Value::AsDouble(_)) => return Err("nonfinite value"),
                None => {}
            }
            &p.exemplars
        }
        Observation::Histogram(p) => {
            row.count = Some(p.count);
            row.sum = p.sum;
            row.min = p.min;
            row.max = p.max;
            row.explicit_bounds = p.explicit_bounds.clone();
            row.bucket_counts = p.bucket_counts.clone();
            &p.exemplars
        }
        Observation::Exponential(p) => {
            row.count = Some(p.count);
            row.sum = p.sum;
            row.min = p.min;
            row.max = p.max;
            row.scale = Some(p.scale);
            row.zero_count = Some(p.zero_count);
            row.zero_threshold = Some(otlp_scalar_default(p.zero_threshold));
            if let Some(b) = &p.positive {
                row.positive_offset = Some(b.offset);
                row.positive_counts = b.bucket_counts.clone();
            }
            if let Some(b) = &p.negative {
                row.negative_offset = Some(b.offset);
                row.negative_counts = b.bucket_counts.clone();
            }
            &p.exemplars
        }
        Observation::Summary(p) => {
            row.count = Some(p.count);
            row.sum = Some(otlp_scalar_default(p.sum));
            row.quantiles = p
                .quantile_values
                .iter()
                .map(|v| otlp_scalar_default(v.quantile))
                .collect();
            row.quantile_values = p
                .quantile_values
                .iter()
                .map(|v| otlp_scalar_default(v.value))
                .collect();
            &[][..]
        }
    };
    row.exemplars = exemplars.iter().map(Message::encode_to_vec).collect();
    Ok(())
}

// Non-optional OTLP floats re-encode either signed zero as the Protobuf +0
// default. Admission must agree with retained replay without re-encoding points.
fn otlp_scalar_default(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value }
}

pub fn normalized_routing_key(point: &AnalyticalPoint) -> Result<[u8; 32], &'static str> {
    point
        .stream_id
        .as_slice()
        .try_into()
        .map_err(|_| "invalid stream identity")
}

#[derive(Debug)]
pub struct RoutedRecord {
    pub partition: u32,
    pub payload: Vec<u8>,
}

pub fn kafka_records(
    points: &[AnalyticalPoint],
    partitions: u32,
    max_bytes: usize,
) -> Result<Vec<RoutedRecord>, &'static str> {
    if partitions == 0 || max_bytes == 0 {
        return Err("positive record bounds required");
    }
    let mut records = Vec::new();
    for point in points {
        let partition = identity::partition(&normalized_routing_key(point)?, partitions)
            .ok_or("partition count")?;
        let row = projection::serialize(point);
        if row.len() > max_bytes {
            return Err("row exceeds record bytes");
        }
        records.push(RoutedRecord {
            partition,
            payload: row,
        });
    }
    Ok(records)
}
