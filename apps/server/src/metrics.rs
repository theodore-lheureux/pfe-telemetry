use std::collections::HashSet;

use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{KeyValue, any_value::Value},
    metrics::v1::{self as metrics, Metric, NumberDataPoint, metric, number_data_point},
};
use prost::Message;
use tonic::Status;
use uuid::Uuid;

use crate::auth::{Source, identifier};

#[derive(Clone, Copy)]
/// A borrowed data point from a supported OTLP metric.
pub enum Point<'a> {
    Number(&'a NumberDataPoint),
    Histogram(&'a metrics::HistogramDataPoint),
    Exponential(&'a metrics::ExponentialHistogramDataPoint),
    Summary(&'a metrics::SummaryDataPoint),
}

macro_rules! point_field {
    ($self:expr, $point:ident, $expression:expr) => {
        match $self {
            Point::Number($point) => $expression,
            Point::Histogram($point) => $expression,
            Point::Exponential($point) => $expression,
            Point::Summary($point) => $expression,
        }
    };
}

impl<'a> Point<'a> {
    pub fn attributes(self) -> &'a [KeyValue] {
        point_field!(self, p, &p.attributes)
    }
    pub fn time(self) -> u64 {
        point_field!(self, p, p.time_unix_nano)
    }
    pub fn start(self) -> u64 {
        point_field!(self, p, p.start_time_unix_nano)
    }
    pub fn flags(self) -> u32 {
        point_field!(self, p, p.flags)
    }
    pub fn encode(self) -> Vec<u8> {
        point_field!(self, p, p.encode_to_vec())
    }
    pub fn value(self) -> Option<number_data_point::Value> {
        match self {
            Self::Number(p) => p.value,
            _ => None,
        }
    }
}

pub fn points(metric: &Metric) -> Vec<Point<'_>> {
    match &metric.data {
        Some(metric::Data::Gauge(v)) => v.data_points.iter().map(Point::Number).collect(),
        Some(metric::Data::Sum(v)) => v.data_points.iter().map(Point::Number).collect(),
        Some(metric::Data::Histogram(v)) => v.data_points.iter().map(Point::Histogram).collect(),
        Some(metric::Data::ExponentialHistogram(v)) => {
            v.data_points.iter().map(Point::Exponential).collect()
        }
        Some(metric::Data::Summary(v)) => v.data_points.iter().map(Point::Summary).collect(),
        None => vec![],
    }
}

pub fn kind(metric: &Metric) -> (&'static str, i32, bool) {
    match &metric.data {
        Some(metric::Data::Gauge(_)) => ("gauge", 0, false),
        Some(metric::Data::Sum(v)) => ("sum", v.aggregation_temporality, v.is_monotonic),
        Some(metric::Data::Histogram(v)) => ("histogram", v.aggregation_temporality, false),
        Some(metric::Data::ExponentialHistogram(v)) => {
            ("exponential_histogram", v.aggregation_temporality, false)
        }
        Some(metric::Data::Summary(_)) => ("summary", 0, false),
        None => ("", 0, false),
    }
}

pub fn string<'a>(attributes: &'a [KeyValue], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|v| v.key == name)
        .and_then(|v| v.value.as_ref())
        .and_then(|v| match &v.value {
            Some(Value::StringValue(s)) => Some(s.as_str()),
            _ => None,
        })
}

fn integer(attributes: &[KeyValue], name: &str) -> Option<i64> {
    attributes
        .iter()
        .find(|v| v.key == name)
        .and_then(|v| v.value.as_ref())
        .and_then(|v| match v.value {
            Some(Value::IntValue(s)) => Some(s),
            _ => None,
        })
}

fn invalid() -> Status {
    Status::invalid_argument("Invalid metric fields, values or attributes")
}

pub fn attributes(values: &[KeyValue], depth: usize) -> Result<(), Status> {
    if depth > 16 || values.len() > 128 {
        return Err(invalid());
    }
    let mut keys = HashSet::new();
    for item in values {
        if item.key_strindex != 0 || !identifier(&item.key) || !keys.insert(&item.key) {
            return Err(invalid());
        }
        attribute_value(item.value.as_ref().and_then(|v| v.value.as_ref()), depth)?;
    }
    Ok(())
}

