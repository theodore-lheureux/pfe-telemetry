use crate::metrics::{ResourceMetrics, ScopeMetrics};
use crate::{
    ExportMetricsServiceRequest,
    common::{KeyValue, any_value::Value as AttributeValue},
    identity::{self, TypedHash},
    identity_cache::{self, IdentityCache},
    metrics::{self, Metric, metric::Data, number_data_point::Value},
    projection,
    series::{PreparedPoint, ResourceAttributes, SeriesMetadata},
    wire::{
        AnalyticalPoint, DeliveryContext, DeliveryObservation, PointLineage, Position, RawRecord,
        ResourceContext, SecurityScope,
    },
};
use prost::Message;
use std::sync::Arc;

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
    lower(
        raw,
        request,
        [max_points, max_record_bytes, max_batch_bytes],
        false,
        None,
    )
    .map(|points| points.into_iter().map(|point| point.frame).collect())
}

pub fn normalize_delivery(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
) -> Result<Vec<AnalyticalPoint>, &'static str> {
    lower(
        raw,
        request,
        [max_points, max_record_bytes, max_batch_bytes],
        true,
        None,
    )
    .map(|points| points.into_iter().map(|point| point.frame).collect())
}

pub fn normalize_cached_delivery(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
    cache: &IdentityCache,
) -> Result<Vec<PreparedPoint>, &'static str> {
    lower(
        raw,
        request,
        [max_points, max_record_bytes, max_batch_bytes],
        true,
        Some(cache),
    )
}

