#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
use prost::Message;
use recount_telemetry_schema::{
    common::any_value::Value as Attribute,
    identity,
    metrics::{self, metric::Data, number_data_point::Value},
    point, projection,
    wire::*,
};
use recount_telemetry_validation::{
    self as validation, Category, metadata,
    policy::{self, BoundGrant, RootGrant},
    validate::{self, Limits},
};

#[test]
fn every_kind_round_trips_supported_otlp_and_sql_projections() {
    let mut raw = cases::raw();
    let mut original = cases::request();
    original.resource_metrics[0]
        .resource
        .as_mut()
        .unwrap()
        .entity_refs
        .push(recount_telemetry_schema::common::EntityRef {
            schema_url: "https://example.invalid/entity".into(),
            r#type: "host".into(),
            id_keys: vec!["host.name".into()],
            description_keys: vec![],
        });
    raw.otlp_request = original.encode_to_vec();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(points.len(), 15);
    for p in &points {
        validate::normalized(p, Limits::default()).unwrap();
        assert_eq!(
            NormalizedPoint::decode(p.encode_to_vec().as_slice()).unwrap(),
            *p
        );
        let pos = p.original.as_ref().unwrap();
        let r = &original.resource_metrics[pos.resource as usize];
        let s = &r.scope_metrics[pos.scope as usize];
        assert_eq!(
            metrics::Metric::decode(p.otlp_metric.as_slice()).unwrap(),
            point::singleton(&s.metrics[pos.metric as usize], pos.point as usize).unwrap()
        );
        assert_eq!(
            p.otlp_resource,
            r.resource.as_ref().map(Message::encode_to_vec)
        );
        assert_eq!(p.otlp_scope, s.scope.as_ref().map(Message::encode_to_vec));
        assert_eq!(p.resource_schema_url, r.schema_url);
        assert_eq!(p.scope_schema_url, s.schema_url);
        let row = projection::project(p).unwrap();
        assert_eq!(
            AnalyticalPoint::decode(projection::encode(p).unwrap().as_slice()).unwrap(),
            row
        );
        assert_eq!(row.time_unix_nano, p.time_unix_nano);
        assert_eq!(row.description, s.metrics[pos.metric as usize].description);
        assert_eq!(
            row.resource_dropped_attributes_count,
            r.resource.as_ref().unwrap().dropped_attributes_count
        );
        assert_eq!(
            row.resource_entity_refs,
            r.resource
                .as_ref()
                .unwrap()
                .entity_refs
                .iter()
                .map(Message::encode_to_vec)
                .collect::<Vec<_>>()
        );
        let metric = metrics::Metric::decode(p.otlp_metric.as_slice()).unwrap();
        let points = point::observations(&metric);
        let exemplars = match points[0] {
            point::Observation::Number(v) => &v.exemplars,
            point::Observation::Histogram(v) => &v.exemplars,
            point::Observation::Exponential(v) => &v.exemplars,
            point::Observation::Summary(_) => &[][..],
        };
        assert_eq!(
            row.exemplars,
            exemplars
                .iter()
                .map(Message::encode_to_vec)
                .collect::<Vec<_>>()
        );
        let lineage = PointLineage::decode(row.lineage.as_slice()).unwrap();
        assert_eq!(lineage.access, p.context.as_ref().unwrap().access);
        assert_eq!(lineage.original, p.original);
        assert_eq!(
            lineage.relationships,
            p.context.as_ref().unwrap().relationships
        );
        if p.metric_kind == 3 && p.original.as_ref().unwrap().point == 0 {
            assert!(row.sum.is_none());
            assert!(row.min.is_none());
            assert_eq!(row.bucket_counts, vec![1, 2]);
        }
        if p.metric_kind == 4 && p.original.as_ref().unwrap().point == 1 {
            assert_eq!(row.positive_offset, Some(0));
            assert!(row.negative_offset.is_none());
        }
    }
    assert_eq!(points[0].int_value, Some(i64::MIN));
    assert_eq!(points[1].int_value, Some(i64::MAX));
    assert_eq!(points[1].time_unix_nano, u64::MAX);
    assert_eq!(points[2].double_value, Some(-12.5));
    assert_eq!(points[3].flags, 1);
    assert_eq!((points[3].int_value, points[3].double_value), (None, None));
    assert_eq!(points[11].time_unix_nano, 1_780_000_000_000_000_123);
    assert!(points[13].context.as_ref().unwrap().host_id.is_none());
    assert!(
        points[13]
            .context
            .as_ref()
            .unwrap()
            .relationships
            .is_empty()
    );
}

