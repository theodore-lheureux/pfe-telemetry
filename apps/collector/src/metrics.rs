use opentelemetry_proto::tonic::{
    common::v1::{AnyValue, InstrumentationScope, KeyValue, any_value},
    metrics::v1::{
        AggregationTemporality, Gauge, Histogram, HistogramDataPoint, Metric, NumberDataPoint,
        ResourceMetrics, ScopeMetrics, Sum, metric, number_data_point,
    },
    resource::v1::Resource,
};
use recount_telemetry_validation::catalogue::{self, Definition};

fn presentation(definition: &Definition) -> Vec<KeyValue> {
    let name = definition.name;
    let section = if name.starts_with("recount.collection.")
        || name.starts_with("recount.clock.")
        || name.ends_with(".discovery.status")
    {
        "diagnostics"
    } else if name.contains(".gpu.") {
        "gpu"
    } else if name.contains(".process.") || name.starts_with("process.") {
        "processes"
    } else {
        "node"
    };
    let mut metadata = vec![string("recount.analytics.section", section)];
    let quantity = match name {
        n if n == catalogue::NODE_PROCESS_CPU_DISTRIBUTION.name => "cpu",
        n if n == catalogue::NODE_PROCESS_RSS_DISTRIBUTION.name => "memory",
        n if n == catalogue::NODE_PROCESS_IO_DISTRIBUTION.name => "disk_io",
        n if n == catalogue::NODE_GPU_UTILIZATION_DISTRIBUTION.name => "utilization",
        n if n == catalogue::NODE_GPU_MEMORY_DISTRIBUTION.name => "gpu_memory",
        n if n == catalogue::NODE_GPU_POWER_DISTRIBUTION.name => "power",
        n if n == catalogue::NODE_TCP_RTT_DISTRIBUTION.name => "rtt",
        _ => "",
    };
    if !quantity.is_empty() {
        metadata.push(string("recount.analytics.quantity", quantity));
    }
    if name == catalogue::DISCOVERED_PROCESSES.name {
        metadata.push(string("recount.analytics.heartbeat", "true"));
    }
    if name == catalogue::NODE_PROCESS_CPU_DISTRIBUTION.name {
        metadata.extend([
            string(
                "recount.analytics.coverage.metric",
                catalogue::PROCESS_COVERAGE.name,
            ),
            string("recount.analytics.coverage.omitted", "cpu_idle"),
            string("recount.analytics.coverage.mode", "excluded"),
            string("recount.analytics.coverage.reason", "idle"),
        ]);
    }
    if [
        catalogue::PROCESS_CPU_TIME.name,
        catalogue::PROCESS_MEMORY_RSS.name,
        catalogue::PROCESS_DISK_IO.name,
    ]
    .contains(&name)
    {
        metadata.extend([
            string("recount.analytics.breakdown", "process.pid"),
            string(
                "recount.analytics.coverage.metric",
                catalogue::PROCESS_COVERAGE.name,
            ),
            string("recount.analytics.coverage.omitted", "detail_deferred"),
            string("recount.analytics.coverage.mode", "partial"),
            string("recount.analytics.coverage.shown", "detail_emitted"),
            string("recount.analytics.coverage.total", "verified"),
        ]);
    }
    metadata
}

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
        metadata: presentation(definition),
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
        metadata: presentation(definition),
        data: Some(metric::Data::Gauge(Gauge {
            data_points: points,
        })),
        ..Default::default()
    }
}

pub(crate) fn histogram(definition: &Definition, data_points: Vec<HistogramDataPoint>) -> Metric {
    Metric {
        name: definition.name.into(),
        unit: definition.unit.into(),
        metadata: presentation(definition),
        data: Some(metric::Data::Histogram(Histogram {
            data_points,
            aggregation_temporality: AggregationTemporality::Delta as i32,
        })),
        ..Default::default()
    }
}

pub(crate) struct Distribution {
    point: HistogramDataPoint,
}

impl Distribution {
    pub(crate) fn new(bounds: Vec<f64>) -> Self {
        Self {
            point: HistogramDataPoint {
                bucket_counts: vec![0; bounds.len() + 1],
                explicit_bounds: bounds,
                ..Default::default()
            },
        }
    }

    pub(crate) fn observe(&mut self, value: f64) {
        let p = &mut self.point;
        p.bucket_counts[p.explicit_bounds.partition_point(|bound| *bound < value)] += 1;
        p.count += 1;
        p.sum = Some(p.sum.unwrap_or(0.0) + value);
        p.min = Some(p.min.map_or(value, |min| min.min(value)));
        p.max = Some(p.max.map_or(value, |max| max.max(value)));
    }

    pub(crate) fn count(&self) -> u64 {
        self.point.count
    }

    pub(crate) fn finish(
        mut self,
        time: u64,
        attributes: Vec<KeyValue>,
    ) -> Option<HistogramDataPoint> {
        if self.point.count == 0 {
            return None;
        }
        self.point.time_unix_nano = time;
        self.point.attributes = attributes;
        Some(self.point)
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