fn lower(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    [max_points, max_record_bytes, max_batch_bytes]: [usize; 3],
    compact: bool,
    cache: Option<&IdentityCache>,
) -> Result<Vec<PreparedPoint>, &'static str> {
    if max_points == 0 || max_record_bytes == 0 || max_record_bytes > max_batch_bytes {
        return Err("positive coherent normalized bounds required");
    }
    let security = raw.security.as_ref().ok_or("missing trusted scope")?;
    let mut request_lineage = PointLineage {
        batch: raw.batch.clone(),
        record_id: raw.record_id.clone(),
        received_unix_nano: raw.received_unix_nano,
        payload_kind: raw.payload_kind,
        delivery: raw.delivery.as_ref().map(delivery_context),
        ..Default::default()
    };
    let mut context_evidence = crate::wire::DeliveryContextEvidence {
        connection: None,
        resources: Vec::new(),
    };
    let (mut min_event, mut max_event) = (u64::MAX, 0);
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
    let mut first_size = 0usize;
    let mut resource_key = Vec::new();
    let mut series_key = Vec::new();
    for (r, resource_metrics) in request.resource_metrics.iter().enumerate() {
        if resource_metrics
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
        let resource = if let Some(cache) = cache {
            resource_key.clear();
            key_field(&mut resource_key, security.project_id.as_bytes());
            key_field(&mut resource_key, security.source_id.as_bytes());
            key_field(&mut resource_key, reference.id.as_bytes());
            resource_key.extend_from_slice(&reference.kind.to_le_bytes());
            key_optional_str(&mut resource_key, context.host_id.as_deref());
            key_optional_str(&mut resource_key, context.device_id.as_deref());
            key_field(&mut resource_key, resource_metrics.schema_url.as_bytes());
            key_message(&mut resource_key, resource_metrics.resource.as_ref());
            cache.resources.get_or_try_insert(&resource_key, || {
                let mut value = project_resource(resource_metrics, security, context)?;
                value.token = cache.next_resource_token();
                let split = ResourceAttributes::new(
                    value.row.resource_attributes.clone(),
                    value.row.resource_entity_refs.clone(),
                );
                let bytes = identity_cache::row_heap_bytes(&value.row) + split.heap_bytes();
                value.split = Some(Arc::new(split));
                Ok((value, bytes))
            })?
        } else {
            Arc::new(project_resource(resource_metrics, security, context)?)
        };
        let lineage = if compact {
            context_evidence
                .resources
                .push(crate::wire::DeliveryResource {
                    resource: r.try_into().map_err(|_| "position overflow")?,
                    relationships: context.relationships.clone(),
                    access: context.access.clone(),
                });
            None
        } else {
            Some(PointLineage {
                relationships: context.relationships.clone(),
                access: context.access.clone(),
                ..request_lineage.clone()
            })
        };
        for (s, scope) in resource_metrics.scope_metrics.iter().enumerate() {
            if scope.metrics.iter().all(empty_metric) {
                continue;
            }
            let mut projected_scope = None;
            if cache.is_some() {
                series_key.clear();
                series_key.extend_from_slice(&resource.token.to_le_bytes());
                key_field(&mut series_key, scope.schema_url.as_bytes());
                key_message(&mut series_key, scope.scope.as_ref());
            }
            let scope_key_len = series_key.len();
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
                let mut projected_metric = None;
                let mut metric_projection = || {
                    if projected_scope.is_none() {
                        projected_scope = Some(project_scope(&resource, scope)?);
                    }
                    project_metric(
                        projected_scope.as_ref().unwrap(),
                        metric,
                        kind,
                        temporality,
                        monotonic,
                    )
                };
                if cache.is_some() {
                    series_key.truncate(scope_key_len);
                    key_field(&mut series_key, metric.name.as_bytes());
                    key_field(&mut series_key, metric.unit.as_bytes());
                    key_field(&mut series_key, metric.description.as_bytes());
                    series_key.extend_from_slice(&kind.to_le_bytes());
                    series_key.extend_from_slice(&temporality.to_le_bytes());
                    series_key.push(u8::from(monotonic));
                    prost::encode_length_delimiter(metric.metadata.len(), &mut series_key).unwrap();
                    key_attributes(&mut series_key, &metric.metadata);
                } else {
                    projected_metric = Some(metric_projection()?);
                }
                let metric_key_len = series_key.len();
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
                    let (mut row, metadata, overhead, removed_len) = if let Some(cache) = cache {
                        series_key.truncate(metric_key_len);
                        key_attributes(&mut series_key, observation.attributes());
                        let cached = cache.series.get_or_try_insert(&series_key, || {
                            if projected_metric.is_none() {
                                projected_metric = Some(metric_projection()?);
                            }
                            let (mut frame, stream) =
                                project_point(projected_metric.as_ref().unwrap(), observation)?;
                            let bound_overhead = crate::series::singleton_overhead(&frame);
                            let full_len = frame.encoded_len();
                            let metadata = Arc::new(SeriesMetadata::from_split(
                                &mut frame,
                                resource.split.as_deref(),
                            ));
                            let split_len = frame.encoded_len();
                            let bytes = identity_cache::row_heap_bytes(&frame)
                                + metadata.heap_bytes()
                                + std::mem::size_of::<SeriesMetadata>();
                            Ok((
                                identity_cache::Series {
                                    frame,
                                    metadata,
                                    bound_overhead,
                                    stream,
                                    start: observation.start(),
                                    full_len,
                                    split_len,
                                },
                                bytes,
                            ))
                        })?;
                        let mut row = cached.frame.clone();
                        if cached.start != observation.start() {
                            row.stream_id = stream_id(&cached.stream, observation.start());
                        }
                        (
                            row,
                            Some(cached.metadata.clone()),
                            cached.bound_overhead,
                            (cached.full_len, cached.split_len),
                        )
                    } else {
                        let (row, _) =
                            project_point(projected_metric.as_ref().unwrap(), observation)?;
                        let overhead = crate::series::singleton_overhead(&row);
                        (row, None, overhead, (0, 0))
                    };
                    row.sample_id = if compact {
                        Vec::new()
                    } else {
                        identity::sample_id(raw, &original)?.to_vec()
                    };
                    row.time_unix_nano = observation.time();
                    row.start_time_unix_nano = observation.start();
                    row.flags = observation.flags();
                    row.event_day = (observation.time() / 86_400_000_000_000) as u32;
                    row.lineage = lineage.as_ref().map_or_else(Vec::new, |lineage| {
                        PointLineage {
                            original: Some(original),
                            ..lineage.clone()
                        }
                        .encode_to_vec()
                    });
                    row.original_position = if compact {
                        original.encode_to_vec()
                    } else {
                        Vec::new()
                    };
                    min_event = min_event.min(row.time_unix_nano);
                    max_event = max_event.max(row.time_unix_nano);
                    lower_observation(&mut row, observation)?;
                    let mut source_len = 0;
                    if compact
                        && out.is_empty()
                        && let Some(metadata) = &metadata
                    {
                        metadata.restore_source(&mut row);
                        source_len = metadata.source_len();
                    }
                    // Raw Kafka coordinates are unknown until publication.
                    let size = row.encoded_len() - removed_len.1 - source_len
                        + removed_len.0
                        + overhead
                        + if compact { 17 } else { 0 };
                    if out.is_empty() {
                        first_size = size;
                    }
                    if size > max_record_bytes {
                        return Err("normalized record byte limit");
                    }
                    bytes = bytes.checked_add(size).ok_or("normalized byte overflow")?;
                    if bytes > max_batch_bytes {
                        return Err("normalized batch byte limit");
                    }
                    out.push(PreparedPoint {
                        frame: row,
                        metadata,
                        resource: resource.split.clone(),
                    });
                }
            }
        }
    }
    if compact && let Some(first) = out.first_mut() {
        let first_frame_len = first.frame.encoded_len();
        first.frame.received_unix_nano = raw.received_unix_nano;
        first.frame.min_event_unix_nano = min_event;
        first.frame.max_event_unix_nano = max_event;
        // The per-delivery socket peer is independent of the collector connection.
        if let Some(mut connection) = request_lineage.delivery.take() {
            request_lineage.delivery = Some(DeliveryContext {
                inventory_observed_unix_nano: connection.inventory_observed_unix_nano.take(),
                ingestion_peer_address: connection.ingestion_peer_address.take(),
                ..Default::default()
            });
            context_evidence.connection = Some(connection);
        }
        // Receipt time has its own delivery column.
        request_lineage.received_unix_nano = 0;
        first.frame.delivery_request = request_lineage.encode_to_vec();
        first.frame.delivery_context = context_evidence.encode_to_vec();
        let mut hash = TypedHash::new("recount.delivery-context.v1");
        identity::security(&mut hash, security);
        hash.field(&first.frame.delivery_context);
        first.frame.delivery_context_id = hash.finish().to_vec();
        let extra = first.frame.encoded_len() - first_frame_len;
        let size = first_size + extra;
        let total = bytes.checked_add(extra).ok_or("normalized byte overflow")?;
        if size > max_record_bytes || total > max_batch_bytes {
            return Err("normalized delivery byte limit");
        }
    }
    Ok(out)
}

