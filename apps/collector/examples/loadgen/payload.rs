use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::any_value::Value::StringValue,
    metrics::v1::{AggregationTemporality, metric::Data, number_data_point::Value},
};
use recount_collector::Result;
use serde_json::Value as Json;
use uuid::Uuid;

const FIXTURE: &str = include_str!("../../../../tooling/load/fixtures/collector.json");
const ANCHOR: u64 = 1_000_000_000_000_000_000;
const SAFE_INT: f64 = 9_007_199_254_740_991.0;

pub fn fixture() -> Result<ExportMetricsServiceRequest> {
    fn anchor(value: &mut Json) -> Result<()> {
        match value {
            Json::Array(values) => {
                for value in values {
                    anchor(value)?;
                }
            }
            Json::Object(values) => {
                for (key, value) in values {
                    if matches!(key.as_str(), "timeUnixNano" | "startTimeUnixNano") {
                        let offset: i64 = value
                            .as_str()
                            .ok_or("expected a fixture timestamp string")?
                            .parse()?;
                        *value = Json::String(
                            ANCHOR
                                .checked_add_signed(offset)
                                .ok_or("fixture timestamp out of range")?
                                .to_string(),
                        );
                    } else {
                        anchor(value)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut raw = serde_json::from_str(FIXTURE)?;
    anchor(&mut raw)?;
    Ok(serde_json::from_value(raw)?)
}

struct Random(u32);

impl Random {
    fn new(seed: usize) -> Self {
        Self(
            seed.to_string()
                .bytes()
                .fold(2_166_136_261u32, |state, byte| {
                    (state ^ u32::from(byte)).wrapping_mul(16_777_619)
                }),
        )
    }

    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut bits = (self.0 ^ (self.0 >> 15)).wrapping_mul(self.0 | 1);
        bits ^= bits.wrapping_add((bits ^ (bits >> 7)).wrapping_mul(bits | 61));
        f64::from(bits ^ (bits >> 14)) / 4_294_967_296.0
    }
}

// Match tooling/load/payload.js; the parity test uses the same fixture and seed.
enum Walk {
    Fixed,
    Gauge {
        value: f64,
        radius: f64,
        low: f64,
        high: f64,
        integer: bool,
    },
    IntCounter(f64),
    DoubleCounter(f64),
}

fn number(value: Value) -> f64 {
    match value {
        Value::AsInt(v) => v as f64,
        Value::AsDouble(v) => v,
    }
}

fn gauge(name: &str, unit: &str, value: Value, memory: f64, random: &mut Random) -> Walk {
    let center = number(value);
    let integer = matches!(value, Value::AsInt(_));
    if !center.is_finite()
        || (integer && center.abs() > SAFE_INT)
        || name.ends_with(".status")
        || name.ends_with(".memory.total")
    {
        return Walk::Fixed;
    }
    let percent = unit == "%";
    let fraction = unit == "1" && name.ends_with(".utilization");
    let radius = (center.abs() * 0.1)
        .max(if integer { 1.0 } else { 0.0001 })
        .max(if fraction { 0.035 } else { 0.0 })
        .max(if percent { 3.5 } else { 0.0 });
    let low = (center - radius).max(if center >= 0.0 || percent || fraction {
        0.0
    } else {
        f64::NEG_INFINITY
    });
    let high = (center + radius).min(if fraction {
        1.0
    } else if percent {
        100.0
    } else if name == "recount.node.memory.available" {
        memory
    } else if integer {
        SAFE_INT
    } else {
        f64::INFINITY
    });
    let clamp = |value: f64| value.min(high).max(low);
    Walk::Gauge {
        value: clamp(center + (random.next() * 2.0 - 1.0) * radius),
        radius,
        low,
        high,
        integer,
    }
}

fn counter(unit: &str, value: Value, random: &mut Random) -> Walk {
    match value {
        Value::AsInt(v) if v > 0 => Walk::IntCounter(if unit == "By" {
            64.0 + random.next() * 4032.0
        } else {
            1.0 + random.next() * 3.0
        }),
        Value::AsDouble(v) if v > 0.0 => Walk::DoubleCounter(0.001 + random.next() * 0.049),
        _ => Walk::Fixed,
    }
}

impl Walk {
    fn step(&mut self, current: &mut Option<Value>, random: &mut Random, elapsed: u64) {
        match (self, current) {
            (
                Self::Gauge {
                    value,
                    radius,
                    low,
                    high,
                    integer,
                },
                Some(current),
            ) => {
                *value = (*value + (random.next() * 2.0 - 1.0) * *radius * 0.35)
                    .min(*high)
                    .max(*low);
                *current = if *integer {
                    Value::AsInt((*value + 0.5).floor() as i64)
                } else {
                    Value::AsDouble(*value)
                };
            }
            (Self::IntCounter(rate), Some(Value::AsInt(value))) if elapsed > 0 => {
                *value = value.saturating_add(
                    (*rate * (0.2 + random.next() * 1.6) * elapsed as f64).floor() as i64,
                );
            }
            (Self::DoubleCounter(rate), Some(Value::AsDouble(value))) if elapsed > 0 => {
                *value += *rate * (0.2 + random.next() * 1.6) * elapsed as f64;
            }
            _ => {}
        }
    }
}

struct Timing {
    time: u64,
    start: u64,
    walk: Walk,
}

pub struct Replay {
    request: ExportMetricsServiceRequest,
    timings: Vec<Timing>,
    random: Random,
    previous: Option<u64>,
}

impl Replay {
    pub fn new(mut request: ExportMetricsServiceRequest, host: &str, ordinal: usize) -> Self {
        let mut random = Random::new(ordinal);
        let mut timings = Vec::new();
        let boot = Uuid::new_v4().to_string();
        let epoch = Uuid::new_v4().to_string();
        let namespace = format!("{host}-pid");
        for resource in &mut request.resource_metrics {
            if let Some(identity) = &mut resource.resource {
                for attr in &mut identity.attributes {
                    let id = match attr.key.as_str() {
                        "host.id" | "host.name" => host,
                        "recount.host.boot_id" => &boot,
                        "recount.collection.epoch_id" => &epoch,
                        "recount.process.namespace_id" => &namespace,
                        _ => continue,
                    };
                    if let Some(value) = &mut attr.value {
                        value.value = Some(StringValue(id.to_owned()));
                    }
                }
            }
            let memory = resource
                .scope_metrics
                .iter()
                .flat_map(|scope| &scope.metrics)
                .find_map(|metric| {
                    if metric.name != "recount.node.memory.total" {
                        return None;
                    }
                    let Some(Data::Gauge(gauge)) = &metric.data else {
                        return None;
                    };
                    gauge.data_points.first()?.value.map(number)
                })
                .unwrap_or(f64::INFINITY);
            for metric in resource
                .scope_metrics
                .iter()
                .flat_map(|scope| &scope.metrics)
            {
                let mut push = |time, start, walk| timings.push(Timing { time, start, walk });
                match &metric.data {
                    Some(Data::Gauge(data)) => {
                        for point in &data.data_points {
                            push(
                                point.time_unix_nano,
                                point.start_time_unix_nano,
                                point
                                    .value
                                    .map(|value| {
                                        gauge(
                                            &metric.name,
                                            &metric.unit,
                                            value,
                                            memory,
                                            &mut random,
                                        )
                                    })
                                    .unwrap_or(Walk::Fixed),
                            );
                        }
                    }
                    Some(Data::Sum(data)) => {
                        for point in &data.data_points {
                            let walk = if data.is_monotonic
                                && data.aggregation_temporality
                                    == AggregationTemporality::Cumulative as i32
                            {
                                point
                                    .value
                                    .map(|value| counter(&metric.unit, value, &mut random))
                                    .unwrap_or(Walk::Fixed)
                            } else {
                                Walk::Fixed
                            };
                            push(point.time_unix_nano, point.start_time_unix_nano, walk);
                        }
                    }
                    Some(Data::Histogram(data)) => {
                        for p in &data.data_points {
                            push(p.time_unix_nano, p.start_time_unix_nano, Walk::Fixed);
                        }
                    }
                    Some(Data::ExponentialHistogram(data)) => {
                        for p in &data.data_points {
                            push(p.time_unix_nano, p.start_time_unix_nano, Walk::Fixed);
                        }
                    }
                    Some(Data::Summary(data)) => {
                        for p in &data.data_points {
                            push(p.time_unix_nano, p.start_time_unix_nano, Walk::Fixed);
                        }
                    }
                    None => {}
                }
            }
        }
        Self {
            request,
            timings,
            random,
            previous: None,
        }
    }

    pub fn points(&self) -> usize {
        self.timings.len()
    }

    pub fn next(&mut self, now: u64, epoch: u64, cycle: u64) -> ExportMetricsServiceRequest {
        let next = self.previous.is_none_or(|old| cycle > old);
        let elapsed = cycle.saturating_sub(self.previous.unwrap_or(0));
        let mut timings = self.timings.iter_mut();
        for metric in self
            .request
            .resource_metrics
            .iter_mut()
            .flat_map(|resource| &mut resource.scope_metrics)
            .flat_map(|scope| &mut scope.metrics)
        {
            macro_rules! stamp {
                ($points:expr $(, $value:ident)?) => {
                    for point in $points {
                        let timing = timings.next().expect("one timing per fixture point");
                        point.time_unix_nano = now + timing.time - ANCHOR;
                        if timing.start != 0 { point.start_time_unix_nano = epoch + timing.start - ANCHOR; }
                        $(if next { timing.walk.step(&mut point.$value, &mut self.random, elapsed); })?
                    }
                };
            }
            match &mut metric.data {
                Some(Data::Gauge(data)) => stamp!(&mut data.data_points, value),
                Some(Data::Sum(data)) => stamp!(&mut data.data_points, value),
                Some(Data::Histogram(data)) => stamp!(&mut data.data_points),
                Some(Data::ExponentialHistogram(data)) => stamp!(&mut data.data_points),
                Some(Data::Summary(data)) => stamp!(&mut data.data_points),
                None => {}
            }
        }
        if next {
            self.previous = Some(cycle);
        }
        self.request.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    #[test]
    fn replay_matches_k6_value_walks_and_preserves_wire_shape() {
        let mut replay = Replay::new(fixture().unwrap(), "test", 1);
        assert_eq!(replay.points(), 1158);
        let started = 1_800_000_000_000_000_000;
        let mut size = 0;
        // tooling/load/payload.js with the lab fixture, seed 1, and cycles 0, 1, 8.
        for (cycle, expected) in [
            (0, (0.009593037500195065, 213133085, 37.24, 20691968)),
            (
                1,
                (0.009587035991840258, 209254005, 37.24430394952298, 20695764),
            ),
            (
                8,
                (0.00989668645820787, 212560940, 37.31903151792319, 20717296),
            ),
        ] {
            let body = replay.next(started + cycle * 1_000_000_000, started, cycle);
            let first = |name| {
                let data = body
                    .resource_metrics
                    .iter()
                    .flat_map(|r| &r.scope_metrics)
                    .flat_map(|scope| &scope.metrics)
                    .find(|m| m.name == name)
                    .unwrap();
                match data.data.as_ref().unwrap() {
                    Data::Gauge(data) => &data.data_points,
                    Data::Sum(data) => &data.data_points,
                    _ => unreachable!(),
                }
                .iter()
                .find_map(|p| p.value.filter(|v| number(*v) > 0.0))
                .unwrap()
            };
            assert!((number(first("recount.collection.scan.duration")) - expected.0).abs() < 1e-14);
            assert_eq!(
                first("recount.node.memory.available"),
                Value::AsInt(expected.1)
            );
            assert!((number(first("recount.node.cpu.time")) - expected.2).abs() < 1e-12);
            assert_eq!(first("system.disk.io"), Value::AsInt(expected.3));
            if cycle == 0 {
                size = body.encoded_len();
            }
            assert!(size.abs_diff(body.encoded_len()) < size / 100);
        }
    }
}
