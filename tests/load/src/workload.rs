use crate::{
    Result,
    allocation::{Allocation, Node, NodeKind, unix_nanos},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::Args;
use ed25519_dalek::{Signer, SigningKey};
use prost::Message;
use recount_telemetry_schema::{
    ExportMetricsServiceRequest,
    common::{AnyValue, InstrumentationScope, KeyValue, any_value::Value},
    identity::{self, local_resource_id},
    metrics::{
        AggregationTemporality, Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum,
        metric, number_data_point,
    },
    resource::Resource,
    wire::{
        AnalyticalParticipant, BatchIdentity, ParticipantFactKind, ParticipantOrigin, PayloadKind,
        Position, RawRecord, ResourceKind, SecurityScope,
    },
};
use recount_telemetry_validation::linux_adapter::ProcessIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

const NODE_METRICS: u32 = 3;
const PROCESS_METRICS: u32 = 2;
const POINT_SPACING_NS: u64 = 1_000_000;
pub const TOKEN_SECONDS: u64 = 3600;
/// Process positions per Linux node that receive execution memberships.
const MEMBERSHIP_PROCESSES: u32 = 64;

#[derive(Args, Clone, Debug, Serialize, Deserialize)]
pub struct Shape {
    /// Gauges per direct-node batch.
    #[arg(long, default_value_t = 4)]
    pub metrics: u32,
    /// Process resources per Linux-node batch, besides its host resource.
    #[arg(long, default_value_t = 4)]
    pub processes: u32,
    /// Data points per metric in each batch.
    #[arg(long, default_value_t = 8)]
    pub points: u32,
    /// Point attributes on direct-node gauges, including the series selector.
    #[arg(long, default_value_t = 2)]
    pub attributes: u32,
    /// Distinct series selector values per direct-node gauge.
    #[arg(long, default_value_t = 4)]
    pub series: u32,
    /// Bytes of padding in one string point attribute, for maximum-size inputs.
    #[arg(long, default_value_t = 0)]
    pub padding: u32,
    /// Claim an unenrolled resource on direct nodes, so admission rejects each batch with
    /// PERMISSION_DENIED after authentication and validation, before publication.
    #[arg(long)]
    pub foreign_resource: bool,
}

/// Metrics per original resource position; with `points`, every sample position.
pub fn layout(kind: NodeKind, shape: &Shape) -> Vec<u32> {
    match kind {
        NodeKind::Direct => vec![shape.metrics],
        NodeKind::Linux => std::iter::once(NODE_METRICS)
            .chain((0..shape.processes).map(|_| PROCESS_METRICS))
            .collect(),
    }
}

pub fn sample_ids(
    project: &str,
    node: &str,
    batch: &str,
    layout: &[u32],
    points: u32,
) -> Vec<[u8; 32]> {
    let raw = RawRecord {
        security: Some(SecurityScope {
            project_id: project.into(),
            source_id: node.into(),
        }),
        payload_kind: PayloadKind::OtlpMetrics as i32,
        batch: Some(BatchIdentity {
            client_id: batch.into(),
            created_unix_nano: 0,
        }),
        ..Default::default()
    };
    let mut ids = Vec::new();
    for (resource, metrics) in layout.iter().enumerate() {
        for metric in 0..*metrics {
            for point in 0..points {
                let position = Position {
                    resource: resource as u32,
                    scope: 0,
                    metric,
                    point,
                };
                ids.push(identity::sample_id(&raw, &position).expect("trusted identity inputs"));
            }
        }
    }
    ids
}

/// The first eight bytes as a big-endian integer; ClickHouse computes the same value with
/// `reinterpretAsUInt64(reverse(substring(sample_id, 1, 8)))`.
pub fn fingerprint(id: &[u8; 32]) -> u64 {
    u64::from_be_bytes(id[..8].try_into().expect("eight bytes"))
}

fn string(key: &str, value: impl Into<String>) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(Value::StringValue(value.into())),
        }),
        ..Default::default()
    }
}

fn int(key: &str, value: i64) -> KeyValue {
    KeyValue {
        key: key.into(),
        value: Some(AnyValue {
            value: Some(Value::IntValue(value)),
        }),
        ..Default::default()
    }
}

fn mix(parts: &[u64]) -> u64 {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.to_be_bytes());
    }
    u64::from_be_bytes(hash.finalize()[..8].try_into().expect("eight bytes"))
}

pub fn boot_id(node: usize) -> String {
    format!("{:08x}-0000-4000-8000-{:012x}", node as u32, node as u64)
}

fn process(node: usize, index: u32) -> (String, i64, String) {
    (
        format!("load-namespace-{node}"),
        1000 + i64::from(index),
        "100".into(),
    )
}

fn gauge(name: &str, unit: &str, points: Vec<NumberDataPoint>) -> Metric {
    Metric {
        name: name.into(),
        unit: unit.into(),
        data: Some(metric::Data::Gauge(Gauge {
            data_points: points,
        })),
        ..Default::default()
    }
}