// Order matters for projected nodes and the storage ID, even when it does
// not matter for the canonical SHA-256 stream and logical series inputs.
// Encode the ordered, decoded fields with unambiguous boundaries.
fn key_field(out: &mut Vec<u8>, bytes: &[u8]) {
    prost::encode_length_delimiter(bytes.len(), &mut *out).unwrap();
    out.extend_from_slice(bytes);
}

fn key_optional_str(out: &mut Vec<u8>, value: Option<&str>) {
    out.push(u8::from(value.is_some()));
    if let Some(value) = value {
        key_field(out, value.as_bytes());
    }
}

fn key_message(out: &mut Vec<u8>, value: Option<&impl Message>) {
    out.push(u8::from(value.is_some()));
    if let Some(value) = value {
        value.encode_length_delimited(out).unwrap();
    }
}

fn key_attributes(out: &mut Vec<u8>, attrs: &[KeyValue]) {
    for attr in attrs {
        attr.encode_length_delimited(&mut *out).unwrap();
    }
}

fn project_resource(
    resource: &ResourceMetrics,
    security: &SecurityScope,
    context: &ResourceContext,
) -> Result<identity_cache::Resource, &'static str> {
    let reference = context
        .resource
        .as_ref()
        .ok_or("missing resource reference")?;
    let attrs = projection::PreparedAttributes::new(
        resource.resource.as_ref().map_or(&[], |r| &r.attributes),
    )?;
    let mut stream = TypedHash::new("recount.stream");
    identity::security(&mut stream, security);
    stream.field(reference.id.as_bytes());
    stream.u64(reference.kind as u64);
    stream.field(&attrs.canonical);
    stream.field(resource.schema_url.as_bytes());
    let row = AnalyticalPoint {
        project_id: security.project_id.clone(),
        source_id: security.source_id.clone(),
        resource_id: reference.id.clone(),
        resource_kind: reference.kind,
        host_id: context.host_id.clone(),
        device_id: context.device_id.clone(),
        resource_present: resource.resource.is_some(),
        resource_schema_url: resource.schema_url.clone(),
        resource_attributes: attrs.nodes,
        resource_dropped_attributes_count: resource
            .resource
            .as_ref()
            .map_or(0, |r| r.dropped_attributes_count),
        resource_entity_refs: resource.resource.as_ref().map_or_else(Vec::new, |r| {
            r.entity_refs.iter().map(Message::encode_to_vec).collect()
        }),
        ..Default::default()
    };
    Ok(identity_cache::Resource {
        row,
        stream,
        token: 0,
        split: None,
    })
}