#[test]
fn signed_zero_scalar_projection_tampering_is_rejected() {
    let mut request = cases::request();
    let Some(Data::Gauge(gauge)) =
        &mut request.resource_metrics[1].scope_metrics[0].metrics[0].data
    else {
        unreachable!()
    };
    gauge.data_points[0].value = Some(Value::AsDouble(-0.0));
    let mut raw = cases::raw();
    raw.otlp_request = request.encode_to_vec();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    let original = points
        .iter()
        .find(|p| p.metric_name == "DCGM_FI_PROF_SM_ACTIVE")
        .unwrap();
    assert_eq!(
        original.double_value.map(f64::to_bits),
        Some((-0.0f64).to_bits())
    );
    validate::normalized(original, Limits::default()).unwrap();
    let encoded = projection::encode(original).unwrap();
    assert_eq!(
        AnalyticalPoint::decode(encoded.as_slice())
            .unwrap()
            .double_value
            .map(f64::to_bits),
        Some((-0.0f64).to_bits())
    );
    let mut tampered = original.clone();
    tampered.double_value = Some(0.0);
    assert_eq!(tampered.otlp_metric, original.otlp_metric);
    assert_eq!(
        validate::normalized(&tampered, Limits::default())
            .unwrap_err()
            .category,
        Category::Invalid
    );
}

#[test]
fn immutable_identity_survives_receipts_rotation_and_regrouping_but_not_original_position() {
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
    let regrouped: Vec<_> = retry
        .chunks(2)
        .flat_map(|chunk| chunk.iter().map(|p| p.sample_id.clone()))
        .collect();
    assert_eq!(
        regrouped,
        first
            .iter()
            .map(|p| p.sample_id.clone())
            .collect::<Vec<_>>()
    );
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
    let mut corrupt = first[0].clone();
    corrupt.int_value = Some(0);
    assert!(validate::normalized(&corrupt, Limits::default()).is_err());
    corrupt = first[0].clone();
    corrupt.event_day += 1;
    assert!(validate::normalized(&corrupt, Limits::default()).is_err());
    corrupt = first[0].clone();
    corrupt.sample_id[0] ^= 1;
    assert!(validate::normalized(&corrupt, Limits::default()).is_err());
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
}