fn counter(name: &str, unit: &str, points: Vec<NumberDataPoint>) -> Metric {
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

fn point(time: u64, value: number_data_point::Value, attributes: Vec<KeyValue>) -> NumberDataPoint {
    NumberDataPoint {
        time_unix_nano: time,
        value: Some(value),
        attributes,
        ..Default::default()
    }
}

/// One deterministic batch: values depend only on node, sequence and position; times are
/// spaced back from the batch creation time.
pub fn request(
    index: usize,
    node: &Node,
    sequence: u64,
    created: u64,
    shape: &Shape,
) -> ExportMetricsServiceRequest {
    let time = |p: u32| created - u64::from(shape.points - 1 - p) * POINT_SPACING_NS;
    let scope = |metrics| ScopeMetrics {
        scope: Some(InstrumentationScope {
            name: "recount-load".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            ..Default::default()
        }),
        metrics,
        ..Default::default()
    };
    let padding = "x".repeat(shape.padding as usize);
    match node.kind {
        NodeKind::Direct => {
            let metrics = (0..shape.metrics)
                .map(|m| {
                    let points = (0..shape.points)
                        .map(|p| {
                            let value = mix(&[index as u64, sequence, u64::from(m), u64::from(p)]);
                            let mut attributes = vec![string(
                                "load.series",
                                format!("s{}", (p * 31 + m) % shape.series.max(1)),
                            )];
                            attributes.extend(
                                (1..shape.attributes)
                                    .map(|a| string(&format!("load.attr.{a}"), format!("v{a}"))),
                            );
                            if !padding.is_empty() {
                                attributes.push(string("load.padding", padding.clone()));
                            }
                            point(
                                time(p),
                                number_data_point::Value::AsDouble(
                                    (value % 1_000_000) as f64 / 10.0,
                                ),
                                attributes,
                            )
                        })
                        .collect();
                    gauge(&format!("load.gauge.{m}"), "1", points)
                })
                .collect();
            ExportMetricsServiceRequest {
                resource_metrics: vec![ResourceMetrics {
                    resource: Some(Resource {
                        attributes: if shape.foreign_resource {
                            vec![
                                string("service.name", "recount-load"),
                                string("recount.resource.id", "load-foreign"),
                                string("recount.resource.kind", "host"),
                            ]
                        } else {
                            vec![string("service.name", "recount-load")]
                        },
                        ..Default::default()
                    }),
                    scope_metrics: vec![scope(metrics)],
                    ..Default::default()
                }],
            }
        }
        NodeKind::Linux => {
            let base = |scope_name: &str| {
                vec![
                    string("host.id", node.root.clone()),
                    string("recount.host.boot_id", boot_id(index)),
                    string("recount.collection.epoch_id", "load-epoch"),
                    string("recount.collection.scope", scope_name),
                ]
            };
            let counter_value = |p: u32| sequence * u64::from(shape.points) + u64::from(p);
            let host = ResourceMetrics {
                resource: Some(Resource {
                    attributes: base("node"),
                    ..Default::default()
                }),
                scope_metrics: vec![scope(vec![
                    gauge(
                        "recount.node.memory.total",
                        "By",
                        (0..shape.points)
                            .map(|p| {
                                point(time(p), number_data_point::Value::AsInt(1 << 34), vec![])
                            })
                            .collect(),
                    ),
                    gauge(
                        "recount.node.memory.available",
                        "By",
                        (0..shape.points)
                            .map(|p| {
                                let value =
                                    mix(&[index as u64, sequence, u64::from(p)]) % (1 << 33);
                                point(
                                    time(p),
                                    number_data_point::Value::AsInt(value as i64),
                                    vec![],
                                )
                            })
                            .collect(),
                    ),
                    counter(
                        "recount.node.cpu.time",
                        "s",
                        (0..shape.points)
                            .map(|p| {
                                let mode = if p % 2 == 0 { "user" } else { "system" };
                                point(
                                    time(p),
                                    number_data_point::Value::AsDouble(counter_value(p) as f64),
                                    vec![string("cpu.mode", mode)],
                                )
                            })
                            .collect(),
                    ),
                ])],
                ..Default::default()
            };
            let processes = (0..shape.processes).map(|k| {
                let (namespace, pid, ticks) = process(index, k);
                let mut attributes = base("process");
                attributes.extend([
                    string("recount.process.namespace_id", namespace),
                    string("recount.process.start_time_ticks", ticks),
                    int("process.pid", pid),
                ]);
                ResourceMetrics {
                    resource: Some(Resource {
                        attributes,
                        ..Default::default()
                    }),
                    scope_metrics: vec![scope(vec![
                        gauge(
                            "recount.process.memory.rss",
                            "By",
                            (0..shape.points)
                                .map(|p| {
                                    let value =
                                        mix(&[index as u64, sequence, u64::from(k), u64::from(p)])
                                            % (1 << 30);
                                    point(
                                        time(p),
                                        number_data_point::Value::AsInt(value as i64),
                                        vec![],
                                    )
                                })
                                .collect(),
                        ),
                        counter(
                            "process.cpu.time",
                            "s",
                            (0..shape.points)
                                .map(|p| {
                                    point(
                                        time(p),
                                        number_data_point::Value::AsDouble(counter_value(p) as f64),
                                        vec![],
                                    )
                                })
                                .collect(),
                        ),
                    ])],
                    ..Default::default()
                }
            });
            ExportMetricsServiceRequest {
                resource_metrics: std::iter::once(host).chain(processes).collect(),
            }
        }
    }
}

fn key_id(public: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public.as_bytes()))[..16].to_string()
}

