use crate::{Category, Issue};
use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::KeyValue,
    identity::canonical_attributes,
    metrics::{self, metric::Data, number_data_point::Value},
    point::{self, Observation},
    wire::{NormalizedPoint, PayloadKind, RawRecord, RelationKind, ResourceKind},
};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub decoded_bytes: usize,
    pub points: usize,
    pub expanded_items: usize,
    pub distinct_authorities: usize,
    pub attributes_per_set: usize,
    pub normalized_record_bytes: usize,
    pub normalized_batch_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            decoded_bytes: 4 * 1024 * 1024,
            points: 16_384,
            expanded_items: 262_144,
            distinct_authorities: 256,
            attributes_per_set: 128,
            normalized_record_bytes: 1024 * 1024,
            normalized_batch_bytes: 16 * 1024 * 1024,
        }
    }
}
impl Limits {
    pub fn validate(self) -> Result<Self, Issue> {
        if [
            self.decoded_bytes,
            self.points,
            self.expanded_items,
            self.distinct_authorities,
            self.attributes_per_set,
            self.normalized_record_bytes,
            self.normalized_batch_bytes,
        ]
        .contains(&0)
            || self.normalized_record_bytes > self.normalized_batch_bytes
        {
            return Err(Issue::new(
                Category::Invalid,
                "limits",
                "positive bounds and record bytes <= total output bytes required",
            ));
        }
        Ok(self)
    }
}
fn invalid(path: &str, reason: &'static str) -> Issue {
    Issue::new(Category::Invalid, path, reason)
}
fn attrs(v: &[KeyValue], limits: Limits) -> Result<(), Issue> {
    fn nodes(
        value: &recount_telemetry_schema::common::AnyValue,
        count: &mut usize,
        limits: Limits,
        depth: usize,
    ) -> Result<(), Issue> {
        use recount_telemetry_schema::common::any_value::Value;
        if depth > 16 {
            return Err(Issue::new(
                Category::Limit,
                "attributes",
                "attribute depth limit",
            ));
        }
        *count += 1;
        if *count > limits.attributes_per_set {
            return Err(Issue::new(
                Category::Limit,
                "attributes",
                "recursive attribute node limit",
            ));
        }
        match &value.value {
            Some(Value::StringValue(v)) if v.len() > 65536 => {
                return Err(Issue::new(
                    Category::Limit,
                    "attributes",
                    "attribute string byte limit",
                ));
            }
            Some(Value::BytesValue(v)) if v.len() > 65536 => {
                return Err(Issue::new(
                    Category::Limit,
                    "attributes",
                    "attribute bytes limit",
                ));
            }
            Some(Value::ArrayValue(v)) => {
                for v in &v.values {
                    nodes(v, count, limits, depth + 1)?;
                }
            }
            Some(Value::KvlistValue(v)) => {
                for kv in &v.values {
                    if kv.key.len() > 128 {
                        return Err(Issue::new(
                            Category::Limit,
                            "attributes",
                            "attribute key byte limit",
                        ));
                    }
                    if let Some(v) = &kv.value {
                        nodes(v, count, limits, depth + 1)?;
                    } else {
                        *count += 1;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut count = 0;
    for kv in v {
        if kv.key.len() > 128 {
            return Err(Issue::new(
                Category::Limit,
                "attributes",
                "attribute key byte limit",
            ));
        }
        if let Some(v) = &kv.value {
            nodes(v, &mut count, limits, 0)?;
        } else {
            count += 1;
        }
    }
    if count > limits.attributes_per_set {
        return Err(Issue::new(
            Category::Limit,
            "attributes",
            "attribute count limit",
        ));
    }
    canonical_attributes(v).map_err(|e| invalid("attributes", e))?;
    Ok(())
}
fn finite(v: impl IntoIterator<Item = f64>) -> Result<(), Issue> {
    if v.into_iter().all(f64::is_finite) {
        Ok(())
    } else {
        Err(invalid("value", "nonfinite number"))
    }
}
fn extrema(sum: Option<f64>, min: Option<f64>, max: Option<f64>, count: u64) -> Result<(), Issue> {
    finite(sum.into_iter().chain(min).chain(max))?;
    if min.zip(max).is_some_and(|(a, b)| a > b) || count == 0 && sum.is_some_and(|v| v != 0.0) {
        return Err(invalid("distribution", "inconsistent summary statistics"));
    }
    Ok(())
}
fn exemplars(v: &[metrics::Exemplar], limits: Limits) -> Result<(), Issue> {
    for e in v {
        attrs(&e.filtered_attributes, limits)?;
        if !matches!(e.trace_id.len(), 0 | 16)
            || !matches!(e.span_id.len(), 0 | 8)
            || e.time_unix_nano == 0
        {
            return Err(invalid("exemplars", "invalid exemplar context"));
        }
        match e.value {
            Some(metrics::exemplar::Value::AsDouble(v)) => finite([v])?,
            Some(_) => {}
            None => return Err(invalid("exemplars", "missing exemplar value")),
        }
    }
    Ok(())
}
fn add_expanded(total: &mut usize, n: usize, limits: Limits) -> Result<(), Issue> {
    *total = total
        .checked_add(n)
        .ok_or_else(|| invalid("points", "expansion overflow"))?;
    if *total > limits.expanded_items {
        return Err(Issue::new(Category::Limit, "points", "expanded item limit"));
    }
    Ok(())
}
fn temporality(v: i32) -> Result<(), Issue> {
    if matches!(v, 1 | 2) {
        Ok(())
    } else {
        Err(invalid("temporality", "expected delta or cumulative"))
    }
}

pub fn request(request: &ExportMetricsServiceRequest, limits: Limits) -> Result<usize, Issue> {
    let limits = limits.validate()?;
    if request.encoded_len() > limits.decoded_bytes {
        return Err(Issue::new(Category::Limit, "request", "decoded byte limit"));
    }
    let mut points = 0;
    let mut expanded = 0;
    for resource in &request.resource_metrics {
        add_expanded(&mut expanded, 1, limits)?;
        if let Some(r) = &resource.resource {
            attrs(&r.attributes, limits)?;
        }
        for scope in &resource.scope_metrics {
            add_expanded(&mut expanded, 1, limits)?;
            if let Some(s) = &scope.scope {
                attrs(&s.attributes, limits)?;
            }
            for metric in &scope.metrics {
                add_expanded(&mut expanded, 1, limits)?;
                if metric.name.is_empty() || metric.name.len() > 1024 || metric.unit.len() > 128 {
                    return Err(invalid("metric", "metric name or unit length"));
                }
                attrs(&metric.metadata, limits)?;
                match &metric.data {
                    Some(Data::Sum(v)) => temporality(v.aggregation_temporality)?,
                    Some(Data::Histogram(v)) => temporality(v.aggregation_temporality)?,
                    Some(Data::ExponentialHistogram(v)) => temporality(v.aggregation_temporality)?,
                    None => return Err(invalid("metric", "missing metric data")),
                    _ => {}
                }
                for observation in point::observations(metric) {
                    points += 1;
                    if points > limits.points {
                        return Err(Issue::new(Category::Limit, "points", "point count limit"));
                    }
                    add_expanded(&mut expanded, 1, limits)?;
                    attrs(observation.attributes(), limits)?;
                    if observation.time() == 0 || observation.start() > observation.time() {
                        return Err(invalid(
                            "time",
                            "nonzero event time and start <= event required",
                        ));
                    }
                    if observation.flags() & !1 != 0 {
                        return Err(Issue::new(
                            Category::Unsupported,
                            "flags",
                            "unsupported point flags",
                        ));
                    }
                    match observation {
                        Observation::Number(p) => {
                            exemplars(&p.exemplars, limits)?;
                            add_expanded(&mut expanded, p.exemplars.len(), limits)?;
                            match p.value {
                                Some(Value::AsDouble(v)) => finite([v])?,
                                None if p.flags & 1 == 0 => {
                                    return Err(invalid(
                                        "value",
                                        "absent value requires no-recorded flag",
                                    ));
                                }
                                _ => {}
                            }
                        }
                        Observation::Histogram(p) => {
                            extrema(p.sum, p.min, p.max, p.count)?;
                            finite(p.explicit_bounds.iter().copied())?;
                            if !p.explicit_bounds.windows(2).all(|v| v[0] < v[1])
                                || if p.bucket_counts.is_empty() {
                                    !p.explicit_bounds.is_empty()
                                } else {
                                    p.bucket_counts.len() != p.explicit_bounds.len() + 1
                                        || p.bucket_counts
                                            .iter()
                                            .try_fold(0u64, |a, b| a.checked_add(*b))
                                            != Some(p.count)
                                }
                            {
                                return Err(invalid(
                                    "histogram",
                                    "inconsistent bounds, buckets or count",
                                ));
                            }
                            exemplars(&p.exemplars, limits)?;
                            add_expanded(
                                &mut expanded,
                                p.bucket_counts.len() + p.explicit_bounds.len() + p.exemplars.len(),
                                limits,
                            )?;
                        }
                        Observation::Exponential(p) => {
                            extrema(p.sum, p.min, p.max, p.count)?;
                            finite([p.zero_threshold])?;
                            let buckets = p.positive.iter().chain(p.negative.iter());
                            let mut count = Some(p.zero_count);
                            for b in buckets {
                                add_expanded(&mut expanded, b.bucket_counts.len(), limits)?;
                                if b.bucket_counts.len() > i32::MAX as usize
                                    || b.offset
                                        .checked_add(b.bucket_counts.len().saturating_sub(1) as i32)
                                        .is_none()
                                {
                                    return Err(invalid(
                                        "exponential_histogram",
                                        "bucket index overflow",
                                    ));
                                }
                                for n in &b.bucket_counts {
                                    count = count.and_then(|v| v.checked_add(*n));
                                }
                            }
                            if p.zero_threshold < 0.0 || count != Some(p.count) {
                                return Err(invalid(
                                    "exponential_histogram",
                                    "inconsistent count or zero threshold",
                                ));
                            }
                            exemplars(&p.exemplars, limits)?;
                            add_expanded(&mut expanded, p.exemplars.len(), limits)?;
                        }
                        Observation::Summary(p) => {
                            finite([p.sum])?;
                            if p.count == 0 && p.sum != 0.0 {
                                return Err(invalid("summary", "zero count requires zero sum"));
                            }
                            let mut previous = None;
                            for q in &p.quantile_values {
                                finite([q.quantile, q.value])?;
                                if !(0.0..=1.0).contains(&q.quantile)
                                    || previous.is_some_and(|v| v >= q.quantile)
                                {
                                    return Err(invalid(
                                        "summary",
                                        "quantiles must be ordered, unique and within [0,1]",
                                    ));
                                }
                                previous = Some(q.quantile);
                            }
                            add_expanded(&mut expanded, p.quantile_values.len(), limits)?;
                        }
                    }
                }
            }
        }
    }
    Ok(points)
}

// Run before raw publication, then again after raw decode. Age/credential
// authority are request-only policy, not reasons to discard accepted replay.
pub fn raw(raw: &RawRecord, limits: Limits) -> Result<Vec<NormalizedPoint>, Issue> {
    let limits = limits.validate()?;
    if raw.encoded_len() > limits.decoded_bytes {
        return Err(Issue::new(Category::Limit, "raw", "raw record byte limit"));
    }
    let security = raw
        .security
        .as_ref()
        .ok_or_else(|| invalid("security", "missing trusted scope"))?;
    for id in [&security.project_id, &security.source_id, &raw.record_id] {
        if id.is_empty() || id.len() > 128 {
            return Err(invalid("identity", "expected bounded nonempty identity"));
        }
    }
    if raw.payload_kind != PayloadKind::OtlpMetrics as i32 || raw.received_unix_nano == 0 {
        return Err(invalid("raw", "unsupported payload or missing receipt"));
    }
    if let Some(b) = &raw.batch {
        crate::metadata::batch(Some(&b.client_id), Some(&b.created_unix_nano.to_string()))?;
    }
    let request = ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice())
        .map_err(|_| invalid("otlp", "invalid OTLP encoding"))?;
    self::request(&request, limits)?;
    let mut positions = BTreeSet::new();
    for b in &raw.bindings {
        if b.original_resource as usize >= request.resource_metrics.len()
            || !positions.insert(b.original_resource)
        {
            return Err(invalid(
                "bindings",
                "duplicate or out-of-range resource position",
            ));
        }
        let context = b
            .context
            .as_ref()
            .ok_or_else(|| invalid("bindings", "missing context"))?;
        let reference = context
            .resource
            .as_ref()
            .ok_or_else(|| invalid("bindings", "missing resource reference"))?;
        if reference.id.is_empty()
            || reference.id.len() > 128
            || ResourceKind::try_from(reference.kind).is_err()
        {
            return Err(invalid("bindings", "invalid resource reference"));
        }
        for id in [&context.host_id, &context.device_id].into_iter().flatten() {
            if id.is_empty() || id.len() > 128 {
                return Err(invalid("bindings", "invalid promoted reference"));
            }
        }
        if context.relationships.len() > 64 {
            return Err(Issue::new(
                Category::Limit,
                "relationships",
                "relationship count limit",
            ));
        }
        for relation in &context.relationships {
            if RelationKind::try_from(relation.kind).is_err()
                || relation.evidence.is_empty()
                || relation.provenance.is_empty()
                || relation.evidence.len() > 1024
                || relation.provenance.len() > 128
                || relation
                    .effective_from_unix_nano
                    .zip(relation.effective_until_unix_nano)
                    .is_some_and(|(a, b)| a > b)
            {
                return Err(invalid(
                    "relationships",
                    "invalid relationship evidence or interval",
                ));
            }
            for r in [&relation.from, &relation.to] {
                if r.as_ref().is_none_or(|r| {
                    r.id.is_empty() || r.id.len() > 128 || ResourceKind::try_from(r.kind).is_err()
                }) {
                    return Err(invalid("relationships", "missing typed endpoint"));
                }
            }
        }
    }
    if positions.len() != request.resource_metrics.len() {
        return Err(invalid(
            "bindings",
            "one binding per original ResourceMetrics required",
        ));
    }
    crate::policy::requested_authorities(raw, limits.distinct_authorities)?;
    point::normalize_bounded(
        raw,
        &request,
        limits.points,
        limits.normalized_record_bytes,
        limits.normalized_batch_bytes,
    )
    .map_err(|e| Issue::new(Category::Limit, "normalized", e))
}

pub fn normalized(point: &NormalizedPoint, limits: Limits) -> Result<(), Issue> {
    let limits = limits.validate()?;
    use recount_telemetry_schema::{
        common::InstrumentationScope, identity, resource::Resource, wire::ResourceBinding,
    };
    if recount_telemetry_schema::projection::encode(point)
        .map_err(|e| invalid("normalized", e))?
        .len()
        > limits.normalized_record_bytes
    {
        return Err(Issue::new(
            Category::Limit,
            "normalized",
            "normalized protobuf byte limit",
        ));
    }
    let metric = metrics::Metric::decode(point.otlp_metric.as_slice())
        .map_err(|_| invalid("metric", "invalid metric encoding"))?;
    if point::observations(&metric).len() != 1 {
        return Err(invalid(
            "metric",
            "exactly one original observation required",
        ));
    }
    let resource = point
        .otlp_resource
        .as_deref()
        .map(Resource::decode)
        .transpose()
        .map_err(|_| invalid("resource", "invalid resource encoding"))?;
    let scope = point
        .otlp_scope
        .as_deref()
        .map(InstrumentationScope::decode)
        .transpose()
        .map_err(|_| invalid("scope", "invalid scope encoding"))?;
    let request = ExportMetricsServiceRequest {
        resource_metrics: vec![metrics::ResourceMetrics {
            resource,
            schema_url: point.resource_schema_url.clone(),
            scope_metrics: vec![metrics::ScopeMetrics {
                scope,
                schema_url: point.scope_schema_url.clone(),
                metrics: vec![metric],
            }],
        }],
    };
    let synthetic = RawRecord {
        security: point.security.clone(),
        record_id: point.record_id.clone(),
        received_unix_nano: point.received_unix_nano,
        batch: point.batch.clone(),
        payload_kind: point.payload_kind,
        otlp_request: request.encode_to_vec(),
        bindings: vec![ResourceBinding {
            original_resource: 0,
            context: point.context.clone(),
        }],
    };
    let mut expected = raw(&synthetic, limits)?.remove(0);
    let position = point
        .original
        .as_ref()
        .ok_or_else(|| invalid("original", "missing original point position"))?;
    expected.sample_id = identity::sample_id(&synthetic, position)
        .map_err(|e| invalid("sample_id", e))?
        .to_vec();
    expected.original = Some(*position);
    if expected != *point
        || expected.double_value.map(f64::to_bits) != point.double_value.map(f64::to_bits)
    {
        return Err(invalid(
            "normalized",
            "typed fields disagree with supported OTLP or immutable identity",
        ));
    }
    Ok(())
}

pub fn retained_raw(record: &RawRecord, limits: Limits) -> Result<Vec<NormalizedPoint>, Issue> {
    raw(record, limits).map_err(|mut issue| {
        issue.category = Category::Poison;
        issue
    })
}
