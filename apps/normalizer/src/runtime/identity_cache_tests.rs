use super::cases;
use super::packing::{pack, pack_prepared};
use crate::{prepare_cached_rows, prepare_rows};
use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest, identity,
    identity_cache::IdentityCache,
    metrics::metric::Data,
    series::{self, PreparedPoint},
    wire::{RawRecord, ResourceBinding},
};
use recount_telemetry_validation::validate::Limits;
use serde_json::Value;
use std::sync::Arc;

fn collector() -> RawRecord {
    fn anchor(value: &mut Value, time: u64) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(|v| anchor(v, time)),
            Value::Object(values) => {
                for (key, value) in values {
                    if matches!(key.as_str(), "timeUnixNano" | "startTimeUnixNano") {
                        let offset = value.as_str().unwrap().parse().unwrap();
                        *value =
                            Value::String(time.checked_add_signed(offset).unwrap().to_string());
                    } else {
                        anchor(value, time);
                    }
                }
            }
            _ => {}
        }
    }
    let mut raw = cases::raw();
    let context = raw.bindings[0].context.clone();
    let mut fixture = serde_json::from_str(include_str!(
        "../../../../tooling/load/fixtures/collector.json"
    ))
    .unwrap();
    anchor(&mut fixture, raw.received_unix_nano);
    let request: ExportMetricsServiceRequest = serde_json::from_value(fixture).unwrap();
    raw.bindings = (0..request.resource_metrics.len())
        .map(|i| ResourceBinding {
            original_resource: i.try_into().unwrap(),
            context: context.clone(),
        })
        .collect();
    raw.otlp_request = request.encode_to_vec();
    raw
}

fn parity(raw: &RawRecord, cache: &IdentityCache) -> Vec<PreparedPoint> {
    let bytes = raw.encode_to_vec();
    let key = identity::raw_routing_key(raw).unwrap();
    let uncached = prepare_rows(&bytes, Some(&key), Limits::default()).unwrap();
    let cached = || prepare_cached_rows(&bytes, Some(&key), Limits::default(), cache).unwrap();
    let points = cached();
    assert_eq!(uncached.len(), points.len());
    for (mut expected, actual) in uncached.iter().cloned().zip(&points) {
        let metadata = series::split(&mut expected);
        assert_eq!(expected.encode_to_vec(), actual.frame.encode_to_vec());
        assert_eq!(
            series::with_series(expected, &metadata).encode_to_vec(),
            actual
                .metadata
                .as_ref()
                .unwrap()
                .attach(
                    actual.frame.clone(),
                    actual.resource.as_deref(),
                    metadata.first_seen_unix_nano,
                    metadata.last_seen_unix_nano
                )
                .encode_to_vec()
        );
    }
    for (now, packed) in [
        (raw.received_unix_nano, true),
        (raw.received_unix_nano, false),
        (raw.received_unix_nano + 10_800_000_000_000, true),
    ] {
        let expected = pack(uncached.clone(), 3, now, 2 * 1024 * 1024, packed).unwrap();
        let (actual, _) = pack_prepared(cached(), 3, now, 2 * 1024 * 1024, packed, None).unwrap();
        assert_eq!(expected.len(), actual.len());
        for (expected, actual) in expected.iter().zip(actual) {
            assert_eq!(expected.partition, actual.partition);
            assert_eq!(expected.time_unix_nano, actual.time_unix_nano);
            assert_eq!(expected.payload, actual.payload);
        }
    }
    points
}

