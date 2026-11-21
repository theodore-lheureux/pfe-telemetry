use prost::{
    Message,
    encoding::{WireType, encode_key, encode_varint},
};
use recount_normalizer::prepare;
use recount_telemetry_schema::{identity, wire::AnalyticalPoint};
use recount_telemetry_validation::{Category, validate::Limits};

#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;

#[test]
fn effective_body_limits_need_matching_configured_transport_headroom() {
    let mut config = recount_normalizer::config::Config::from_env().unwrap();
    config.limits.decoded_bytes = 8 * 1024 * 1024;
    assert!(config.validate_transport().is_err());
    config.raw_broker_max_bytes = config.limits.decoded_bytes + 65536;
    assert!(config.validate_transport().is_ok());
    config.limits.normalized_record_bytes = 2 * 1024 * 1024;
    assert!(config.validate_transport().is_err());
    config.normalized_broker_max_bytes = config.limits.normalized_record_bytes
        + prost::length_delimiter_len(config.limits.normalized_record_bytes)
        + 65536;
    assert!(config.validate_transport().is_ok());
    config.normalized_broker_max_bytes -= 1;
    assert!(config.validate_transport().is_err());
}

#[test]
fn partial_output_replay_keeps_one_faithful_point_per_record_and_identical_ids() {
    let raw = cases::raw();
    let key = identity::raw_routing_key(&raw).unwrap();
    let body = raw.encode_to_vec();
    let first = prepare(&body, Some(&key), 3, Limits::default()).unwrap();
    let replay = prepare(&body, Some(&key), 3, Limits::default()).unwrap();
    assert_eq!(first.len(), 15);
    for (a, b) in first.iter().zip(&replay) {
        let row = AnalyticalPoint::decode(a.payload.as_slice()).unwrap();
        assert_eq!(
            a.partition,
            identity::partition(row.stream_id.as_slice(), 3).unwrap()
        );
        assert_eq!(a.partition, b.partition);
        assert_eq!(a.payload, b.payload);
        assert!(a.payload.len() <= Limits::default().normalized_record_bytes);
    }
    // Repartitioning does not invent new sample identities after ambiguous output.
    let other = prepare(&body, Some(&key), 4, Limits::default()).unwrap();
    for (a, b) in first.iter().zip(other) {
        assert_eq!(
            AnalyticalPoint::decode(a.payload.as_slice()).unwrap(),
            AnalyticalPoint::decode(b.payload.as_slice()).unwrap()
        );
    }
}

#[test]
fn retained_boundary_rejects_wire_key_authority_kind_and_size_before_publication() {
    let mut raw = cases::raw();
    let key = identity::raw_routing_key(&raw).unwrap();
    let body = raw.encode_to_vec();
    for key in [None, Some([0_u8; 32].as_slice())] {
        assert_eq!(
            prepare(&body, key, 3, Limits::default())
                .unwrap_err()
                .category,
            Category::Poison
        );
    }
    let limits = Limits {
        decoded_bytes: body.len() - 1,
        ..Limits::default()
    };
    assert!(prepare(&body, Some(&key), 3, limits).is_err());
    assert!(prepare(&[0xff], Some(&key), 3, Limits::default()).is_err());
    raw.bindings[0].context.as_mut().unwrap().access = None;
    assert!(prepare(&raw.encode_to_vec(), Some(&key), 3, Limits::default()).is_err());
    raw = cases::raw();
    raw.payload_kind = 0;
    let key = identity::raw_routing_key(&raw).unwrap();
    assert!(prepare(&raw.encode_to_vec(), Some(&key), 3, Limits::default()).is_err());
}

#[test]
fn forwarded_otlp_normalizes_like_reencoded_otlp_and_counts_retained_bytes() {
    let mut raw = cases::raw();
    let key = identity::raw_routing_key(&raw).unwrap();
    let canonical = raw.encode_to_vec();
    let mut forwarded = Vec::new();
    encode_key(99, WireType::Varint, &mut forwarded);
    encode_varint(1, &mut forwarded);
    forwarded.extend_from_slice(&raw.otlp_request);
    raw.otlp_request = forwarded;
    let retained = raw.encode_to_vec();
    let limits = Limits {
        decoded_bytes: retained.len(),
        ..Limits::default()
    };
    let normalize = |bytes| {
        prepare(bytes, Some(&key), 3, limits)
            .unwrap()
            .into_iter()
            .map(|record| (record.partition, record.payload))
            .collect::<Vec<_>>()
    };
    assert_eq!(normalize(&canonical), normalize(&retained));
    let smaller = Limits {
        decoded_bytes: retained.len() - 1,
        ..limits
    };
    assert!(prepare(&canonical, Some(&key), 3, smaller).is_ok());
    assert_eq!(
        prepare(&retained, Some(&key), 3, smaller)
            .unwrap_err()
            .category,
        Category::Poison
    );
}