fn attribute_value(value: Option<&Value>, depth: usize) -> Result<(), Status> {
    if depth > 16 {
        return Err(invalid());
    }
    match value {
        None | Some(Value::StringValueStrindex(_)) => Err(invalid()),
        Some(Value::DoubleValue(v)) if !v.is_finite() => Err(invalid()),
        Some(Value::StringValue(v)) if v.len() > 4096 => Err(invalid()),
        Some(Value::BytesValue(v)) if v.len() > 4096 => Err(invalid()),
        Some(Value::KvlistValue(v)) => attributes(&v.values, depth + 1),
        Some(Value::ArrayValue(v)) => {
            if v.values.len() > 128 {
                return Err(invalid());
            }
            for value in &v.values {
                attribute_value(value.value.as_ref(), depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn validate(
    request: &ExportMetricsServiceRequest,
    source: &Source,
    external: bool,
) -> Result<usize, Status> {
    let mut count = 0usize;
    for resource in &request.resource_metrics {
        let attrs = resource
            .resource
            .as_ref()
            .map_or(&[][..], |v| v.attributes.as_slice());
        attributes(attrs, 0)?;
        match string(attrs, "host.id") {
            Some(host) if source.hosts.iter().any(|v| v == host) => {}
            None if !source.require_host_id && !attrs.iter().any(|v| v.key == "host.id") => {}
            _ => {
                return Err(Status::permission_denied(
                    "Host is not enrolled for this source",
                ));
            }
        }
        if external {
            external_resource(attrs)?;
        }
        for scope in &resource.scope_metrics {
            if let Some(scope) = &scope.scope {
                attributes(&scope.attributes, 0)?;
            }
            if external
                && !scope
                    .scope
                    .as_ref()
                    .is_some_and(|v| identifier(&v.name) && identifier(&v.version))
            {
                return Err(invalid());
            }
            for metric in &scope.metrics {
                if metric.name.is_empty()
                    || metric.name.len() > 255
                    || metric.name.chars().any(char::is_control)
                    || metric.unit.len() > 128
                    || metric.description.len() > 4096
                    || metric.data.is_none()
                {
                    return Err(invalid());
                }
                attributes(&metric.metadata, 0)?;
                let (kind, temporality, _) = kind(metric);
                if matches!(kind, "sum" | "histogram" | "exponential_histogram")
                    && !matches!(temporality, 1 | 2)
                {
                    return Err(invalid());
                }
                for point in points(metric) {
                    count += 1;
                    if count > 100_000 {
                        return Err(Status::resource_exhausted("Too many data points"));
                    }
                    attributes(point.attributes(), 0)?;
                    if point.time() == 0 || point.start() > point.time() {
                        return Err(invalid());
                    }
                    validate_point(point)?;
                    if external {
                        external_metric(
                            metric,
                            point,
                            string(attrs, "pfe.collection.scope").unwrap_or(""),
                        )?;
                    }
                }
            }
        }
    }
    Ok(count)
}

fn validate_point(point: Point<'_>) -> Result<(), Status> {
    let finite = |v: f64| {
        if v.is_finite() {
            Ok(())
        } else {
            Err(invalid())
        }
    };
    match point {
        Point::Number(v) => {
            match v.value {
                Some(number_data_point::Value::AsDouble(v)) => finite(v)?,
                None if v.flags & 1 == 0 => return Err(invalid()),
                _ => {}
            }
            for exemplar in &v.exemplars {
                attributes(&exemplar.filtered_attributes, 0)?;
                if let Some(metrics::exemplar::Value::AsDouble(v)) = exemplar.value {
                    finite(v)?;
                }
            }
        }
        Point::Histogram(v) => {
            for number in v
                .sum
                .iter()
                .chain(v.min.iter())
                .chain(v.max.iter())
                .chain(v.explicit_bounds.iter())
            {
                finite(*number)?;
            }
            if v.explicit_bounds.windows(2).any(|v| v[0] >= v[1])
                || (!v.bucket_counts.is_empty()
                    && (v.bucket_counts.len() != v.explicit_bounds.len() + 1
                        || v.bucket_counts
                            .iter()
                            .try_fold(0u64, |a, b| a.checked_add(*b))
                            != Some(v.count)))
            {
                return Err(invalid());
            }
            for exemplar in &v.exemplars {
                attributes(&exemplar.filtered_attributes, 0)?;
                if let Some(metrics::exemplar::Value::AsDouble(v)) = exemplar.value {
                    finite(v)?;
                }
            }
        }
        Point::Exponential(v) => {
            for number in v
                .sum
                .iter()
                .chain(v.min.iter())
                .chain(v.max.iter())
                .chain(std::iter::once(&v.zero_threshold))
            {
                finite(*number)?;
            }
            if !(-10..=20).contains(&v.scale) || v.zero_threshold < 0.0 {
                return Err(invalid());
            }
            let total = v
                .positive
                .iter()
                .chain(v.negative.iter())
                .flat_map(|v| &v.bucket_counts)
                .try_fold(v.zero_count, |a, b| a.checked_add(*b));
            if total != Some(v.count) {
                return Err(invalid());
            }
            for exemplar in &v.exemplars {
                attributes(&exemplar.filtered_attributes, 0)?;
                if let Some(metrics::exemplar::Value::AsDouble(v)) = exemplar.value {
                    finite(v)?;
                }
            }
        }
        Point::Summary(v) => {
            finite(v.sum)?;
            let mut previous = -1.0;
            for value in &v.quantile_values {
                finite(value.value)?;
                if !value.quantile.is_finite()
                    || !(0.0..=1.0).contains(&value.quantile)
                    || value.quantile <= previous
                {
                    return Err(invalid());
                }
                previous = value.quantile;
            }
        }
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|v| v.to_string() == value)
}

fn external_resource(attrs: &[KeyValue]) -> Result<(), Status> {
    for name in [
        "host.id",
        "pfe.host.boot_id",
        "pfe.collection.source",
        "pfe.collection.epoch_id",
    ] {
        if !string(attrs, name).is_some_and(identifier) {
            return Err(invalid());
        }
    }
    if !canonical_uuid(string(attrs, "pfe.collection.epoch_id").unwrap_or(""))
        || string(attrs, "os.type") != Some("linux")
        || !integer(attrs, "pfe.collection.interval_ns").is_some_and(|v| v > 0)
    {
        return Err(invalid());
    }
    match string(attrs, "pfe.collection.scope") {
        Some("node") => {}
        Some("collector")
            if matches!(
                string(attrs, "pfe.collection.visibility"),
                Some("host" | "restricted")
            ) => {}
        Some("process")
            if integer(attrs, "process.pid").is_some_and(|v| v > 0)
                && string(attrs, "pfe.process.namespace_id").is_some_and(identifier)
                && string(attrs, "pfe.process.incarnation_id").is_some_and(identifier) => {}
        _ => return Err(invalid()),
    }
    for attr in attrs {
        if (attr.key.starts_with("process.")
            || attr.key.starts_with("pfe.process.")
            || attr.key == "pfe.linux.clock_ticks_per_second")
            && string(attrs, "pfe.collection.scope") != Some("process")
        {
            return Err(invalid());
        }
        if matches!(
            attr.key.as_str(),
            "pfe.collection.visibility" | "pfe.collection.capabilities"
        ) && string(attrs, "pfe.collection.scope") != Some("collector")
        {
            return Err(invalid());
        }
        match attr.key.as_str() {
            "host.id"
            | "pfe.host.boot_id"
            | "pfe.collection.source"
            | "pfe.collection.epoch_id"
            | "os.type"
            | "pfe.collection.scope"
            | "pfe.collection.visibility"
            | "host.name"
            | "pfe.process.namespace_id"
            | "pfe.process.incarnation_id" => {
                if !string(attrs, &attr.key).is_some_and(identifier) {
                    return Err(invalid());
                }
            }
            "pfe.collection.interval_ns"
            | "process.pid"
            | "pfe.process.start_time_resolution_ns"
            | "pfe.linux.clock_ticks_per_second" => {
                if !integer(attrs, &attr.key).is_some_and(|v| v > 0) {
                    return Err(invalid());
                }
            }
            "process.parent_pid" => {
                if !integer(attrs, &attr.key).is_some_and(|v| v >= 0) {
                    return Err(invalid());
                }
            }
            "pfe.process.start_time_ticks" | "pfe.process.start_time_unix_nano" => {
                if !string(attrs, &attr.key).is_some_and(|v| v.parse::<u64>().is_ok()) {
                    return Err(invalid());
                }
                let companion = if attr.key.ends_with("ticks") {
                    "pfe.linux.clock_ticks_per_second"
                } else {
                    "pfe.process.start_time_resolution_ns"
                };
                if !integer(attrs, companion).is_some_and(|v| v > 0) {
                    return Err(invalid());
                }
            }
            "pfe.collection.capabilities" => {
                let Some(Value::ArrayValue(v)) = attr.value.as_ref().and_then(|v| v.value.as_ref())
                else {
                    return Err(invalid());
                };
                if !v.values.iter().all(
                    |v| matches!(v.value.as_ref(), Some(Value::StringValue(s)) if identifier(s)),
                ) {
                    return Err(invalid());
                }
            }
            _ => {
                return Err(Status::invalid_argument(
                    "External resource attribute is not allowed",
                ));
            }
        }
    }
    Ok(())
}

fn external_metric(metric: &Metric, point: Point<'_>, scope: &str) -> Result<(), Status> {
    let (counter, integer_value, unit, expected_scope) = match metric.name.as_str() {
        "pfe.node.cpu.time" => (true, false, "s", "node"),
        "pfe.node.memory.total" | "pfe.node.memory.available" => (false, true, "By", "node"),
        "system.disk.io" => (true, true, "By", "node"),
        "process.cpu.time" => (true, false, "s", "process"),
        "pfe.process.memory.rss" => (false, true, "By", "process"),
        "process.disk.io" => (true, true, "By", "process"),
        "pfe.collection.scan.duration" => (false, false, "s", "collector"),
        "pfe.clock.status" => (false, true, "1", "collector"),
        "pfe.clock.uncertainty" => (false, true, "ns", "collector"),
        "pfe.collection.discovery.status" => (false, true, "1", "collector"),
        "pfe.collection.discovered.processes" | "pfe.collection.discarded.processes" => {
            (false, true, "{process}", "collector")
        }
        "pfe.collection.dropped.points" => (true, true, "{point}", "collector"),
        "pfe.collection.read.status" => (false, true, "1", scope),
        _ => {
            return Err(Status::failed_precondition(
                "Unsupported external metric mapping",
            ));
        }
    };
    if scope != expected_scope || metric.unit != unit || point.flags() != 0 {
        return Err(invalid());
    }
    if counter {
        if !matches!(&metric.data, Some(metric::Data::Sum(v)) if v.is_monotonic && v.aggregation_temporality == 2)
        {
            return Err(invalid());
        }
        if metric.name != "pfe.collection.dropped.points"
            && !string(point.attributes(), "pfe.counter.segment_id").is_some_and(canonical_uuid)
        {
            return Err(invalid());
        }
    } else if !matches!(metric.data, Some(metric::Data::Gauge(_))) || point.start() != 0 {
        return Err(invalid());
    }
    match point.value() {
        Some(number_data_point::Value::AsInt(v)) if integer_value && v >= 0 => {
            if (metric.name.ends_with("read.status") || metric.name.ends_with("discovery.status"))
                && v > 6
            {
                return Err(invalid());
            }
            if metric.name == "pfe.clock.status" && v > 2 {
                return Err(invalid());
            }
        }
        Some(number_data_point::Value::AsDouble(v)) if !integer_value && v >= 0.0 => {}
        _ => return Err(invalid()),
    }
    if metric.name == "pfe.collection.read.status" && !matches!(scope, "node" | "process") {
        return Err(invalid());
    }
    let attrs = point.attributes();
    for attr in attrs {
        if !string(attrs, &attr.key).is_some_and(identifier) {
            return Err(invalid());
        }
        let allowed = match attr.key.as_str() {
            "cpu.mode" => matches!(
                metric.name.as_str(),
                "pfe.node.cpu.time" | "process.cpu.time"
            ),
            "disk.io.direction" => {
                matches!(metric.name.as_str(), "system.disk.io" | "process.disk.io")
            }
            "system.device" => metric.name == "system.disk.io",
            "pfe.counter.segment_id" => counter && metric.name != "pfe.collection.dropped.points",
            "pfe.metric.name" => metric.name == "pfe.collection.read.status",
            "reason" => matches!(
                metric.name.as_str(),
                "pfe.collection.discarded.processes" | "pfe.collection.dropped.points"
            ),
            "pfe.execution.id" | "pfe.execution.association_id" => scope == "process",
            _ => false,
        };
        if !allowed {
            return Err(invalid());
        }
        if attr.key.starts_with("pfe.execution.")
            && (scope != "process"
                || !string(attrs, &attr.key).is_some_and(|v| {
                    Uuid::parse_str(v).is_ok_and(|u| u.get_version_num() == 7 && u.to_string() == v)
                }))
        {
            return Err(invalid());
        }
    }
    match metric.name.as_str() {
        "pfe.node.cpu.time"
            if !matches!(
                string(attrs, "cpu.mode"),
                Some("user" | "nice" | "system" | "idle" | "interrupt" | "softirq" | "steal")
            ) =>
        {
            return Err(invalid());
        }
        "process.cpu.time" if !matches!(string(attrs, "cpu.mode"), Some("user" | "system")) => {
            return Err(invalid());
        }
        "system.disk.io" | "process.disk.io" => {
            if !matches!(string(attrs, "disk.io.direction"), Some("read" | "write")) {
                return Err(invalid());
            }
            if metric.name == "system.disk.io"
                && !string(attrs, "system.device").is_some_and(identifier)
            {
                return Err(invalid());
            }
        }
        "pfe.collection.read.status"
            if !string(attrs, "pfe.metric.name").is_some_and(identifier) =>
        {
            return Err(invalid());
        }
        "pfe.collection.discarded.processes"
            if !matches!(
                string(attrs, "reason"),
                Some("identity_unverified" | "disappeared")
            ) =>
        {
            return Err(invalid());
        }
        "pfe.collection.dropped.points"
            if !matches!(
                string(attrs, "reason"),
                Some("buffer_full" | "buffer_expired" | "permanent_rejection")
            ) =>
        {
            return Err(invalid());
        }
        _ => {}
    }
    Ok(())
}
