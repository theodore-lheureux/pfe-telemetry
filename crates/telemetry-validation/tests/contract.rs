#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::{
        AnyValue, ArrayValue, InstrumentationScope, KeyValue, KeyValueList,
        any_value::Value as Attribute,
    },
    identity,
    metrics::{self, metric::Data, number_data_point::Value},
    point, projection,
    resource::Resource,
    wire::*,
};
use recount_telemetry_validation::{
    self as validation, Category,
    catalogue::Adapter,
    metadata,
    policy::{self, BoundGrant, RootGrant},
    validate::{self, Limits},
};
use sha2::{Digest, Sha256};

#[test]
fn changing_delivery_observations_preserves_sample_and_stream_identity_and_replay_evidence() {
    let mut raw = cases::reader_raw();
    let original = validate::raw(&raw, Limits::default()).unwrap();
    raw.delivery = Some(DeliveryObservation {
        ingestion_peer_address: Some("192.0.2.1:42000".into()),
        collector: None,
    });
    let observed = validate::retained_raw(&raw, Limits::default()).unwrap();
    for (before, after) in original.iter().zip(&observed) {
        assert_eq!(before.sample_id, after.sample_id);
        assert_eq!(before.stream_id, after.stream_id);
        assert_eq!(
            PointLineage::decode(after.lineage.as_slice())
                .unwrap()
                .delivery
                .unwrap()
                .ingestion_peer_address,
            raw.delivery.as_ref().unwrap().ingestion_peer_address
        );
    }
    raw.delivery.as_mut().unwrap().ingestion_peer_address = Some("198.51.100.1:43000".into());
    let reconnected = validate::raw(&raw, Limits::default()).unwrap();
    assert!(
        reconnected
            .iter()
            .zip(&observed)
            .all(|(a, b)| a.sample_id == b.sample_id && a.stream_id == b.stream_id)
    );
    raw.delivery.as_mut().unwrap().ingestion_peer_address = Some("invalid-ip".into());
    assert_eq!(
        validate::retained_raw(&raw, Limits::default())
            .unwrap_err()
            .category,
        Category::Poison
    );
}

#[test]
fn point_lineage_keeps_socket_interface_context_without_repeating_the_full_inventory() {
    let mut raw = cases::reader_raw();
    let collector = CollectorConnection {
        connection_id: "connection-one".into(),
        connected_unix_nano: 1,
        local_address: "10.0.0.2:42000".into(),
        peer_address: "10.0.0.1:4317".into(),
        inventory_observed_unix_nano: 2,
        hostname: Some("node-one".into()),
        architecture: "aarch64".into(),
        inventory_status: "complete".into(),
        interfaces: vec![
            NetworkInterface {
                name: "eth0".into(),
                mac_address: Some("02:00:00:00:00:01".into()),
                addresses: vec!["10.0.0.2".into(), "2001:db8::2".into()],
                up: true,
                ..Default::default()
            },
            NetworkInterface {
                name: "eth1".into(),
                addresses: vec!["192.0.2.1".into()],
                up: true,
                ..Default::default()
            },
        ],
        local_interface_names: vec!["eth0".into()],
        ..Default::default()
    };
    raw.delivery = Some(DeliveryObservation {
        collector: Some(collector.clone()),
        ingestion_peer_address: Some("198.51.100.1:53000".into()),
    });
    let original = raw.encode_to_vec();
    let rows = validate::raw(&raw, Limits::default()).unwrap();
    let context = PointLineage::decode(rows[0].lineage.as_slice())
        .unwrap()
        .delivery
        .unwrap();
    assert_eq!(context.local_interfaces.len(), 1);
    assert_eq!(context.local_interfaces[0].name, "eth0");
    assert_eq!(
        context.local_interfaces[0].mac_address,
        collector.interfaces[0].mac_address
    );
    assert_eq!(context.local_interfaces[0].addresses, ["10.0.0.2"]);
    assert_eq!(context.collector_hostname, collector.hostname);
    assert_eq!(raw.encode_to_vec(), original);
    assert_eq!(
        RawRecord::decode(original.as_slice())
            .unwrap()
            .delivery
            .unwrap()
            .collector
            .unwrap()
            .interfaces
            .len(),
        2
    );
}

#[test]
fn analytical_wire_bytes_match_independent_known_vectors() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/telemetry/analytical-vectors.json"
    ))
    .unwrap();
    for (name, raw) in [
        ("all-kinds", cases::reader_raw()),
        ("ordinary-cpu-process", cases::ordinary_cpu_process()),
    ] {
        let rows = validate::raw(&raw, Limits::default()).unwrap();
        let expected = vectors[name].as_array().unwrap();
        assert_eq!(rows.len(), expected.len());
        for (index, (row, expected)) in rows.iter().zip(expected).enumerate() {
            assert_eq!(
                identity::hex(&Sha256::digest(projection::serialize(row))),
                expected.as_str().unwrap(),
                "{name} row {index}"
            );
        }
    }
}

#[test]
fn admission_preflight_and_retained_replay_share_exact_rows_and_bounds() {
    let mut request = cases::reader_request();
    cases::gauge_mut(&mut request, "integer.extremes").data_points[0].value =
        Some(Value::AsDouble(-0.0));
    let histogram = cases::histogram_mut(&mut request);
    histogram.data_points[1].sum = Some(-0.0);
    histogram.data_points[1].min = Some(-0.0);
    histogram.data_points[1].max = Some(-0.0);
    let Some(Data::ExponentialHistogram(exponential)) =
        &mut cases::metric_mut(&mut request, "exponential").data
    else {
        panic!("exponential fixture")
    };
    exponential.data_points[1].zero_threshold = -0.0;
    let Some(Data::Summary(summary)) = &mut cases::metric_mut(&mut request, "summary").data else {
        panic!("summary fixture")
    };
    summary.data_points[0].sum = -0.0;
    summary.data_points[0].quantile_values[0].quantile = -0.0;
    summary.data_points[0].quantile_values[0].value = -0.0;
    let mut raw = cases::raw();
    raw.otlp_request = request.encode_to_vec();
    validate::request(&request, Limits::default()).unwrap();
    let admission = validate::preflight(&raw, &request, Limits::default()).unwrap();
    let replay = validate::retained_raw(&raw, Limits::default()).unwrap();
    assert_eq!(
        admission
            .iter()
            .map(projection::serialize)
            .collect::<Vec<_>>(),
        replay.iter().map(projection::serialize).collect::<Vec<_>>()
    );
    let histogram = admission
        .iter()
        .filter(|r| r.metric_name == "distribution")
        .nth(1)
        .unwrap();
    for value in [histogram.sum, histogram.min, histogram.max] {
        assert_eq!(value.map(f64::to_bits), Some((-0.0f64).to_bits()));
    }
    let summary = admission
        .iter()
        .find(|r| r.metric_name == "summary")
        .unwrap();
    assert_eq!(summary.sum.map(f64::to_bits), Some(0.0f64.to_bits()));
    assert_eq!(summary.quantiles[0].to_bits(), 0.0f64.to_bits());
    assert_eq!(summary.quantile_values[0].to_bits(), 0.0f64.to_bits());
    let max_record = admission.iter().map(Message::encoded_len).max().unwrap();
    let total = admission.iter().map(Message::encoded_len).sum::<usize>();
    for limits in [
        Limits {
            normalized_record_bytes: max_record - 1,
            ..Default::default()
        },
        Limits {
            normalized_record_bytes: max_record,
            normalized_batch_bytes: total - 1,
            ..Default::default()
        },
        Limits {
            decoded_bytes: raw.encoded_len() - 1,
            ..Default::default()
        },
    ] {
        assert_eq!(
            validate::preflight(&raw, &request, limits)
                .unwrap_err()
                .category,
            Category::Limit
        );
        assert_eq!(
            validate::retained_raw(&raw, limits).unwrap_err().category,
            Category::Poison
        );
    }
    let mut invalid = request.clone();
    cases::gauge_mut(&mut invalid, "integer.extremes").data_points[0].value =
        Some(Value::AsDouble(f64::NAN));
    raw.otlp_request = invalid.encode_to_vec();
    assert_eq!(
        validate::retained_raw(&raw, Limits::default())
            .unwrap_err()
            .category,
        Category::Poison
    );
    raw.otlp_request = vec![0xff];
    assert_eq!(
        validate::retained_raw(&raw, Limits::default())
            .unwrap_err()
            .category,
        Category::Poison
    );
}

