use super::{Limits, add_expanded, envelope_fields, invalid, validate_binding_context};
use crate::{Category, Issue};
use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::{AnyValue, KeyValue, any_value::Value},
    identity_cache::IdentityCache,
    metrics::{Exemplar, metric::Data, number_data_point::Value as Number},
    point::{self, Observation},
    series::PreparedPoint,
    wire::RawRecord,
};

/// The broker consumer must check the actual encoded bytes before decoding.
pub fn admitted_envelope(raw: &RawRecord) -> Result<(), Issue> {
    envelope_fields(raw)
}

/// For records from the authenticated ingestion API only, after envelope and routing
/// checks. Projection owns binding positions and normalized output limits.
pub fn admitted_delivery(
    raw: &RawRecord,
    limits: Limits,
    cache: &IdentityCache,
) -> Result<Vec<PreparedPoint>, Issue> {
    let request = ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice())
        .map_err(|_| invalid("otlp", "invalid OTLP encoding"))?;
    structure(&request, limits)?;
    if raw.bindings.len() != request.resource_metrics.len() {
        return Err(invalid(
            "bindings",
            "one binding per original resource required",
        ));
    }
    for binding in &raw.bindings {
        validate_binding_context(binding)?;
    }
    point::normalize_cached_delivery(
        raw,
        &request,
        limits.points,
        limits.normalized_record_bytes,
        limits.normalized_batch_bytes,
        cache,
    )
    .map_err(|reason| Issue::new(Category::Poison, "normalized", reason))
}

fn structure(request: &ExportMetricsServiceRequest, limits: Limits) -> Result<(), Issue> {
    let mut expanded = 0;
    let mut points = 0;
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
                attrs(&metric.metadata, limits)?;
                match &metric.data {
                    Some(Data::Sum(data)) => super::temporality(data.aggregation_temporality)?,
                    Some(Data::Histogram(data)) => {
                        super::temporality(data.aggregation_temporality)?
                    }
                    Some(Data::ExponentialHistogram(data)) => {
                        super::temporality(data.aggregation_temporality)?;
                    }
                    None => return Err(invalid("metric", "missing metric data")),
                    _ => {}
                }
                for observation in point::observation_iter(metric) {
                    points += 1;
                    if points > limits.points {
                        return Err(Issue::new(Category::Limit, "points", "point count limit"));
                    }
                    attrs(observation.attributes(), limits)?;
                    if observation.time() == 0 || observation.start() > observation.time() {
                        return Err(invalid("time", "invalid point timestamp"));
                    }
                    if observation.flags() & !1 != 0 {
                        return Err(invalid("flags", "unsupported point flags"));
                    }
                    if let Observation::Number(p) = observation {
                        match p.value {
                            None if p.flags & 1 == 0 => {
                                return Err(invalid("value", "missing recorded value"));
                            }
                            Some(Number::AsDouble(v)) if !v.is_finite() => {
                                return Err(invalid("value", "nonfinite value"));
                            }
                            _ => {}
                        }
                    }
                    let (items, exemplars): (usize, &[Exemplar]) = match observation {
                        Observation::Number(p) => (0, &p.exemplars),
                        Observation::Histogram(p) => (
                            p.bucket_counts.len() + p.explicit_bounds.len(),
                            &p.exemplars,
                        ),
                        Observation::Exponential(p) => (
                            p.positive
                                .iter()
                                .chain(&p.negative)
                                .map(|b| b.bucket_counts.len())
                                .sum(),
                            &p.exemplars,
                        ),
                        Observation::Summary(p) => (p.quantile_values.len(), &[]),
                    };
                    add_expanded(&mut expanded, 1 + items + exemplars.len(), limits)?;
                    for exemplar in exemplars {
                        attrs(&exemplar.filtered_attributes, limits)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn attrs(attrs: &[KeyValue], limits: Limits) -> Result<(), Issue> {
    let mut remaining = limits.attributes_per_set;
    attribute_list(attrs, 0, &mut remaining)
}

fn attribute_list(attrs: &[KeyValue], depth: usize, remaining: &mut usize) -> Result<(), Issue> {
    if attrs.len() > *remaining {
        return Err(attribute_limit());
    }
    for kv in attrs {
        if kv.key.len() > 128 {
            return Err(attribute_limit());
        }
        if let Some(value) = &kv.value {
            attribute_value(value, depth, remaining)?;
        } else {
            take_node(depth, remaining)?;
        }
    }
    Ok(())
}

fn take_node(depth: usize, remaining: &mut usize) -> Result<(), Issue> {
    if depth > 16 || *remaining == 0 {
        return Err(attribute_limit());
    }
    *remaining -= 1;
    Ok(())
}

fn attribute_value(value: &AnyValue, depth: usize, remaining: &mut usize) -> Result<(), Issue> {
    take_node(depth, remaining)?;
    match &value.value {
        Some(Value::ArrayValue(array)) => {
            for value in &array.values {
                attribute_value(value, depth + 1, remaining)?;
            }
        }
        Some(Value::KvlistValue(list)) => attribute_list(&list.values, depth + 1, remaining)?,
        Some(Value::StringValue(text)) if text.len() > 65536 => return Err(attribute_limit()),
        Some(Value::BytesValue(bytes)) if bytes.len() > 65536 => return Err(attribute_limit()),
        _ => {}
    }
    Ok(())
}

fn attribute_limit() -> Issue {
    Issue::new(Category::Limit, "attributes", "attribute expansion limit")
}

#[cfg(test)]
mod tests {
    use super::*;
    use recount_telemetry_schema::common::ArrayValue;

    #[test]
    fn recursive_attributes_stop_at_the_projection_depth_limit() {
        let mut value = AnyValue::default();
        for depth in 1..=17 {
            value = AnyValue {
                value: Some(Value::ArrayValue(ArrayValue {
                    values: vec![value],
                })),
            };
            let attrs = [KeyValue {
                key: "nested".into(),
                value: Some(value.clone()),
                ..Default::default()
            }];
            assert_eq!(super::attrs(&attrs, Limits::default()).is_ok(), depth <= 16);
        }
    }
}