#[test]
fn empty_decoded_containers_consume_the_existing_expanded_budget() {
    use recount_telemetry_schema::ExportMetricsServiceRequest;
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
fn many_resources_use_original_binding_positions_not_binding_array_order() {
    use recount_telemetry_schema::ExportMetricsServiceRequest;
    let mut resource = cases::request().resource_metrics.remove(0);
    resource.scope_metrics[0].metrics.truncate(1);
    let Some(Data::Gauge(gauge)) = &mut resource.scope_metrics[0].metrics[0].data else {
        unreachable!()
    };
    gauge.data_points.truncate(1);
    let mut raw = cases::raw();
    let context = raw.bindings[0].context.clone().unwrap();
    raw.bindings.clear();
    let mut request = ExportMetricsServiceRequest::default();
    for index in 0..128u32 {
        let mut resource = resource.clone();
        let Some(Data::Gauge(gauge)) = &mut resource.scope_metrics[0].metrics[0].data else {
            unreachable!()
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
        let position = point.original.as_ref().unwrap();
        assert_eq!(position.resource, index as u32);
        assert_eq!(point.int_value, Some(index as i64));
        assert_eq!(
            point
                .context
                .as_ref()
                .unwrap()
                .resource
                .as_ref()
                .unwrap()
                .id,
            format!("resource-{index}")
        );
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
        if let Some(Data::Gauge(g)) =
            &mut request.resource_metrics[0].scope_metrics[0].metrics[0].data
        {
            g.data_points[0].value = Some(Value::AsDouble(v));
        }
        assert!(validate::request(&request, Limits::default()).is_err());
    }
    let mut bad = cases::request();
    if let Some(Data::Gauge(g)) = &mut bad.resource_metrics[0].scope_metrics[0].metrics[0].data {
        g.data_points[0].value = None;
    }
    assert!(validate::request(&bad, Limits::default()).is_err());
    let mut bad = cases::request();
    if let Some(Data::Histogram(h)) = &mut bad.resource_metrics[0].scope_metrics[0].metrics[3].data
    {
        h.data_points[0].max = Some(f64::NAN);
    }
    assert!(validate::request(&bad, Limits::default()).is_err());
    let mut bad = cases::request();
    if let Some(Data::Histogram(h)) = &mut bad.resource_metrics[0].scope_metrics[0].metrics[3].data
    {
        h.data_points[0].count += 1;
    }
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
    let mut request = cases::request();
    let resource = &mut request.resource_metrics[0];
    resource.resource.as_mut().unwrap().attributes = vec![cases::attr(
        "heavy",
        Attribute::StringValue("x".repeat(65536)),
    )];
    let metric = &mut resource.scope_metrics[0].metrics[0];
    if let Some(Data::Gauge(g)) = &mut metric.data {
        g.data_points = vec![cases::number(Some(Value::AsInt(1)), 1_780_000_000_000_000_001); 256];
    }
    let mut heavy = cases::raw();
    heavy.otlp_request = request.encode_to_vec();
    assert!(heavy.encoded_len() < 100_000);
    assert_eq!(
        validate::raw(&heavy, Limits::default())
            .unwrap_err()
            .category,
        Category::Limit
    );
    if let Some(Data::Gauge(g)) = &mut request.resource_metrics[0].scope_metrics[0].metrics[0].data
    {
        g.data_points.truncate(32);
    }
    heavy.otlp_request = request.encode_to_vec();
    let normalized = validate::raw(&heavy, Limits::default()).unwrap();
    let sizes: Vec<_> = normalized
        .iter()
        .map(|p| projection::encode(p).unwrap().len())
        .collect();
    report_encoding_cost("metadata-heavy", &heavy, &normalized);
    println!(
        "expansion fixture: raw_bytes={} points={} normalized_protobuf_bytes={} maximum_record_bytes={}; 256 repeated points rejected before acceptance",
        heavy.encoded_len(),
        normalized.len(),
        sizes.iter().sum::<usize>(),
        sizes.iter().max().unwrap()
    );
}

fn report_encoding_cost(label: &str, raw: &RawRecord, points: &[NormalizedPoint]) {
    let (mut total, mut resource, mut scope, mut attributes, mut evidence) = (0, 0, 0, 0, 0);
    for p in points {
        let mut row = projection::project(p).unwrap();
        let bytes = row.encoded_len();
        total += bytes;
        row.resource_attributes.clear();
        let next = row.encoded_len();
        resource += bytes - next;
        row.scope_attributes.clear();
        let after_scope = row.encoded_len();
        scope += next - after_scope;
        row.point_attributes.clear();
        row.metric_metadata.clear();
        let after_attrs = row.encoded_len();
        attributes += after_scope - after_attrs;
        row.lineage.clear();
        row.exemplars.clear();
        row.resource_entity_refs.clear();
        evidence += after_attrs - row.encoded_len();
    }
    println!(
        "encoding cost {label}: raw_bytes={} rows={} bare_protobuf={} repeated_resource_attrs={} repeated_scope_attrs={} point_attrs_and_metadata={} unprojected_evidence={} remaining={}",
        raw.encoded_len(),
        points.len(),
        total,
        resource,
        scope,
        attributes,
        evidence,
        total - resource - scope - attributes - evidence
    );
    let saved: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/telemetry/encoding-baseline.json"
    ))
    .unwrap();
    println!(
        "saved JSON comparison {label}: {} bytes from {} raw bytes versus {total} current Protobuf bytes (current raw includes resolved authority provenance)",
        saved[label]["json_bytes"], saved[label]["raw_bytes"]
    );
}

#[test]
fn exact_byte_limits_share_the_final_serializer_and_precede_simulated_publication() {
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
    let rows: Vec<_> = points
        .iter()
        .map(|p| projection::encode(p).unwrap())
        .collect();
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
    assert_eq!(rows[0].len(), projected.encoded_len());
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
    #[derive(Debug, PartialEq)]
    enum ResultStatus {
        Accepted,
        ResourceExhaustedWithoutRetryInfo,
        InvalidArgument,
    }
    fn submit(
        raw: &RawRecord,
        limits: Limits,
        publisher: &mut impl FnMut(&RawRecord),
    ) -> ResultStatus {
        match validate::raw(raw, limits) {
            Ok(_) => {
                publisher(raw);
                ResultStatus::Accepted
            }
            Err(issue) if issue.category == Category::Limit => {
                ResultStatus::ResourceExhaustedWithoutRetryInfo
            }
            Err(_) => ResultStatus::InvalidArgument,
        }
    }
    let mut published = Vec::new();
    let mut publisher = |raw: &RawRecord| published.push(raw.record_id.clone());
    assert_eq!(
        submit(
            &raw,
            Limits {
                normalized_batch_bytes: total_bytes - 1,
                normalized_record_bytes: row_bytes,
                ..Default::default()
            },
            &mut publisher
        ),
        ResultStatus::ResourceExhaustedWithoutRetryInfo
    );
    assert_eq!(
        submit(
            &raw,
            Limits {
                normalized_record_bytes: row_bytes - 1,
                ..Default::default()
            },
            &mut publisher
        ),
        ResultStatus::ResourceExhaustedWithoutRetryInfo
    );
    assert_eq!(
        submit(
            &raw,
            Limits {
                normalized_batch_bytes: total_bytes,
                normalized_record_bytes: row_bytes,
                ..Default::default()
            },
            &mut publisher
        ),
        ResultStatus::Accepted
    );
    assert_eq!(published, vec![raw.record_id]);
}