#[test]
fn every_kind_lowers_original_observations_and_authorized_context_to_sql_fields() {
    let raw = cases::reader_raw();
    let original = cases::reader_request();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(points.len(), 15);
    for row in &points {
        let lineage = PointLineage::decode(row.lineage.as_slice()).unwrap();
        let pos = lineage.original.as_ref().unwrap();
        let r = &original.resource_metrics[pos.resource as usize];
        let s = &r.scope_metrics[pos.scope as usize];
        let metric = &s.metrics[pos.metric as usize];
        let observation = point::observations(metric)[pos.point as usize];
        let context = raw.bindings[pos.resource as usize]
            .context
            .as_ref()
            .unwrap();
        let reference = context.resource.as_ref().unwrap();
        let resource = r.resource.clone().unwrap_or_default();
        let scope = s.scope.clone().unwrap_or_default();
        assert_eq!(row.project_id, raw.security.as_ref().unwrap().project_id);
        assert_eq!(row.source_id, raw.security.as_ref().unwrap().source_id);
        assert_eq!(row.resource_id, reference.id);
        assert_eq!(row.resource_kind, reference.kind);
        assert_eq!(row.host_id, context.host_id);
        assert_eq!(row.device_id, context.device_id);
        assert_eq!(row.resource_present, r.resource.is_some());
        assert_eq!(row.scope_present, s.scope.is_some());
        assert_eq!(
            row.resource_attributes,
            projection::attributes(&resource.attributes).unwrap()
        );
        assert_eq!(
            row.scope_attributes,
            projection::attributes(&scope.attributes).unwrap()
        );
        assert_eq!(
            row.point_attributes,
            projection::attributes(observation.attributes()).unwrap()
        );
        assert_eq!(
            row.metric_metadata,
            projection::attributes(&metric.metadata).unwrap()
        );
        assert_eq!(row.scope_name, scope.name);
        assert_eq!(row.scope_version, scope.version);
        assert_eq!(row.resource_schema_url, r.schema_url);
        assert_eq!(row.scope_schema_url, s.schema_url);
        assert_eq!(row.metric_name, metric.name);
        assert_eq!(row.unit, metric.unit);
        assert_eq!(row.time_unix_nano, observation.time());
        assert_eq!(row.start_time_unix_nano, observation.start());
        assert_eq!(
            row.event_day,
            (observation.time() / 86_400_000_000_000) as u32
        );
        assert_eq!(row.flags, observation.flags());
        assert_eq!(row.sample_id, identity::sample_id(&raw, pos).unwrap());
        assert_eq!(row.description, metric.description);
        assert_eq!(
            row.resource_dropped_attributes_count,
            resource.dropped_attributes_count
        );
        assert_eq!(
            row.scope_dropped_attributes_count,
            scope.dropped_attributes_count
        );
        assert_eq!(
            row.resource_entity_refs,
            resource
                .entity_refs
                .iter()
                .map(Message::encode_to_vec)
                .collect::<Vec<_>>()
        );
        let exemplars = match observation {
            point::Observation::Number(p) => {
                let (int, double) = match p.value {
                    Some(Value::AsInt(v)) => (Some(v), None),
                    Some(Value::AsDouble(v)) => (None, Some(v)),
                    None => (None, None),
                };
                assert_eq!(row.int_value, int);
                assert_eq!(row.double_value.map(f64::to_bits), double.map(f64::to_bits));
                match metric.data.as_ref().unwrap() {
                    Data::Gauge(_) => {
                        assert_eq!(row.metric_kind, MetricKind::Gauge as i32);
                        assert_eq!(row.monotonic, None);
                        assert_eq!(row.temporality, 0);
                    }
                    Data::Sum(sum) => {
                        assert_eq!(row.metric_kind, MetricKind::Sum as i32);
                        assert_eq!(row.monotonic, Some(sum.is_monotonic));
                        assert_eq!(row.temporality, sum.aggregation_temporality);
                    }
                    _ => panic!("expected number metric"),
                }
                &p.exemplars
            }
            point::Observation::Histogram(p) => {
                assert_eq!(row.metric_kind, MetricKind::Histogram as i32);
                assert_eq!(row.count, Some(p.count));
                assert_eq!(row.sum, p.sum);
                assert_eq!(row.min, p.min);
                assert_eq!(row.max, p.max);
                assert_eq!(row.explicit_bounds, p.explicit_bounds);
                assert_eq!(row.bucket_counts, p.bucket_counts);
                let Some(Data::Histogram(histogram)) = &metric.data else {
                    panic!("histogram fixture")
                };
                assert_eq!(row.temporality, histogram.aggregation_temporality);
                &p.exemplars
            }
            point::Observation::Exponential(p) => {
                assert_eq!(row.metric_kind, MetricKind::ExponentialHistogram as i32);
                assert_eq!(row.count, Some(p.count));
                assert_eq!(row.sum, p.sum);
                assert_eq!(row.min, p.min);
                assert_eq!(row.max, p.max);
                assert_eq!(row.scale, Some(p.scale));
                assert_eq!(row.zero_count, Some(p.zero_count));
                assert_eq!(row.zero_threshold, Some(p.zero_threshold));
                assert_eq!(row.positive_offset, p.positive.as_ref().map(|b| b.offset));
                assert_eq!(row.negative_offset, p.negative.as_ref().map(|b| b.offset));
                assert_eq!(
                    row.positive_counts,
                    p.positive.as_ref().map_or(&[][..], |b| &b.bucket_counts)
                );
                assert_eq!(
                    row.negative_counts,
                    p.negative.as_ref().map_or(&[][..], |b| &b.bucket_counts)
                );
                let Some(Data::ExponentialHistogram(histogram)) = &metric.data else {
                    panic!("exponential fixture")
                };
                assert_eq!(row.temporality, histogram.aggregation_temporality);
                &p.exemplars
            }
            point::Observation::Summary(p) => {
                assert_eq!(row.metric_kind, MetricKind::Summary as i32);
                assert_eq!(row.count, Some(p.count));
                assert_eq!(row.sum, Some(p.sum));
                assert_eq!(
                    row.quantiles,
                    p.quantile_values
                        .iter()
                        .map(|v| v.quantile)
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    row.quantile_values,
                    p.quantile_values
                        .iter()
                        .map(|v| v.value)
                        .collect::<Vec<_>>()
                );
                &[][..]
            }
        };
        assert_eq!(
            row.exemplars,
            exemplars
                .iter()
                .map(Message::encode_to_vec)
                .collect::<Vec<_>>()
        );
        assert_eq!(lineage.access, context.access);
        assert_eq!(lineage.relationships, context.relationships);
        assert_eq!(lineage.batch, raw.batch);
        assert_eq!(lineage.record_id, raw.record_id);
        assert_eq!(lineage.received_unix_nano, raw.received_unix_nano);
        assert_eq!(lineage.payload_kind, raw.payload_kind);
    }
    assert_eq!(points[0].int_value, Some(i64::MIN));
    assert_eq!(points[1].int_value, Some(i64::MAX));
    assert_eq!(points[1].time_unix_nano, u64::MAX);
    assert_eq!(points[2].double_value, Some(-12.5));
    assert_eq!(points[3].flags, 1);
    assert_eq!((points[3].int_value, points[3].double_value), (None, None));
    assert_eq!(points[11].time_unix_nano, 1_780_000_000_000_000_123);
    let sensor = points.iter().find(|p| p.resource_id == "sensor-a").unwrap();
    assert!(sensor.host_id.is_none());
    assert!(
        PointLineage::decode(sensor.lineage.as_slice())
            .unwrap()
            .relationships
            .is_empty()
    );
}