fn project_scope(
    resource: &identity_cache::Resource,
    scope: &ScopeMetrics,
) -> Result<(AnalyticalPoint, TypedHash), &'static str> {
    let attrs =
        projection::PreparedAttributes::new(scope.scope.as_ref().map_or(&[], |s| &s.attributes))?;
    let name = scope.scope.as_ref().map_or("", |s| s.name.as_str());
    let version = scope.scope.as_ref().map_or("", |s| s.version.as_str());
    let mut stream = resource.stream.clone();
    stream.field(scope.schema_url.as_bytes());
    stream.field(name.as_bytes());
    stream.field(version.as_bytes());
    stream.field(&attrs.canonical);
    let row = AnalyticalPoint {
        scope_present: scope.scope.is_some(),
        scope_name: name.to_owned(),
        scope_version: version.to_owned(),
        scope_schema_url: scope.schema_url.clone(),
        scope_attributes: attrs.nodes,
        scope_dropped_attributes_count: scope
            .scope
            .as_ref()
            .map_or(0, |s| s.dropped_attributes_count),
        ..resource.row.clone()
    };
    Ok((row, stream))
}

fn project_metric(
    scope: &(AnalyticalPoint, TypedHash),
    metric: &Metric,
    kind: i32,
    temporality: i32,
    monotonic: bool,
) -> Result<(AnalyticalPoint, TypedHash), &'static str> {
    let mut stream = scope.1.clone();
    stream.field(metric.name.as_bytes());
    stream.field(metric.unit.as_bytes());
    stream.u64(kind as u64);
    stream.u64(temporality as u64);
    stream.u64(u64::from(monotonic));
    let row = AnalyticalPoint {
        metric_name: metric.name.clone(),
        unit: metric.unit.clone(),
        description: metric.description.clone(),
        metric_metadata: projection::attributes(&metric.metadata)?,
        metric_kind: kind,
        temporality,
        monotonic: (kind == 2).then_some(monotonic),
        ..scope.0.clone()
    };
    Ok((row, stream))
}

fn project_point(
    metric: &(AnalyticalPoint, TypedHash),
    observation: Observation<'_>,
) -> Result<(AnalyticalPoint, TypedHash), &'static str> {
    let attrs = projection::PreparedAttributes::new(observation.attributes())?;
    let mut stream = metric.1.clone();
    stream.field(&attrs.canonical);
    let row = AnalyticalPoint {
        stream_id: stream_id(&stream, observation.start()),
        point_attributes: attrs.nodes,
        ..metric.0.clone()
    };
    Ok((row, stream))
}

fn stream_id(prefix: &TypedHash, start: u64) -> Vec<u8> {
    let mut hash = prefix.clone();
    hash.u64(start);
    hash.finish().to_vec()
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
    pub time_unix_nano: u64,
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
            time_unix_nano: point.time_unix_nano,
        });
    }
    Ok(records)
}
