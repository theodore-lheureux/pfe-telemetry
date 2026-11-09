use crate::{
    ExportMetricsServiceRequest,
    common::KeyValue,
    identity::{self, TypedHash},
    metrics::{self, Metric, metric::Data, number_data_point::Value},
    wire::{NormalizedPoint, Position, RawRecord},
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
pub fn singleton(metric: &Metric, index: usize) -> Option<Metric> {
    let data = match metric.data.as_ref()? {
        Data::Gauge(v) => Data::Gauge(metrics::Gauge {
            data_points: vec![v.data_points.get(index)?.clone()],
        }),
        Data::Sum(v) => Data::Sum(metrics::Sum {
            data_points: vec![v.data_points.get(index)?.clone()],
            aggregation_temporality: v.aggregation_temporality,
            is_monotonic: v.is_monotonic,
        }),
        Data::Histogram(v) => Data::Histogram(metrics::Histogram {
            data_points: vec![v.data_points.get(index)?.clone()],
            aggregation_temporality: v.aggregation_temporality,
        }),
        Data::ExponentialHistogram(v) => {
            Data::ExponentialHistogram(metrics::ExponentialHistogram {
                data_points: vec![v.data_points.get(index)?.clone()],
                aggregation_temporality: v.aggregation_temporality,
            })
        }
        Data::Summary(v) => Data::Summary(metrics::Summary {
            data_points: vec![v.data_points.get(index)?.clone()],
        }),
    };
    Some(Metric {
        name: metric.name.clone(),
        description: metric.description.clone(),
        unit: metric.unit.clone(),
        metadata: metric.metadata.clone(),
        data: Some(data),
    })
}

pub fn string_attribute<'a>(attrs: &'a [KeyValue], key: &str) -> Option<&'a str> {
    use crate::common::any_value::Value;
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match &v.value {
            Some(Value::StringValue(v)) => Some(v.as_str()),
            _ => None,
        })
}

// Call only after whole-request semantic validation and resource authorization;
// consumers must validate again after decoding a retained trust boundary.
// `request` must be decoded from this raw record, not independently reconstructed.
pub fn normalize_bounded(
    raw: &RawRecord,
    request: &ExportMetricsServiceRequest,
    max_points: usize,
    max_record_bytes: usize,
    max_batch_bytes: usize,
) -> Result<Vec<NormalizedPoint>, &'static str> {
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
        let context = contexts[r].ok_or("missing authorized resource binding")?;
        for (s, scope) in resource.scope_metrics.iter().enumerate() {
            for (m, metric) in scope.metrics.iter().enumerate() {
                let (kind, temporality, monotonic) = match &metric.data {
                    Some(Data::Gauge(_)) => (1, 0, false),
                    Some(Data::Sum(v)) => (2, v.aggregation_temporality, v.is_monotonic),
                    Some(Data::Histogram(v)) => (3, v.aggregation_temporality, false),
                    Some(Data::ExponentialHistogram(v)) => (4, v.aggregation_temporality, false),
                    Some(Data::Summary(_)) => (5, 0, false),
                    None => return Err("missing metric data"),
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
                    let continuity =
                        string_attribute(observation.attributes(), "recount.counter.segment_id")
                            .map(str::to_owned);
                    let mut h = TypedHash::new("recount.stream");
                    identity::security(&mut h, security);
                    let reference = context
                        .resource
                        .as_ref()
                        .ok_or("missing resource reference")?;
                    h.field(reference.id.as_bytes());
                    h.u64(reference.kind as u64);
                    h.field(&identity::canonical_attributes(
                        resource.resource.as_ref().map_or(&[], |r| &r.attributes),
                    )?);
                    h.field(resource.schema_url.as_bytes());
                    h.field(scope.schema_url.as_bytes());
                    if let Some(scope) = &scope.scope {
                        h.field(scope.name.as_bytes());
                        h.field(scope.version.as_bytes());
                        h.field(&identity::canonical_attributes(&scope.attributes)?);
                    } else {
                        h.field(b"");
                        h.field(b"");
                        h.field(&identity::canonical_attributes(&[])?);
                    }
                    h.field(metric.name.as_bytes());
                    h.field(metric.unit.as_bytes());
                    h.u64(kind.into());
                    h.u64(temporality as u64);
                    h.u64(u64::from(monotonic));
                    h.field(&identity::canonical_attributes(observation.attributes())?);
                    h.u64(observation.start());
                    let (int_value, double_value) = match observation {
                        Observation::Number(v) => match v.value {
                            Some(Value::AsInt(v)) => (Some(v), None),
                            Some(Value::AsDouble(v)) if v.is_finite() => (None, Some(v)),
                            Some(Value::AsDouble(_)) => return Err("nonfinite value"),
                            None => (None, None),
                        },
                        _ => (None, None),
                    };
                    out.push(NormalizedPoint {
                        security: Some(security.clone()),
                        sample_id: identity::sample_id(raw, &original)?.to_vec(),
                        stream_id: h.finish().to_vec(),
                        original: Some(original),
                        context: Some(context.clone()),
                        time_unix_nano: observation.time(),
                        start_time_unix_nano: observation.start(),
                        continuity,
                        metric_name: metric.name.clone(),
                        unit: metric.unit.clone(),
                        flags: observation.flags(),
                        metric_kind: kind,
                        int_value,
                        double_value,
                        otlp_resource: resource.resource.as_ref().map(Message::encode_to_vec),
                        otlp_scope: scope.scope.as_ref().map(Message::encode_to_vec),
                        otlp_metric: singleton(metric, p)
                            .ok_or("point position")?
                            .encode_to_vec(),
                        resource_schema_url: resource.schema_url.clone(),
                        scope_schema_url: scope.schema_url.clone(),
                        received_unix_nano: raw.received_unix_nano,
                        record_id: raw.record_id.clone(),
                        event_day: (observation.time() / 86_400_000_000_000) as u32,
                        batch: raw.batch.clone(),
                        payload_kind: raw.payload_kind,
                    });
                    let size = crate::projection::encode(out.last().unwrap())?.len();
                    if size > max_record_bytes {
                        return Err("normalized record byte limit");
                    }
                    bytes = bytes.checked_add(size).ok_or("normalized byte overflow")?;
                    if bytes > max_batch_bytes {
                        return Err("normalized batch byte limit");
                    }
                }
            }
        }
    }
    Ok(out)
}

pub fn normalized_routing_key(point: &NormalizedPoint) -> Result<[u8; 32], &'static str> {
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
    points: &[NormalizedPoint],
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
        let row = crate::projection::encode(point)?;
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