#[test]
fn signed_zero_scalar_survives_lowering_and_bare_serialization() {
    let raw = cases::reader_raw();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    let original = points
        .iter()
        .find(|p| p.metric_name == "DCGM_FI_PROF_SM_ACTIVE")
        .unwrap();
    assert_eq!(
        original.double_value.map(f64::to_bits),
        Some((-0.0f64).to_bits())
    );
    let encoded = projection::serialize(original);
    assert_eq!(
        AnalyticalPoint::decode(encoded.as_slice())
            .unwrap()
            .double_value
            .map(f64::to_bits),
        Some((-0.0f64).to_bits())
    );
}

#[test]
fn immutable_identity_survives_receipts_rotation_but_not_original_position() {
    let mut raw = cases::raw();
    let first = validate::raw(&raw, Limits::default()).unwrap();
    let key = identity::raw_routing_key(&raw).unwrap();
    raw.record_id = "new-receipt".into();
    raw.received_unix_nano += 2 * 86_400_000_000_000;
    let retry = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(key, identity::raw_routing_key(&raw).unwrap());
    for (a, b) in first.iter().zip(&retry) {
        assert_eq!(a.sample_id, b.sample_id);
        assert_eq!(a.stream_id, b.stream_id);
        assert_eq!(a.event_day, b.event_day);
    }
    let ids: std::collections::BTreeSet<_> = first.iter().map(|p| p.sample_id.clone()).collect();
    assert_eq!(ids.len(), first.len());
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/telemetry/identity.json"
    ))
    .unwrap();
    assert_eq!(
        identity::hex(&first[0].sample_id),
        golden["sample_id"].as_str().unwrap()
    );
    let records = point::kafka_records(&first, 8, 1024 * 1024).unwrap();
    assert_eq!(records.len(), first.len());
    for record in records {
        AnalyticalPoint::decode(record.payload.as_slice()).unwrap();
        assert!(record.payload.len() <= 1024 * 1024);
        assert!(record.partition < 8);
    }
    assert_ne!(first[4].stream_id, first[5].stream_id);
    raw.batch = None;
    let without_batch = validate::raw(&raw, Limits::default()).unwrap();
    raw.record_id = "independent-submission".into();
    assert_ne!(
        without_batch[0].sample_id,
        validate::raw(&raw, Limits::default()).unwrap()[0].sample_id
    );
    raw.security.as_mut().unwrap().source_id = "other-principal".into();
    assert_ne!(
        without_batch[0].sample_id,
        validate::raw(&raw, Limits::default()).unwrap()[0].sample_id
    );
    // Credential IDs deliberately do not exist in the raw identity schema.
    let partitions: std::collections::BTreeSet<_> = (0..100)
        .map(|i| {
            raw.batch = Some(BatchIdentity {
                client_id: format!("batch-{i}"),
                created_unix_nano: 1,
            });
            identity::partition(&identity::raw_routing_key(&raw).unwrap(), 8).unwrap()
        })
        .collect();
    assert!(partitions.len() > 1);
}

#[test]
fn canonical_attribute_maps_are_typed_and_order_independent_not_arrays() {
    let mut attrs = cases::attributes();
    let canonical = identity::canonical_attributes(&attrs).unwrap();
    let mut projected = projection::attributes(&attrs).unwrap();
    attrs.reverse();
    assert_eq!(canonical, identity::canonical_attributes(&attrs).unwrap());
    let mut reordered = projection::attributes(&attrs).unwrap();
    assert_ne!(projected[0].path, reordered[0].path);
    projected.sort_by(|a, b| a.path.cmp(&b.path));
    reordered.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(projected, reordered);
    assert_ne!(
        identity::canonical_attributes(&[cases::attr("n", Attribute::IntValue(1))]).unwrap(),
        identity::canonical_attributes(&[cases::attr("n", Attribute::StringValue("1".into()))])
            .unwrap()
    );
    attrs.push(attrs[0].clone());
    assert!(identity::canonical_attributes(&attrs).is_err());
    let mut array = cases::attr(
        "array",
        Attribute::ArrayValue(recount_telemetry_schema::common::ArrayValue {
            values: vec![
                recount_telemetry_schema::common::AnyValue {
                    value: Some(Attribute::IntValue(1)),
                },
                recount_telemetry_schema::common::AnyValue {
                    value: Some(Attribute::IntValue(2)),
                },
            ],
        }),
    );
    let ordered = identity::canonical_attributes(&[array.clone()]).unwrap();
    let Some(Attribute::ArrayValue(values)) = &mut array.value.as_mut().unwrap().value else {
        panic!("array fixture")
    };
    values.values.reverse();
    assert_ne!(ordered, identity::canonical_attributes(&[array]).unwrap());
    assert_ne!(
        identity::canonical_attributes(&[cases::attr("zero", Attribute::DoubleValue(-0.0))])
            .unwrap(),
        identity::canonical_attributes(&[cases::attr("zero", Attribute::DoubleValue(0.0))])
            .unwrap()
    );
}

