use prost::Message;
use rdkafka::{
    ClientConfig, Offset, TopicPartitionList,
    admin::{AdminClient, AdminOptions, NewTopic, TopicReplication},
    consumer::{BaseConsumer, CommitMode, Consumer},
    message::Message as _,
};
use recount_ingestion_api::{
    auth::{Authority, Source},
    broker::{KafkaSink, Topic},
    configured_router,
};
use recount_telemetry_schema::{
    ddl::ParticipantSchema,
    wire::{
        AnalyticalParticipant, ResourceKind, ResourceRef, SecurityScope,
        execution_participants_client::ExecutionParticipantsClient,
    },
};
use recount_telemetry_validation::policy::{BoundGrant, RequestedAuthorities, RootGrant};
use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::oneshot};
use tonic::{Request, Status, metadata::MetadataMap};
use uuid::Uuid;
#[path = "../../../tests/fixtures/telemetry/participants.rs"]
#[allow(dead_code)]
mod cases;

struct Nodes;
#[tonic::async_trait]
impl Authority for Nodes {
    async fn authenticate(&self, metadata: &MetadataMap) -> Result<Source, Status> {
        let (node, host) = match metadata.get("authorization").and_then(|v| v.to_str().ok()) {
            Some("Bearer first") => (cases::NODE, "node"),
            Some("Bearer second") => ("019a4790-d1da-7000-8000-000000000007", "node2"),
            _ => return Err(Status::unauthenticated("Invalid token")),
        };
        Ok(Source {
            node_id: Uuid::parse_str(node).unwrap(),
            security: SecurityScope {
                project_id: cases::PROJECT.into(),
                source_id: node.into(),
            },
            root: ResourceRef {
                id: host.into(),
                kind: ResourceKind::Host as i32,
            },
            adapter: "linux".into(),
            local_kinds: [ResourceKind::Process].into(),
            maximum_age_ns: 7 * 86400 * 1_000_000_000,
            skew_ns: 0,
        })
    }
    async fn grants(
        &self,
        _: &Source,
        _: &RequestedAuthorities,
    ) -> Result<(Vec<RootGrant>, Vec<BoundGrant>), Status> {
        unreachable!()
    }
    async fn ready(&self) -> bool {
        true
    }
}
fn setting(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing integration setting {name}"))
}
fn sql(query: &str) -> String {
    let encoded: String = query.bytes().map(|b| format!("%{b:02X}")).collect();
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--max-time",
            "10",
            "--user",
        ])
        .arg(format!(
            "{}:{}",
            setting("RECOUNT_CLICKHOUSE_TEST_USER"),
            setting("RECOUNT_CLICKHOUSE_TEST_PASSWORD")
        ))
        .arg(format!(
            "{}/?wait_end_of_query=1&query={encoded}",
            setting("RECOUNT_CLICKHOUSE_TEST_URL").trim_end_matches('/')
        ))
        .args(["--data-binary", "@-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"").unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "ClickHouse failed: {}",
        String::from_utf8_lossy(&result.stdout)
    );
    String::from_utf8(result.stdout).unwrap()
}
async fn until(check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "Participant storage did not settle"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[tokio::test]
#[ignore = "requires allocated Kafka/ClickHouse and a mounted participant schema"]
async fn participant_facts_replay_through_native_clickhouse() {
    assert_eq!(setting("RECOUNT_STORAGE_TEST_ALLOW_CREATE"), "1");
    let namespace = setting("RECOUNT_STORAGE_TEST_NAMESPACE");
    assert!(
        namespace.starts_with("recount.")
            && namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    );
    let suffix = Uuid::now_v7().simple().to_string();
    let topic = format!("{namespace}.participants.{suffix}");
    let group = format!("{topic}.consumer");
    let database = format!("recount_execution_{suffix}");
    eprintln!("participant_allocation database={database} topic={topic} group={group}");
    let broker = setting("RECOUNT_STORAGE_TEST_BROKER");
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .unwrap();
    let created = admin
        .create_topics(
            &[NewTopic::new(&topic, 1, TopicReplication::Fixed(1))
                .set("max.message.bytes", "6291456")],
            &AdminOptions::new(),
        )
        .await
        .unwrap();
    assert!(created.iter().all(Result::is_ok));
    let observer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .set("group.id", &group)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "error")
        .create()
        .unwrap();
    until(|| {
        observer
            .fetch_watermarks(&topic, 0, Duration::from_secs(1))
            .is_ok_and(|v| v == (0, 0))
    })
    .await;
    let mut offsets = TopicPartitionList::new();
    offsets
        .add_partition_offset(&topic, 0, Offset::Offset(0))
        .unwrap();
    assert_eq!(
        observer
            .committed_offsets(offsets.clone(), Duration::from_secs(3))
            .unwrap()
            .find_partition(&topic, 0)
            .unwrap()
            .offset(),
        Offset::Invalid
    );
    observer.assign(&offsets).unwrap();
    observer.commit(&offsets, CommitMode::Sync).unwrap();
    let schema = setting("RECOUNT_PARTICIPANT_TEST_SCHEMA");
    assert!(
        schema.ends_with(".proto")
            && schema
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    );
    sql(&format!("CREATE DATABASE {database}"));
    let ddl = ParticipantSchema {
        database: &database,
        bootstrap: &setting("RECOUNT_STORAGE_TEST_INTERNAL_BROKER"),
        topic: &topic,
        group: &group,
        partition_limit: 128,
    }
    .render()
    .unwrap()
    .replace(
        "executions.proto:AnalyticalParticipant",
        &format!("{schema}:AnalyticalParticipant"),
    );
    for statement in ddl.split(';').filter(|s| !s.trim().is_empty()) {
        sql(statement);
    }
    sql(&format!(
        "SYSTEM STOP MERGES {database}.execution_participants"
    ));
    let sink = Arc::new(
        KafkaSink::new(
            &broker,
            Topic {
                name: "unused.metrics",
                partitions: 1,
            },
            4194304,
            6291456,
            Topic {
                name: "unused.live",
                partitions: 1,
            },
            Topic {
                name: &topic,
                partitions: 1,
            },
        )
        .unwrap(),
    );
    let router = configured_router(Arc::new(Nodes), sink, Default::default(), 1)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        router
            .serve_with_incoming_shutdown(
                tokio_stream::wrappers::TcpListenerStream::new(listener),
                async {
                    let _ = stopped.await;
                },
            )
            .await
            .unwrap();
    });
    let mut client = ExecutionParticipantsClient::connect(endpoint)
        .await
        .unwrap();
    let now = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    )
    .unwrap();
    let mut first = cases::lifecycle();
    first.first_seen_unix_nano = now - 1000;
    first.last_seen_unix_nano = now;
    let mut second = first.clone();
    second.node_id = "019a4790-d1da-7000-8000-000000000007".into();
    second.host_id = "node2".into();
    let mut child = cases::child();
    child.first_seen_unix_nano = now - 1000;
    child.last_seen_unix_nano = now;
    let mut retracted = child.clone();
    retracted.revision = 2;
    retracted.retracted = true;
    let facts = [
        (first.clone(), "first"),
        (first, "first"),
        (second, "second"),
        (child.clone(), "first"),
        (retracted, "first"),
        (child, "first"),
    ];
    for _ in 0..2 {
        for (fact, token) in &facts {
            let mut request = Request::new(fact.clone());
            request
                .metadata_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
            client.claim(request).await.unwrap();
        }
    }
    let mut foreign = facts[0].0.clone();
    foreign.project_id = cases::CHILD.into();
    let mut request = Request::new(foreign);
    request
        .metadata_mut()
        .insert("authorization", "Bearer first".parse().unwrap());
    assert_eq!(
        client.claim(request).await.unwrap_err().code(),
        tonic::Code::PermissionDenied
    );
    until(|| {
        sql(&format!(
            "SELECT count(),countIf(NOT retracted) FROM {database}.execution_participants FINAL"
        ))
        .trim()
            == "3\t2"
    })
    .await;
    until(|| {
        observer
            .committed_offsets(offsets.clone(), Duration::from_secs(3))
            .unwrap()
            .find_partition(&topic, 0)
            .unwrap()
            .offset()
            == Offset::Offset(12)
    })
    .await;
    assert_eq!(sql(&format!("SELECT uniqExact(execution_key),uniqExact(node_id) FROM {database}.execution_participants FINAL")).trim(),"1\t2");
    let message = observer.poll(Duration::from_secs(5)).unwrap().unwrap();
    let row = AnalyticalParticipant::decode(message.payload().unwrap()).unwrap();
    assert_eq!(row.execution_key, "slurm:48213");
    assert_eq!(row.execution_name.as_deref(), Some("Distributed job"));
    assert!(row.process_resource_id.is_none());
    assert_eq!(row.environment_variable, "SLURM_JOB_ID");
    assert_eq!(sql(&format!("SELECT countIf(kind=1 AND isNull(process_resource_id)),countIf(environment_variable='SLURM_JOB_ID') FROM {database}.execution_participants FINAL")).trim(), "2\t3");
    drop(client);
    stop.send(()).unwrap();
    server.await.unwrap();
    sql(&format!("DROP DATABASE {database} SYNC"));
    assert!(
        admin
            .delete_topics(&[&topic], &AdminOptions::new())
            .await
            .unwrap()
            .iter()
            .all(Result::is_ok)
    );
}
