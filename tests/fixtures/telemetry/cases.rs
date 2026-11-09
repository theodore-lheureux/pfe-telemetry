use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::{self, AnyValue, KeyValue, any_value::Value as Attribute},
    metrics::{self, metric::Data, number_data_point::Value},
    resource::Resource,
    wire::*,
};

pub fn attr(key: &str, value: Attribute) -> KeyValue {
    KeyValue {
        key: key.into(),
        key_strindex: 0,
        value: Some(AnyValue { value: Some(value) }),
    }
}
pub fn attributes() -> Vec<KeyValue> {
    vec![
        attr(
            "host.name",
            Attribute::StringValue("mutable display".into()),
        ),
        attr("exact", Attribute::IntValue(i64::MAX)),
        attr("ratio", Attribute::DoubleValue(-0.25)),
        attr("enabled", Attribute::BoolValue(true)),
        attr("bytes", Attribute::BytesValue(vec![0, 255])),
        attr(
            "nested/a~b",
            Attribute::KvlistValue(common::KeyValueList {
                values: vec![attr("min", Attribute::IntValue(i64::MIN))],
            }),
        ),
        attr(
            "array",
            Attribute::ArrayValue(common::ArrayValue {
                values: vec![
                    AnyValue {
                        value: Some(Attribute::IntValue(1)),
                    },
                    AnyValue {
                        value: Some(Attribute::StringValue("1".into())),
                    },
                ],
            }),
        ),
        attr(
            "empty",
            Attribute::ArrayValue(common::ArrayValue { values: vec![] }),
        ),
        KeyValue {
            key: "absent".into(),
            key_strindex: 0,
            value: None,
        },
        KeyValue {
            key: "empty-value".into(),
            key_strindex: 0,
            value: Some(AnyValue::default()),
        },
    ]
}
pub fn number(value: Option<Value>, time: u64) -> metrics::NumberDataPoint {
    metrics::NumberDataPoint {
        value,
        time_unix_nano: time,
        ..Default::default()
    }
}
fn metric(name: &str, data: Data) -> metrics::Metric {
    metrics::Metric {
        name: name.into(),
        unit: "1".into(),
        description: "fixture".into(),
        metadata: vec![attr("mapping", Attribute::StringValue("native".into()))],
        data: Some(data),
    }
}
pub fn request() -> ExportMetricsServiceRequest {
    let exemplar = metrics::Exemplar {
        filtered_attributes: vec![attr("exact", Attribute::IntValue(i64::MIN))],
        time_unix_nano: 1_780_000_000_000_000_111,
        span_id: vec![1; 8],
        trace_id: vec![2; 16],
        value: Some(metrics::exemplar::Value::AsInt(i64::MAX)),
    };
    let mut absent = number(None, 1_780_000_000_000_000_003);
    absent.flags = 1;
    let mut double = number(Some(Value::AsDouble(-12.5)), 1_780_000_000_000_000_002);
    double.attributes = attributes();
    double.exemplars = vec![exemplar.clone()];
    let mut counter = number(Some(Value::AsInt(10)), 1_780_000_000_000_000_010);
    counter.start_time_unix_nano = 1_780_000_000_000_000_000;
    counter.attributes = vec![attr(
        "recount.counter.segment_id",
        Attribute::StringValue("segment-a".into()),
    )];
    let mut restart = counter.clone();
    restart.start_time_unix_nano += 1;
    restart.time_unix_nano += 1;
    restart.value = Some(Value::AsInt(1));
    restart.attributes = vec![attr(
        "recount.counter.segment_id",
        Attribute::StringValue("segment-b".into()),
    )];
    let metrics = vec![
        metric(
            "integer.extremes",
            Data::Gauge(metrics::Gauge {
                data_points: vec![
                    number(Some(Value::AsInt(i64::MIN)), 1_780_000_000_000_000_001),
                    number(Some(Value::AsInt(i64::MAX)), u64::MAX),
                ],
            }),
        ),
        metric(
            "arbitrary.authorized.metric",
            Data::Gauge(metrics::Gauge {
                data_points: vec![double, absent],
            }),
        ),
        metric(
            "counter",
            Data::Sum(metrics::Sum {
                data_points: vec![counter, restart],
                aggregation_temporality: 2,
                is_monotonic: true,
            }),
        ),
        metric(
            "distribution",
            Data::Histogram(metrics::Histogram {
                aggregation_temporality: 1,
                data_points: vec![
                    metrics::HistogramDataPoint {
                        time_unix_nano: 1_780_000_000_000_000_020,
                        start_time_unix_nano: 1_780_000_000_000_000_000,
                        count: 3,
                        sum: None,
                        min: None,
                        max: Some(9.0),
                        explicit_bounds: vec![0.5],
                        bucket_counts: vec![1, 2],
                        exemplars: vec![exemplar],
                        ..Default::default()
                    },
                    metrics::HistogramDataPoint {
                        time_unix_nano: 1_780_000_000_000_000_021,
                        count: u64::MAX,
                        sum: Some(0.0),
                        min: Some(0.0),
                        max: Some(0.0),
                        ..Default::default()
                    },
                ],
            }),
        ),
        metric(
            "exponential",
            Data::ExponentialHistogram(metrics::ExponentialHistogram {
                aggregation_temporality: 2,
                data_points: vec![
                    metrics::ExponentialHistogramDataPoint {
                        time_unix_nano: 1_780_000_000_000_000_030,
                        count: 6,
                        zero_count: 1,
                        zero_threshold: 0.001,
                        scale: -7,
                        positive: Some(metrics::exponential_histogram_data_point::Buckets {
                            offset: -2,
                            bucket_counts: vec![2],
                        }),
                        negative: Some(metrics::exponential_histogram_data_point::Buckets {
                            offset: 4,
                            bucket_counts: vec![3],
                        }),
                        sum: Some(4.0),
                        min: Some(-3.0),
                        max: Some(7.0),
                        ..Default::default()
                    },
                    metrics::ExponentialHistogramDataPoint {
                        time_unix_nano: 1_780_000_000_000_000_031,
                        positive: Some(
                            metrics::exponential_histogram_data_point::Buckets::default(),
                        ),
                        negative: None,
                        ..Default::default()
                    },
                ],
            }),
        ),
        metric(
            "summary",
            Data::Summary(metrics::Summary {
                data_points: vec![metrics::SummaryDataPoint {
                    time_unix_nano: 1_780_000_000_000_000_040,
                    count: 2,
                    sum: -1.0,
                    quantile_values: vec![
                        metrics::summary_data_point::ValueAtQuantile {
                            quantile: 0.0,
                            value: -2.0,
                        },
                        metrics::summary_data_point::ValueAtQuantile {
                            quantile: 1.0,
                            value: 1.0,
                        },
                    ],
                    ..Default::default()
                }],
            }),
        ),
    ];
    let resource = metrics::ResourceMetrics {
        resource: Some(Resource {
            attributes: attributes(),
            dropped_attributes_count: 3,
            ..Default::default()
        }),
        schema_url: "https://opentelemetry.io/schemas/1.40.0".into(),
        scope_metrics: vec![metrics::ScopeMetrics {
            scope: Some(common::InstrumentationScope {
                name: "recount.collector.procfs".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                attributes: attributes(),
                dropped_attributes_count: 2,
            }),
            schema_url: "https://example.invalid/scope".into(),
            metrics,
        }],
    };
    let mut request = ExportMetricsServiceRequest {
        resource_metrics: vec![resource],
    };
    for (name, time) in [
        ("DCGM_FI_PROF_SM_ACTIVE", 1_780_000_000_000_000_123),
        ("vm.temperature", 1_780_000_000_000_000_200),
        ("sensor.temperature", 1_780_000_000_000_000_300),
        ("sensor.temperature", 1_780_000_000_000_000_301),
    ] {
        request.resource_metrics.push(metrics::ResourceMetrics {
            resource: Some(Resource::default()),
            schema_url: String::new(),
            scope_metrics: vec![metrics::ScopeMetrics {
                scope: None,
                schema_url: String::new(),
                metrics: vec![metric(
                    name,
                    Data::Gauge(metrics::Gauge {
                        data_points: vec![number(Some(Value::AsDouble(0.5)), time)],
                    }),
                )],
            }],
        });
    }
    request
}
pub fn raw() -> RawRecord {
    let mut bindings = Vec::new();
    for (r, (id, kind, host, device)) in [
        ("node-a", ResourceKind::Host, Some("node-a"), None),
        ("gpu-a", ResourceKind::Gpu, Some("node-a"), Some("gpu-a")),
        ("vm-a", ResourceKind::Vm, None, None),
        ("sensor-a", ResourceKind::Sensor, None, Some("sensor-a")),
        ("sensor-b", ResourceKind::Sensor, None, Some("sensor-b")),
    ]
    .into_iter()
    .enumerate()
    {
        let resource = ResourceRef {
            id: id.into(),
            kind: kind as i32,
        };
        let relationships = if id == "vm-a" {
            vec![Relationship {
                from: Some(resource.clone()),
                to: Some(ResourceRef {
                    id: "node-a".into(),
                    kind: ResourceKind::Host as i32,
                }),
                kind: RelationKind::PlacedOn as i32,
                effective_from_unix_nano: Some(1_780_000_000_000_000_000),
                effective_until_unix_nano: None,
                evidence: "exporter assertion; not workload attribution".into(),
                provenance: "source-a".into(),
            }]
        } else {
            vec![]
        };
        bindings.push(ResourceBinding {
            original_resource: r as u32,
            context: Some(ResourceContext {
                access: Some(ResourceAccess {
                    scope: Some(resource_access::Scope::Bound(BoundScope {})),
                }),
                resource: Some(resource),
                host_id: host.map(str::to_owned),
                device_id: device.map(str::to_owned),
                relationships,
            }),
        });
    }
    RawRecord {
        security: Some(SecurityScope {
            project_id: "project-a".into(),
            source_id: "source-a".into(),
        }),
        record_id: "receipt-a".into(),
        received_unix_nano: 1_780_000_000_000_001_000,
        batch: Some(BatchIdentity {
            client_id: "batch-a".into(),
            created_unix_nano: 1_780_000_000_000_000_000,
        }),
        payload_kind: PayloadKind::OtlpMetrics as i32,
        otlp_request: request().encode_to_vec(),
        bindings,
    }
}