fn attribute_request(attributes: Vec<KeyValue>) -> ExportMetricsServiceRequest {
    ExportMetricsServiceRequest {
        resource_metrics: vec![cases::single_gauge_resource(vec![
            metrics::NumberDataPoint {
                attributes,
                ..cases::number(Some(Value::AsInt(1)), 1)
            },
        ])],
    }
}

#[test]
fn attribute_invariants_reject_nested_duplicates_dictionary_indexes_and_nonfinite_values() {
    let mut dictionary_key = cases::attr("dictionary", Attribute::IntValue(1));
    dictionary_key.key_strindex = 1;
    for (name, attrs) in [
        ("empty key", vec![cases::attr("", Attribute::IntValue(1))]),
        (
            "duplicate key",
            vec![
                cases::attr("same", Attribute::IntValue(1)),
                cases::attr("same", Attribute::IntValue(2)),
            ],
        ),
        (
            "nested duplicate",
            vec![cases::attr(
                "nested",
                Attribute::KvlistValue(KeyValueList {
                    values: vec![
                        cases::attr("same", Attribute::IntValue(1)),
                        cases::attr("same", Attribute::IntValue(2)),
                    ],
                }),
            )],
        ),
        ("dictionary key", vec![dictionary_key]),
        (
            "dictionary string",
            vec![cases::attr("dictionary", Attribute::StringValueStrindex(1))],
        ),
        (
            "nested nonfinite",
            vec![cases::attr(
                "nested",
                Attribute::KvlistValue(KeyValueList {
                    values: vec![cases::attr("value", Attribute::DoubleValue(f64::NAN))],
                }),
            )],
        ),
    ] {
        assert!(identity::canonical_attributes(&attrs).is_err(), "{name}");
        assert!(projection::attributes(&attrs).is_err(), "{name}");
        assert_eq!(
            validate::request(&attribute_request(attrs), Limits::default())
                .unwrap_err()
                .category,
            Category::Invalid,
            "{name}"
        );
    }
}

#[test]
fn attribute_budgets_count_recursive_and_absent_nodes_and_exact_utf8_bytes() {
    for adjustment in [0, 1] {
        let arrays = vec![cases::attr(
            "array",
            Attribute::ArrayValue(ArrayValue {
                values: vec![AnyValue::default(); 127 + adjustment],
            }),
        )];
        let missing = vec![cases::attr(
            "map",
            Attribute::KvlistValue(KeyValueList {
                values: (0..127 + adjustment)
                    .map(|i| KeyValue {
                        key: format!("key-{i}"),
                        ..Default::default()
                    })
                    .collect(),
            }),
        )];
        let key = vec![cases::attr(
            &"é".repeat(64 + adjustment),
            Attribute::IntValue(1),
        )];
        let string = vec![cases::attr(
            "text",
            Attribute::StringValue("é".repeat(32768 + adjustment)),
        )];
        let bytes = vec![cases::attr(
            "bytes",
            Attribute::BytesValue(vec![0; 65536 + adjustment]),
        )];
        let mut nested = AnyValue::default();
        for _ in 0..16 + adjustment {
            nested = AnyValue {
                value: Some(Attribute::ArrayValue(ArrayValue {
                    values: vec![nested],
                })),
            };
        }
        let depth = vec![KeyValue {
            key: "nested".into(),
            value: Some(nested),
            ..Default::default()
        }];
        for (name, attrs) in [
            ("array count", arrays),
            ("absent map entries", missing),
            ("key bytes", key),
            ("string bytes", string),
            ("value bytes", bytes),
            ("depth", depth),
        ] {
            let result = validate::request(&attribute_request(attrs), Limits::default());
            if adjustment == 0 {
                assert_eq!(result.unwrap(), 1, "{name}");
            } else {
                assert_eq!(result.unwrap_err().category, Category::Limit, "{name}");
            }
        }
    }
}

#[test]
fn absent_and_empty_otlp_resource_and_scope_are_distinct_analytical_presence() {
    let mut request = attribute_request(vec![]);
    let mut raw = cases::single_resource(request.resource_metrics[0].clone());
    let absent = validate::raw(&raw, Limits::default()).unwrap().remove(0);
    request.resource_metrics[0].resource = Some(Default::default());
    request.resource_metrics[0].scope_metrics[0].scope = Some(Default::default());
    raw.otlp_request = request.encode_to_vec();
    let empty = validate::raw(&raw, Limits::default()).unwrap().remove(0);
    assert_eq!(
        (absent.resource_present, absent.scope_present),
        (false, false)
    );
    assert_eq!((empty.resource_present, empty.scope_present), (true, true));
    assert_eq!(absent.sample_id, empty.sample_id);
    assert_eq!(absent.stream_id, empty.stream_id);
    assert_ne!(
        projection::serialize(&absent),
        projection::serialize(&empty)
    );
}

#[test]
fn empty_decoded_containers_consume_the_existing_expanded_budget() {
    let resources = ExportMetricsServiceRequest {
        resource_metrics: vec![metrics::ResourceMetrics::default(); 5],
    };
    let scopes = ExportMetricsServiceRequest {
        resource_metrics: vec![metrics::ResourceMetrics {
            scope_metrics: vec![metrics::ScopeMetrics::default(); 5],
            ..Default::default()
        }],
    };
    let empty_metric = metrics::Metric {
        name: "empty".into(),
        data: Some(Data::Gauge(metrics::Gauge::default())),
        ..Default::default()
    };
    let metrics = ExportMetricsServiceRequest {
        resource_metrics: vec![metrics::ResourceMetrics {
            scope_metrics: vec![metrics::ScopeMetrics {
                metrics: vec![empty_metric; 5],
                ..Default::default()
            }],
            ..Default::default()
        }],
    };
    for (request, containers) in [(resources, 5), (scopes, 6), (metrics, 7)] {
        assert!(request.encoded_len() < 1024);
        assert_eq!(
            validate::request(
                &request,
                Limits {
                    expanded_items: containers,
                    ..Default::default()
                }
            )
            .unwrap(),
            0
        );
        assert_eq!(
            validate::request(
                &request,
                Limits {
                    expanded_items: containers - 1,
                    ..Default::default()
                }
            )
            .unwrap_err()
            .category,
            Category::Limit
        );
    }
}