#[test]
fn ordinary_cpu_process_projection_cost_and_catalogue_are_explicit() {
    let raw = cases::ordinary_cpu_process();
    let points = validate::raw(&raw, Limits::default()).unwrap();
    assert_eq!(points.len(), 4);
    for p in &points {
        let metric = metrics::Metric::decode(p.otlp_metric.as_slice()).unwrap();
        validation::catalogue::validate_collector_metric(&metric).unwrap();
    }
    report_encoding_cost("ordinary-cpu-process", &raw, &points);
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
    raw.bindings[0].context.as_mut().unwrap().access = Some(ResourceAccess {
        scope: Some(resource_access::Scope::Root(RootScope {})),
    });
    for (index, kind, token) in [
        (1, ResourceKind::Gpu, "gpu:0"),
        (3, ResourceKind::Cpu, "cpu:1"),
        (4, ResourceKind::Process, "boot:one/pid:42/start:99"),
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
        root: raw.bindings[0]
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
        resource: raw.bindings[2]
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
        validate::normalized(point, Limits::default()).unwrap();
        let lineage =
            PointLineage::decode(projection::project(point).unwrap().lineage.as_slice()).unwrap();
        assert_eq!(lineage.access, point.context.as_ref().unwrap().access);
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
    let vm = moved.bindings[2].context.as_mut().unwrap();
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
        raw.bindings[2]
            .context
            .as_ref()
            .unwrap()
            .resource
            .as_ref()
            .unwrap()
    }
    let mut wrong = raw.clone();
    wrong.bindings[0]
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
        wrong.bindings[1].context.as_mut().unwrap(),
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
        wrong.bindings[1].context.as_mut().unwrap(),
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
    if let Some(resource_access::Scope::Local(local)) = &mut wrong.bindings[1]
        .context
        .as_mut()
        .unwrap()
        .access
        .as_mut()
        .unwrap()
        .scope
    {
        local.adapter = "ungranted-adapter".into();
    }
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
    let context = wrong.bindings[1].context.as_mut().unwrap();
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
    wrong.bindings[1]
        .context
        .as_mut()
        .unwrap()
        .resource
        .as_mut()
        .unwrap()
        .id = "node-b".into();
    assert!(policy::requested_authorities(&wrong, 3).is_err());
    let mut root_only = raw.clone();
    root_only.bindings.remove(2);
    for (index, binding) in root_only.bindings.iter_mut().enumerate() {
        binding.original_resource = index as u32;
    }
    let mut request = recount_telemetry_schema::ExportMetricsServiceRequest::decode(
        root_only.otlp_request.as_slice(),
    )
    .unwrap();
    request.resource_metrics.remove(2);
    request.resource_metrics[0].resource = None;
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
    if let Some(Data::Gauge(gauge)) =
        &mut request.resource_metrics[0].scope_metrics[0].metrics[0].data
    {
        gauge.data_points[0].time_unix_nano = 1;
    }
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
fn metadata_expiry_flush_and_failure_boundaries_are_explicit() {
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
    let limits = policy::FlushLimits {
        max_rows: 100,
        max_bytes: 10000,
        max_delay_ns: 1000,
    }
    .validate()
    .unwrap();
    assert!(!limits.due(0, 0, 10000));
    assert!(!limits.due(1, 100, 999));
    assert!(limits.due(1, 100, 1000));
    assert!(policy::disposition(Category::Poison).contains("do not commit"));
    assert!(policy::disposition(Category::Outage).contains("backpressure"));
    assert!(policy::disposition(Category::RetentionGap).contains("unrecoverable"));
    assert!(validation::catalogue::definition("arbitrary.authorized.metric").is_none());
    assert_eq!(
        validation::catalogue::definition("DCGM_FI_PROF_PCIE_RX_BYTES")
            .unwrap()
            .unit,
        "By/s"
    );
}

#[test]
fn cached_gpu_observations_are_distinct_positions_not_invented_counter_epochs() {
    let mut request = cases::request();
    let metric = &mut request.resource_metrics[1].scope_metrics[0].metrics[0];
    validation::catalogue::validate_collector_metric(metric).unwrap();
    if let Some(Data::Gauge(g)) = &mut metric.data {
        g.data_points.push(g.data_points[0].clone());
    }
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
    if let Some(Data::Gauge(g)) = &mut request.resource_metrics[0].scope_metrics[0].metrics[1].data
    {
        g.data_points[0].attributes.reverse();
    }
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
        assert_eq!(
            points[0]
                .context
                .as_ref()
                .unwrap()
                .resource
                .as_ref()
                .unwrap()
                .kind,
            kind as i32
        );
    }
}