#[test]
fn collector_and_varied_exports_keep_ids_and_packing() {
    let cache = IdentityCache::default();
    let fixture = collector();
    let cold = parity(&fixture, &cache);
    let warm = parity(&fixture, &cache);
    assert_eq!(cold.len(), 1158);
    assert!(Arc::ptr_eq(
        cold[0].metadata.as_ref().unwrap(),
        warm[0].metadata.as_ref().unwrap()
    ));

    let mut raw = cases::raw();
    parity(&raw, &cache);
    let mut request = ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice()).unwrap();
    let resource = &mut request.resource_metrics[0];
    resource.resource.as_mut().unwrap().attributes.reverse();
    let metric = cases::metric_mut(&mut request, "integer.extremes");
    metric.description.push('!');
    let Some(Data::Gauge(gauge)) = &mut metric.data else {
        panic!("expected gauge")
    };
    let point = &mut gauge.data_points[0];
    point.time_unix_nano += 20_000;
    point.start_time_unix_nano = 10;
    point.attributes = cases::attributes();
    point.attributes.reverse();
    raw.record_id.push('!');
    raw.otlp_request = request.encode_to_vec();
    parity(&raw, &cache);

    // Same identity input except the stream's start time and dynamic value.
    let before = parity(&raw, &cache);
    let point = &mut cases::gauge_mut(&mut request, "integer.extremes").data_points[0];
    point.start_time_unix_nano += 1;
    point.value = Some(recount_telemetry_schema::metrics::number_data_point::Value::AsInt(42));
    raw.otlp_request = request.encode_to_vec();
    let after = parity(&raw, &cache);
    assert!(Arc::ptr_eq(
        before[0].metadata.as_ref().unwrap(),
        after[0].metadata.as_ref().unwrap()
    ));
    assert_ne!(before[0].frame.stream_id, after[0].frame.stream_id);
}

#[test]
fn tenants_do_not_share_entries_even_across_eviction() {
    // A single shard sized so that one, but not two, of these resource keys fit.
    let cache = IdentityCache::new(1, 2048, 8192);
    let mut a = cases::single_resource(cases::single_gauge_resource(vec![cases::number(
        Some(recount_telemetry_schema::metrics::number_data_point::Value::AsInt(7)),
        cases::raw().received_unix_nano,
    )]));
    a.security.as_mut().unwrap().project_id = "a".repeat(120);
    let mut b = a.clone();
    b.security.as_mut().unwrap().project_id = "b".repeat(120);
    let first = parity(&a, &cache);
    let warm = parity(&a, &cache);
    assert!(Arc::ptr_eq(
        first[0].metadata.as_ref().unwrap(),
        warm[0].metadata.as_ref().unwrap()
    ));
    let tenant_b = parity(&b, &cache);
    let rebuilt = parity(&a, &cache);
    assert_ne!(first[0].frame.series_id, tenant_b[0].frame.series_id);
    assert_ne!(first[0].frame.stream_id, tenant_b[0].frame.stream_id);
    assert_eq!(
        first[0].frame.encode_to_vec(),
        rebuilt[0].frame.encode_to_vec()
    );
    assert!(!Arc::ptr_eq(
        first[0].metadata.as_ref().unwrap(),
        rebuilt[0].metadata.as_ref().unwrap()
    ));
}

#[test]
fn warm_cache_still_applies_retained_limits() {
    let cache = IdentityCache::default();
    let raw = cases::raw();
    let points = parity(&raw, &cache);
    let bytes = raw.encode_to_vec();
    let key = identity::raw_routing_key(&raw).unwrap();
    for limits in [
        Limits {
            points: points.len() - 1,
            ..Limits::default()
        },
        Limits {
            attributes_per_set: 1,
            ..Limits::default()
        },
        Limits {
            normalized_record_bytes: 32,
            ..Limits::default()
        },
        Limits {
            normalized_record_bytes: 4096,
            normalized_batch_bytes: 4096,
            ..Limits::default()
        },
    ] {
        assert_eq!(
            prepare_rows(&bytes, Some(&key), limits).unwrap_err(),
            prepare_cached_rows(&bytes, Some(&key), limits, &cache)
                .err()
                .unwrap(),
        );
    }
}

#[test]
fn collector_replay_working_set_stays_cached() {
    let cache = IdentityCache::default();
    let mut fixture = collector();
    let sources: Vec<_> = (0..24)
        .map(|source| {
            fixture.security.as_mut().unwrap().source_id = format!("replay-source-{source}");
            (
                fixture.encode_to_vec(),
                identity::raw_routing_key(&fixture).unwrap(),
            )
        })
        .collect();
    let load = || {
        sources
            .iter()
            .flat_map(|(bytes, key)| {
                prepare_cached_rows(bytes, Some(key), Limits::default(), &cache)
                    .unwrap()
                    .into_iter()
                    .map(|point| point.metadata.unwrap())
            })
            .collect::<Vec<_>>()
    };
    let first = load();
    let warm = load();
    let reused = first
        .iter()
        .zip(&warm)
        .filter(|(a, b)| Arc::ptr_eq(a, b))
        .count();
    assert_eq!(reused, first.len(), "collector working set cache hits");
}