#[test]
fn absent_attribute_nodes_obey_the_shared_depth_limit() {
    for depth in [16, 17] {
        let mut absent = KeyValue {
            key: "absent".into(),
            ..Default::default()
        };
        for _ in 0..depth {
            absent = cases::attr(
                "nested",
                Attribute::KvlistValue(KeyValueList {
                    values: vec![absent],
                }),
            );
        }
        let attrs = vec![absent];
        assert_eq!(identity::canonical_attributes(&attrs).is_ok(), depth == 16);
        assert_eq!(projection::attributes(&attrs).is_ok(), depth == 16);
        let empty_resource = metrics::ResourceMetrics {
            resource: Some(Resource {
                attributes: attrs.clone(),
                ..Default::default()
            }),
            ..Default::default()
        };
        for (request, points) in [
            (attribute_request(attrs), 1),
            (
                ExportMetricsServiceRequest {
                    resource_metrics: vec![empty_resource],
                },
                0,
            ),
        ] {
            let raw = cases::single_resource(request.resource_metrics[0].clone());
            let checked = validate::request(&request, Limits::default());
            let lowered = validate::raw(&raw, Limits::default());
            if depth == 16 {
                assert_eq!(checked.unwrap(), points);
                assert_eq!(lowered.unwrap().len(), points);
            } else {
                assert_eq!(checked.unwrap_err().category, Category::Limit);
                assert_eq!(lowered.unwrap_err().category, Category::Limit);
                assert_eq!(
                    validate::retained_raw(&raw, Limits::default())
                        .unwrap_err()
                        .category,
                    Category::Poison
                );
            }
        }
    }
}