pub fn ordinary_cpu_process() -> RawRecord {
    let time = 1_780_000_000_000_000_001;
    let mut raw = raw();
    raw.bindings.truncate(2);
    let mut resources = Vec::new();
    for (index, id) in ["node-a", "process-a"].into_iter().enumerate() {
        let mut counter = number(
            Some(Value::AsDouble(if index == 0 { 100.125 } else { 2.5 })),
            time,
        );
        counter.start_time_unix_nano = time - 1_000_000_000;
        counter.attributes = vec![
            attr(
                "recount.counter.segment_id",
                Attribute::StringValue("segment-a".into()),
            ),
            attr("cpu.mode", Attribute::StringValue("user".into())),
        ];
        let mut cpu = metric(
            if index == 0 {
                "recount.node.cpu.time"
            } else {
                "process.cpu.time"
            },
            Data::Sum(metrics::Sum {
                data_points: vec![counter],
                aggregation_temporality: 2,
                is_monotonic: true,
            }),
        );
        cpu.unit = "s".into();
        let mut memory = metric(
            if index == 0 {
                "recount.node.memory.available"
            } else {
                "recount.process.memory.rss"
            },
            Data::Gauge(metrics::Gauge {
                data_points: vec![number(
                    Some(Value::AsInt(if index == 0 { 16_777_216 } else { 65_536 })),
                    time,
                )],
            }),
        );
        memory.unit = "By".into();
        let mut attrs = vec![
            attr("host.id", Attribute::StringValue("node-a".into())),
            attr("recount.resource.id", Attribute::StringValue(id.into())),
        ];
        if index == 1 {
            attrs.push(attr("process.pid", Attribute::IntValue(42)));
        }
        resources.push(metrics::ResourceMetrics {
            resource: Some(Resource {
                attributes: attrs,
                ..Default::default()
            }),
            schema_url: String::new(),
            scope_metrics: vec![metrics::ScopeMetrics {
                scope: Some(common::InstrumentationScope {
                    name: "recount.collector.procfs".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    ..Default::default()
                }),
                schema_url: String::new(),
                metrics: vec![cpu, memory],
            }],
        });
        let context = raw.bindings[index].context.as_mut().unwrap();
        context.resource = Some(ResourceRef {
            id: id.into(),
            kind: if index == 0 {
                ResourceKind::Host
            } else {
                ResourceKind::Process
            } as i32,
        });
        context.host_id = Some("node-a".into());
        context.device_id = None;
    }
    raw.otlp_request = ExportMetricsServiceRequest {
        resource_metrics: resources,
    }
    .encode_to_vec();
    raw
}