/// A node access token as the web application signs it.
pub fn token(
    signing: &SigningKey,
    allocation: &Allocation,
    node: &Node,
    now_seconds: u64,
) -> String {
    let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
    let (adapter, local_kinds) = match node.kind {
        NodeKind::Direct => ("standard", vec![]),
        NodeKind::Linux => ("linux", vec![ResourceKind::Process as i32]),
    };
    let claims = serde_json::json!({
        "sub": node.id,
        "org": allocation.organization,
        "project": allocation.projects[node.project],
        "root": node.root,
        "rootKind": ResourceKind::Host as i32,
        "adapter": adapter,
        "localKinds": local_kinds,
        "maxAge": 3600,
        "skew": 60,
        "iss": "recount",
        "aud": "recount-ingestion",
        "iat": now_seconds,
        "exp": now_seconds + TOKEN_SECONDS,
    });
    let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": key_id(&public) });
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = signing.sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

/// Process memberships for every Linux node's processes, as delimited Protobuf rows. Two
/// executions per project share processes from several nodes.
pub fn participant_facts(allocation: &Allocation) -> Vec<u8> {
    let first = allocation.created_unix_nano - 3_600_000_000_000;
    let last = allocation.created_unix_nano + 7 * 86_400_000_000_000;
    let mut out = Vec::new();
    for (index, node) in allocation.nodes.iter().enumerate() {
        if node.kind != NodeKind::Linux {
            continue;
        }
        let project = &allocation.projects[node.project];
        let boot = boot_id(index);
        for k in 0..MEMBERSHIP_PROCESSES {
            let (namespace, pid, ticks) = process(index, k);
            let incarnation = ProcessIdentity {
                boot: &boot,
                namespace: &namespace,
                pid: pid as u64,
                start_ticks: ticks.parse().expect("ticks"),
            }
            .incarnation();
            let resource =
                local_resource_id(project, &node.root, ResourceKind::Process, &incarnation)
                    .expect("valid local identity");
            AnalyticalParticipant {
                project_id: project.clone(),
                node_id: node.id.clone(),
                host_id: node.root.clone(),
                boot_id: boot.clone(),
                execution_key: format!("load:{}:{}", node.project, k % 2),
                participant_id: format!("{}-{k}", node.id),
                fact_id: format!("{}-{k}-membership", node.id),
                revision: 1,
                kind: ParticipantFactKind::ProcessMembership as i32,
                process_resource_id: Some(resource),
                process_namespace_id: Some(namespace),
                process_pid: Some(pid as u32),
                process_start_time_ticks: Some(100),
                origin: ParticipantOrigin::Environment as i32,
                first_seen_unix_nano: first,
                last_seen_unix_nano: last,
                record_id: format!("{}-{k}", node.id),
                received_unix_nano: allocation.created_unix_nano,
                environment_variable: "RECOUNT_EXECUTION".into(),
                ..Default::default()
            }
            .encode_length_delimited(&mut out)
            .expect("vector output");
        }
    }
    out
}

/// Tokens, node indexes and reader credentials for the k6 scripts; the gRPC script sends one
/// direct-node gauge per batch. Tokens expire after `TOKEN_SECONDS`.
pub fn k6_inputs(allocation: &Allocation, run: &Path) -> Result<()> {
    let signing = allocation.signing_key();
    let now = unix_nanos() / 1_000_000_000;
    let nodes: Vec<_> = allocation
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.kind == NodeKind::Direct)
        .map(|(index, node)| {
            serde_json::json!({
                "index": index,
                "token": token(&signing, allocation, node, now),
            })
        })
        .collect();
    let path = run.join("k6-inputs.json");
    crate::allocation::write_private(
        &path,
        &serde_json::to_vec(&serde_json::json!({
            "address": allocation.ingestion_addr,
            "expires_unix": now + TOKEN_SECONDS,
            "nodes": nodes,
            "reader": { "user": allocation.reader_user, "password": allocation.reader_password },
        }))?,
    )?;
    eprintln!("k6_inputs={}", path.display());
    Ok(())
}