#[test]
fn empty_containers_do_not_renumber_later_observations() {
    let attrs = cases::attributes();
    let empty_resource = metrics::ResourceMetrics {
        resource: Some(Resource {
            attributes: attrs.clone(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut live_resource =
        cases::single_gauge_resource(vec![cases::number(Some(Value::AsInt(1)), 1)]);
    let live_scope = &mut live_resource.scope_metrics[0];
    let mut empty_metric = live_scope.metrics[0].clone();
    empty_metric.data = Some(Data::Gauge(metrics::Gauge::default()));
    empty_metric.metadata = attrs.clone();
    live_scope.metrics.insert(0, empty_metric);
    live_resource.scope_metrics.insert(
        0,
        metrics::ScopeMetrics {
            scope: Some(InstrumentationScope {
                attributes: attrs.clone(),
                ..Default::default()
            }),
            ..Default::default()
        },
    );
    let request = ExportMetricsServiceRequest {
        resource_metrics: vec![empty_resource, live_resource],
    };
    let mut raw = cases::single_resource(request.resource_metrics[0].clone());
    let mut live_binding = raw.bindings[0].clone();
    live_binding.original_resource = 1;
    raw.bindings.push(live_binding);
    raw.otlp_request = request.encode_to_vec();
    assert_eq!(validate::request(&request, Limits::default()).unwrap(), 1);
    let rows = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(rows.len(), 1);
    let original = PointLineage::decode(rows[0].lineage.as_slice())
        .unwrap()
        .original
        .unwrap();
    assert_eq!(
        original,
        Position {
            resource: 1,
            scope: 1,
            metric: 1,
            point: 0
        }
    );
    assert_eq!(
        rows[0].sample_id,
        identity::sample_id(&raw, &original).unwrap()
    );
}

#[test]
fn many_resources_use_original_binding_positions_not_binding_array_order() {
    let resource = cases::single_gauge_resource(vec![cases::number(Some(Value::AsInt(0)), 1)]);
    let mut raw = cases::single_resource(resource.clone());
    let context = raw.bindings[0].context.clone().unwrap();
    raw.bindings.clear();
    let mut request = ExportMetricsServiceRequest::default();
    for index in 0..128u32 {
        let mut resource = resource.clone();
        let Some(Data::Gauge(gauge)) = &mut resource.scope_metrics[0].metrics[0].data else {
            panic!("single gauge fixture")
        };
        gauge.data_points[0].value = Some(Value::AsInt(i64::from(index)));
        request.resource_metrics.push(resource);
        let mut context = context.clone();
        context.resource.as_mut().unwrap().id = format!("resource-{index}");
        context.host_id = None;
        raw.bindings.push(ResourceBinding {
            original_resource: index,
            context: Some(context),
        });
    }
    raw.otlp_request = request.encode_to_vec();
    let ordered = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(ordered.len(), 128);
    raw.bindings.reverse();
    let reversed = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(ordered, reversed);
    for (index, point) in reversed.iter().enumerate() {
        let lineage = PointLineage::decode(point.lineage.as_slice()).unwrap();
        let position = lineage.original.as_ref().unwrap();
        assert_eq!(position.resource, index as u32);
        assert_eq!(point.int_value, Some(index as i64));
        assert_eq!(point.resource_id, format!("resource-{index}"));
        assert_eq!(
            point.sample_id,
            identity::sample_id(&raw, position).unwrap().to_vec()
        );
    }
    let limits = Limits::default();
    let mut duplicate = raw.clone();
    duplicate.bindings[0].original_resource = duplicate.bindings[1].original_resource;
    assert!(
        point::normalize_bounded(
            &duplicate,
            &request,
            limits.points,
            limits.normalized_record_bytes,
            limits.normalized_batch_bytes
        )
        .is_err()
    );
    let mut out_of_range = raw.clone();
    out_of_range.bindings[0].original_resource = 128;
    assert!(
        point::normalize_bounded(
            &out_of_range,
            &request,
            limits.points,
            limits.normalized_record_bytes,
            limits.normalized_batch_bytes
        )
        .is_err()
    );
    raw.bindings.pop();
    assert!(
        point::normalize_bounded(
            &raw,
            &request,
            limits.points,
            limits.normalized_record_bytes,
            limits.normalized_batch_bytes
        )
        .is_err()
    );
}

#[test]
fn rejects_nonfinite_shapes_expansion_and_metadata_heavy_requests_before_acceptance() {
    for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut request = cases::request();
        cases::gauge_mut(&mut request, "integer.extremes").data_points[0].value =
            Some(Value::AsDouble(v));
        assert!(validate::request(&request, Limits::default()).is_err());
    }
    let mut bad = cases::request();
    cases::gauge_mut(&mut bad, "integer.extremes").data_points[0].value = None;
    assert!(validate::request(&bad, Limits::default()).is_err());
    let mut bad = cases::request();
    cases::histogram_mut(&mut bad).data_points[0].max = Some(f64::NAN);
    assert!(validate::request(&bad, Limits::default()).is_err());
    let mut bad = cases::request();
    cases::histogram_mut(&mut bad).data_points[0].count += 1;
    assert!(validate::request(&bad, Limits::default()).is_err());
    let mut bad = cases::request();
    bad.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes = vec![cases::attr("bad", Attribute::DoubleValue(f64::INFINITY))];
    assert!(validate::request(&bad, Limits::default()).is_err());
    let raw = cases::raw();
    assert_eq!(
        validate::raw(
            &raw,
            Limits {
                points: 2,
                ..Default::default()
            }
        )
        .unwrap_err()
        .category,
        Category::Limit
    );
    assert_eq!(
        validate::raw(
            &raw,
            Limits {
                expanded_items: 3,
                ..Default::default()
            }
        )
        .unwrap_err()
        .category,
        Category::Limit
    );
    assert!(
        validate::raw(
            &raw,
            Limits {
                normalized_record_bytes: 100,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        validate::raw(
            &raw,
            Limits {
                normalized_batch_bytes: 1000,
                normalized_record_bytes: 1000,
                ..Default::default()
            }
        )
        .is_err()
    );
    let heavy = cases::metadata_heavy(256);
    assert!(heavy.encoded_len() < 100_000);
    assert_eq!(
        validate::raw(&heavy, Limits::default())
            .unwrap_err()
            .category,
        Category::Limit
    );
    let heavy = cases::metadata_heavy(32);
    let normalized = validate::raw(&heavy, Limits::default()).unwrap();
    assert_eq!(normalized.len(), 32);
}

#[test]
fn exact_byte_limits_use_final_bare_messages_for_records_and_total_output() {
    let mut raw = cases::raw();
    let mut request = cases::request();
    request.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .push(cases::attr(
            "escaping",
            Attribute::StringValue("\"\\\n雪é".into()),
        ));
    raw.otlp_request = request.encode_to_vec();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    let rows: Vec<_> = points.iter().map(projection::serialize).collect();
    let projected = AnalyticalPoint::decode(rows[0].as_slice()).unwrap();
    assert_eq!(
        projected
            .resource_attributes
            .iter()
            .find(|a| a.path == "/escaping")
            .unwrap()
            .string_value
            .as_deref(),
        Some("\"\\\n雪é")
    );
    let row_bytes = rows.iter().map(Vec::len).max().unwrap();
    let total_bytes = rows.iter().map(Vec::len).sum::<usize>();
    let raw_bytes = raw.encoded_len();
    assert!(raw_bytes > raw.otlp_request.len());
    for adjustment in [-1isize, 0, 1] {
        let limits = Limits {
            normalized_record_bytes: row_bytes.checked_add_signed(adjustment).unwrap(),
            ..Default::default()
        };
        assert_eq!(validate::raw(&raw, limits).is_ok(), adjustment >= 0);
        let limits = Limits {
            normalized_batch_bytes: total_bytes.checked_add_signed(adjustment).unwrap(),
            normalized_record_bytes: row_bytes,
            ..Default::default()
        };
        assert_eq!(validate::raw(&raw, limits).is_ok(), adjustment >= 0);
        let limits = Limits {
            decoded_bytes: raw_bytes.checked_add_signed(adjustment).unwrap(),
            ..Default::default()
        };
        assert_eq!(validate::raw(&raw, limits).is_ok(), adjustment >= 0);
    }
    let one = &points[..1];
    let bytes = rows[0].len();
    assert!(point::kafka_records(one, 1, bytes - 1).is_err());
    assert_eq!(
        point::kafka_records(one, 1, bytes).unwrap()[0]
            .payload
            .len(),
        bytes
    );
    assert_eq!(
        point::kafka_records(one, 1, bytes + 1).unwrap()[0]
            .payload
            .len(),
        bytes
    );
    let two_bytes = rows[0].len() + rows[1].len();
    assert_eq!(
        point::kafka_records(&points[..2], 1, two_bytes)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        point::kafka_records(&points[..2], 1, two_bytes - 1)
            .unwrap()
            .len(),
        2
    );
    let grouped = point::kafka_records(&points, 8, row_bytes).unwrap();
    assert_eq!(
        grouped.iter().map(|r| r.payload.len()).sum::<usize>(),
        total_bytes
    );
}

#[test]
fn ordinary_cpu_process_fixture_uses_the_collector_catalogue() {
    let raw = cases::ordinary_cpu_process();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(points.len(), 4);
    let request =
        recount_telemetry_schema::ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice())
            .unwrap();
    for resource in &request.resource_metrics {
        for scope in &resource.scope_metrics {
            for metric in &scope.metrics {
                validation::catalogue::validate_adapter_metric(metric, Adapter::Linux).unwrap();
            }
        }
    }
}

#[test]
fn explicit_grants_fail_closed_and_gateway_is_not_topology_delegation() {
    let raw = cases::raw();
    let scope = raw.security.as_ref().unwrap();
    let requested = policy::requested_authorities(&raw, 5).unwrap();
    assert!(requested.roots.is_empty());
    assert_eq!(requested.independent.len(), 5);
    let granted: Vec<_> = raw
        .bindings
        .iter()
        .map(|b| BoundGrant {
            security: scope.clone(),
            resource: b.context.as_ref().unwrap().resource.clone().unwrap(),
        })
        .collect();
    policy::authorize(scope, &raw, &[], &granted, 5).unwrap();
    assert!(policy::authorize(scope, &raw, &[], &[], 5).is_err());
    assert!(policy::requested_authorities(&raw, 1).is_err());
    let mut other = scope.clone();
    other.project_id = "other".into();
    assert!(policy::authorize(&other, &raw, &[], &granted, 5).is_err());
}

#[test]
fn one_root_grants_supported_local_resources_but_not_other_authorities() {
    const ROOT: usize = 0;
    const GPU: usize = 1;
    const VM: usize = 2;
    const CPU: usize = 3;
    const PROCESS: usize = 4;
    fn local(
        context: &mut ResourceContext,
        project: &str,
        root: &str,
        kind: ResourceKind,
        token: &str,
    ) {
        context.resource = Some(ResourceRef {
            id: identity::local_resource_id(project, root, kind, token).unwrap(),
            kind: kind as i32,
        });
        context.access = Some(ResourceAccess {
            scope: Some(resource_access::Scope::Local(LocalResource {
                root_id: root.into(),
                adapter: "recount.collector.procfs".into(),
                local_incarnation: token.into(),
            })),
        });
    }
    let mut raw = cases::raw();
    let scope = raw.security.clone().unwrap();
    raw.bindings[ROOT].context.as_mut().unwrap().access = Some(ResourceAccess {
        scope: Some(resource_access::Scope::Root(RootScope {})),
    });
    for (index, kind, token) in [
        (GPU, ResourceKind::Gpu, "gpu:0"),
        (CPU, ResourceKind::Cpu, "cpu:1"),
        (PROCESS, ResourceKind::Process, "boot:one/pid:42/start:99"),
    ] {
        local(
            raw.bindings[index].context.as_mut().unwrap(),
            &scope.project_id,
            "node-a",
            kind,
            token,
        );
    }
    let root = RootGrant {
        security: scope.clone(),
        root: raw.bindings[ROOT]
            .context
            .as_ref()
            .unwrap()
            .resource
            .clone()
            .unwrap(),
        adapter: "recount.collector.procfs".into(),
        allowed_local_kinds: [ResourceKind::Cpu, ResourceKind::Gpu, ResourceKind::Process]
            .into_iter()
            .collect(),
    };
    let independent = BoundGrant {
        security: scope.clone(),
        resource: raw.bindings[VM]
            .context
            .as_ref()
            .unwrap()
            .resource
            .clone()
            .unwrap(),
    };
    let requested = policy::requested_authorities(&raw, 2).unwrap();
    assert_eq!(requested.roots.len(), 1);
    assert_eq!(requested.independent.len(), 1);
    policy::authorize(
        &scope,
        &raw,
        std::slice::from_ref(&root),
        std::slice::from_ref(&independent),
        2,
    )
    .unwrap();
    assert!(policy::requested_authorities(&raw, 1).is_err());
    let original = validate::raw(&raw, Limits::default()).unwrap();
    for point in &original {
        let lineage = PointLineage::decode(point.lineage.as_slice()).unwrap();
        assert_eq!(
            lineage.access,
            raw.bindings[lineage.original.unwrap().resource as usize]
                .context
                .as_ref()
                .unwrap()
                .access
        );
    }
    let mut rotated = raw.clone();
    rotated.record_id = "receipt-after-credential-rotation".into();
    policy::authorize(
        &scope,
        &rotated,
        std::slice::from_ref(&root),
        std::slice::from_ref(&independent),
        2,
    )
    .unwrap();
    let retried = validate::raw(&rotated, Limits::default()).unwrap();
    assert_eq!(
        original.iter().map(|p| &p.sample_id).collect::<Vec<_>>(),
        retried.iter().map(|p| &p.sample_id).collect::<Vec<_>>()
    );
    assert_eq!(raw.bindings, rotated.bindings);
    let mut moved = raw.clone();
    let vm = moved.bindings[VM].context.as_mut().unwrap();
    vm.host_id = Some("node-b".into());
    vm.relationships[0].to.as_mut().unwrap().id = "node-b".into();
    policy::authorize(
        &scope,
        &moved,
        std::slice::from_ref(&root),
        std::slice::from_ref(&independent),
        2,
    )
    .unwrap();
    assert_eq!(vm_resource(&raw), vm_resource(&moved));
    fn vm_resource(raw: &RawRecord) -> &ResourceRef {
        raw.bindings[VM]
            .context
            .as_ref()
            .unwrap()
            .resource
            .as_ref()
            .unwrap()
    }
    let mut wrong = raw.clone();
    wrong.bindings[ROOT]
        .context
        .as_mut()
        .unwrap()
        .resource
        .as_mut()
        .unwrap()
        .id = "node-b".into();
    assert!(
        policy::authorize(
            &scope,
            &wrong,
            std::slice::from_ref(&root),
            std::slice::from_ref(&independent),
            3
        )
        .is_err()
    );
    let mut wrong = raw.clone();
    local(
        wrong.bindings[GPU].context.as_mut().unwrap(),
        &scope.project_id,
        "node-b",
        ResourceKind::Gpu,
        "gpu:0",
    );
    assert!(
        policy::authorize(
            &scope,
            &wrong,
            std::slice::from_ref(&root),
            std::slice::from_ref(&independent),
            3
        )
        .is_err()
    );
    let mut wrong = raw.clone();
    local(
        wrong.bindings[GPU].context.as_mut().unwrap(),
        &scope.project_id,
        "node-a",
        ResourceKind::Sensor,
        "sensor:0",
    );
    assert!(
        policy::authorize(
            &scope,
            &wrong,
            std::slice::from_ref(&root),
            std::slice::from_ref(&independent),
            2
        )
        .is_err()
    );
    let mut wrong = raw.clone();
    let Some(resource_access::Scope::Local(local)) = &mut wrong.bindings[GPU]
        .context
        .as_mut()
        .unwrap()
        .access
        .as_mut()
        .unwrap()
        .scope
    else {
        panic!("local GPU fixture")
    };
    local.adapter = "ungranted-adapter".into();
    assert!(
        policy::authorize(
            &scope,
            &wrong,
            std::slice::from_ref(&root),
            std::slice::from_ref(&independent),
            2
        )
        .is_err()
    );
    let mut wrong = raw.clone();
    let context = wrong.bindings[GPU].context.as_mut().unwrap();
    context.resource.as_mut().unwrap().id = "independent-gpu".into();
    context.access = Some(ResourceAccess {
        scope: Some(resource_access::Scope::Bound(BoundScope {})),
    });
    assert!(
        policy::authorize(
            &scope,
            &wrong,
            std::slice::from_ref(&root),
            std::slice::from_ref(&independent),
            3
        )
        .is_err()
    );
    let mut wrong = raw.clone();
    wrong.bindings[GPU]
        .context
        .as_mut()
        .unwrap()
        .resource
        .as_mut()
        .unwrap()
        .id = "node-b".into();
    assert!(policy::requested_authorities(&wrong, 3).is_err());
    let mut root_only = raw.clone();
    root_only.bindings.remove(VM);
    for (index, binding) in root_only.bindings.iter_mut().enumerate() {
        binding.original_resource = index as u32;
    }
    let mut request = recount_telemetry_schema::ExportMetricsServiceRequest::decode(
        root_only.otlp_request.as_slice(),
    )
    .unwrap();
    request.resource_metrics.remove(VM);
    request.resource_metrics[ROOT].resource = None;
    root_only.otlp_request = request.encode_to_vec();
    let authorities = policy::requested_authorities(&root_only, 1).unwrap();
    assert_eq!(authorities.roots.len(), 1);
    assert!(authorities.independent.is_empty());
    policy::authorize(&scope, &root_only, std::slice::from_ref(&root), &[], 1).unwrap();
    validate::raw(&root_only, Limits::default()).unwrap();
    let mut root_without_children = root.clone();
    root_without_children.allowed_local_kinds.clear();
    assert!(
        policy::authorize(
            &scope,
            &root_only,
            std::slice::from_ref(&root_without_children),
            &[],
            1
        )
        .is_err()
    );
    let mut direct = root_only.clone();
    direct.bindings.truncate(1);
    let mut request = recount_telemetry_schema::ExportMetricsServiceRequest::decode(
        direct.otlp_request.as_slice(),
    )
    .unwrap();
    request.resource_metrics.truncate(1);
    direct.otlp_request = request.encode_to_vec();
    policy::authorize(&scope, &direct, &[root_without_children], &[], 1).unwrap();
    validate::raw(&direct, Limits::default()).unwrap();
    let mut other_project = raw.clone();
    other_project.security.as_mut().unwrap().project_id = "other-project".into();
    assert!(
        policy::authorize(
            other_project.security.as_ref().unwrap(),
            &other_project,
            &[root],
            &[independent],
            2
        )
        .is_err()
    );
}

#[test]
fn source_upload_policy_is_separate_from_measurement_time_and_accepted_replay() {
    let day = 86_400_000_000_000u64;
    let mut raw = cases::raw();
    let received = 10 * day;
    raw.received_unix_nano = received;
    raw.batch.as_mut().unwrap().created_unix_nano = received - 3 * day;
    metadata::age(raw.batch.as_ref().unwrap(), received, 7 * day, 0).unwrap();
    assert_eq!(
        metadata::age(raw.batch.as_ref().unwrap(), received, day, 0)
            .unwrap_err()
            .category,
        Category::Expired
    );
    let mut request =
        recount_telemetry_schema::ExportMetricsServiceRequest::decode(raw.otlp_request.as_slice())
            .unwrap();
    cases::gauge_mut(&mut request, "integer.extremes").data_points[0].time_unix_nano = 1;
    raw.otlp_request = request.encode_to_vec();
    let accepted = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(accepted[0].time_unix_nano, 1);
    assert_eq!(
        metadata::age(raw.batch.as_ref().unwrap(), received + 20 * day, 7 * day, 0)
            .unwrap_err()
            .category,
        Category::Expired
    );
    let replay = validate::retained_raw(&raw, Limits::default()).unwrap();
    assert_eq!(replay, accepted);
    assert!(metadata::age(raw.batch.as_ref().unwrap(), received, u64::MAX, 1).is_err());
}

#[test]
fn deployment_bounds_are_positive_coherent_and_explicit() {
    assert!(
        Limits {
            points: 0,
            ..Default::default()
        }
        .validate()
        .is_err()
    );
    assert!(
        Limits {
            normalized_record_bytes: 2,
            normalized_batch_bytes: 1,
            ..Default::default()
        }
        .validate()
        .is_err()
    );
    let raw = cases::raw();
    let limits = Limits {
        points: 20,
        distinct_authorities: 5,
        ..Default::default()
    }
    .validate()
    .unwrap();
    validate::raw(&raw, limits).unwrap();
}

#[test]
fn metadata_profiles_claims_and_expiry_fail_closed() {
    assert_eq!(
        metadata::profile(None).unwrap(),
        metadata::Profile::Standard
    );
    assert!(metadata::profile(Some("unknown")).is_err());
    assert!(metadata::headers(&[(metadata::BATCH_ID, "a"), (metadata::BATCH_ID, "a")]).is_err());
    assert!(metadata::headers(&[(metadata::PROFILE, "linux")]).is_err());
    let claim = metadata::resource_claim(&[
        cases::attr(
            "recount.resource.id",
            Attribute::StringValue("sensor-a".into()),
        ),
        cases::attr(
            "recount.resource.kind",
            Attribute::StringValue("sensor".into()),
        ),
    ])
    .unwrap()
    .unwrap();
    assert_eq!(claim.kind, ResourceKind::Sensor as i32);
    assert!(metadata::batch(None, None).unwrap().is_none());
    assert!(metadata::batch(Some("a"), None).is_err());
    let batch = metadata::batch(Some("batch-a"), Some("100"))
        .unwrap()
        .unwrap();
    assert!(metadata::age(&batch, 101, 10, 1).is_ok());
    assert_eq!(
        metadata::age(&batch, 112, 10, 1).unwrap_err().category,
        Category::Expired
    );
    assert_eq!(
        metadata::batch(Some("a"), Some("18446744073709551616"))
            .unwrap_err()
            .category,
        Category::Invalid
    );
}

#[test]
fn cached_gpu_observations_are_distinct_positions_not_invented_counter_epochs() {
    let mut request = cases::request();
    let metric = cases::metric_mut(&mut request, "DCGM_FI_PROF_SM_ACTIVE");
    validation::catalogue::validate_adapter_metric(metric, Adapter::Dcgm).unwrap();
    let g = cases::gauge_mut(&mut request, "DCGM_FI_PROF_SM_ACTIVE");
    g.data_points.push(g.data_points[0].clone());
    let mut raw = cases::raw();
    raw.otlp_request = request.encode_to_vec();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    let gpu: Vec<_> = points
        .iter()
        .filter(|p| p.metric_name == "DCGM_FI_PROF_SM_ACTIVE")
        .collect();
    assert_eq!(gpu.len(), 2);
    assert_eq!(gpu[0].time_unix_nano, gpu[1].time_unix_nano);
    assert_ne!(gpu[0].sample_id, gpu[1].sample_id);
    assert_eq!(gpu[0].metric_kind, 1);
    assert!(gpu[0].continuity.is_none());
}

#[test]
fn direct_resource_kinds_need_no_linux_tree_and_canonical_streams_ignore_map_order() {
    let mut request = cases::request();
    request.resource_metrics.truncate(1);
    let mut raw = cases::raw();
    raw.bindings.truncate(1);
    raw.otlp_request = request.encode_to_vec();
    let grant = BoundGrant {
        security: raw.security.clone().unwrap(),
        resource: raw.bindings[0]
            .context
            .as_ref()
            .unwrap()
            .resource
            .clone()
            .unwrap(),
    };
    policy::authorize(raw.security.as_ref().unwrap(), &raw, &[], &[grant], 1).unwrap();
    let first = validate::raw(&raw, Limits::default()).unwrap();
    request.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .attributes
        .reverse();
    request.resource_metrics[0].scope_metrics[0]
        .scope
        .as_mut()
        .unwrap()
        .attributes
        .reverse();
    cases::gauge_mut(&mut request, "arbitrary.authorized.metric").data_points[0]
        .attributes
        .reverse();
    raw.batch.as_mut().unwrap().client_id = "another-batch".into();
    raw.otlp_request = request.encode_to_vec();
    let reordered = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(
        first.iter().map(|p| &p.stream_id).collect::<Vec<_>>(),
        reordered.iter().map(|p| &p.stream_id).collect::<Vec<_>>()
    );
    assert_ne!(first[0].sample_id, reordered[0].sample_id);
    for kind in [
        ResourceKind::Cpu,
        ResourceKind::Process,
        ResourceKind::Container,
        ResourceKind::Gateway,
        ResourceKind::ResourceUnknown,
    ] {
        let context = raw.bindings[0].context.as_mut().unwrap();
        context.resource.as_mut().unwrap().kind = kind as i32;
        context.host_id = None;
        context.device_id = None;
        let points = validate::raw(&raw, Limits::default()).unwrap();
        assert_eq!(points[0].resource_kind, kind as i32);
    }
}
