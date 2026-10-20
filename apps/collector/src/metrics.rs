use opentelemetry_proto::tonic::{
    common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value},
    metrics::v1::{
        AggregationTemporality, Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum,
        metric, number_data_point,
    },
    resource::v1::Resource,
};

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

pub(crate) fn counter(name: &str, unit: &str, points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: name.into(),
        unit: unit.into(),
        data: Some(metric::Data::Sum(Sum {
            data_points: points,
            aggregation_temporality: AggregationTemporality::Cumulative as i32,
            is_monotonic: true,
        })),
        ..Default::default()
    }
}

pub(crate) fn gauge(name: &str, unit: &str, points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: name.into(),
        unit: unit.into(),
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
                name: "pfe.collector.procfs".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                ..Default::default()
            }),
            metrics,
            ..Default::default()
        }],
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_builders_preserve_types_units_and_dimensions() {
        let cpu = counter(
            "pfe.node.cpu.time",
            "s",
            vec![point(
                number_data_point::Value::AsDouble(1.25),
                200,
                100,
                vec![
                    string("cpu.mode", "user"),
                    string(
                        "pfe.counter.segment_id",
                        "bd2e9e7e-09b7-4e28-807d-1b71ab43de88",
                    ),
                ],
            )],
        );
        assert_eq!(cpu.name, "pfe.node.cpu.time");
        assert_eq!(cpu.unit, "s");
        let Some(metric::Data::Sum(sum)) = cpu.data else {
            panic!("CPU must be a sum");
        };
        assert_eq!(sum.aggregation_temporality, 2);
        assert!(sum.is_monotonic);
        assert_eq!(
            sum.data_points[0].value,
            Some(number_data_point::Value::AsDouble(1.25))
        );
        assert_eq!(sum.data_points[0].attributes[0].key, "cpu.mode");

        let rss = gauge(
            "pfe.process.memory.rss",
            "By",
            vec![point(number_data_point::Value::AsInt(4096), 200, 0, vec![])],
        );
        let Some(metric::Data::Gauge(data)) = rss.data else {
            panic!("RSS must be a gauge");
        };
        assert_eq!(data.data_points[0].start_time_unix_nano, 0);
        assert_eq!(
            data.data_points[0].value,
            Some(number_data_point::Value::AsInt(4096))
        );
    }
}
