use opentelemetry_proto::tonic::{
    common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value},
    metrics::v1::{
        AggregationTemporality, Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum,
        metric, number_data_point,
    },
    resource::v1::Resource,
};
use recount_telemetry_validation::catalogue::Definition;

pub(crate) fn string(key: &str, value: impl Into<String>) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::StringValue(value.into())),
        }),
        ..Default::default()
    }
}

pub(crate) fn integer(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(any_value::Value::IntValue(value)),
        }),
        ..Default::default()
    }
}

pub(crate) fn point(
    value: number_data_point::Value,
    time: u64,
    start: u64,
    attributes: Vec<KeyValue>,
) -> NumberDataPoint {
    NumberDataPoint {
        attributes,
        time_unix_nano: time,
        start_time_unix_nano: start,
        value: Some(value),
        ..Default::default()
    }
}

pub(crate) fn counter(definition: &Definition, points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: definition.name.into(),
        unit: definition.unit.into(),
        data: Some(metric::Data::Sum(Sum {
            data_points: points,
            aggregation_temporality: AggregationTemporality::Cumulative as i32,
            is_monotonic: true,
        })),
        ..Default::default()
    }
}

pub(crate) fn gauge(definition: &Definition, points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: definition.name.into(),
        unit: definition.unit.into(),
        data: Some(metric::Data::Gauge(Gauge {
            data_points: points,
        })),
        ..Default::default()
    }
}

pub(crate) fn resource(attributes: Vec<KeyValue>, metrics: Vec<Metric>) -> ResourceMetrics {
    ResourceMetrics {
        resource: Some(Resource {
            attributes,
            ..Default::default()
        }),
        scope_metrics: vec![ScopeMetrics {
            scope: Some(InstrumentationScope {
                name: "recount.collector.procfs".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                ..Default::default()
            }),
            metrics,
            ..Default::default()
        }],
        ..Default::default()
    }
}
