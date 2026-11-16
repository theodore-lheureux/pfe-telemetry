#[path = "../../../../tests/fixtures/telemetry/participants.rs"]
#[allow(dead_code)]
mod cases;
use super::*;
use recount_telemetry_schema::wire::execution_participants_client::ExecutionParticipantsClient;

struct ParticipantAuthority {
    allowed: Source,
}
#[tonic::async_trait]
impl Authority for ParticipantAuthority {
    async fn authenticate(&self, metadata: &MetadataMap) -> std::result::Result<Source, Status> {
        if auth::one(metadata, "authorization")? != Some("Bearer test") {
            return Err(Status::unauthenticated("Invalid credentials"));
        }
        Ok(self.allowed.clone())
    }
    async fn grants(
        &self,
        _: &Source,
        _: &RequestedAuthorities,
    ) -> std::result::Result<(Vec<RootGrant>, Vec<BoundGrant>), Status> {
        unreachable!()
    }
    async fn ready(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn claims_require_own_project_node_root_and_grants_before_confirmed_publication() {
    let mut allowed = source();
    allowed.security.source_id = cases::NODE.into();
    allowed.local_kinds.remove(&ResourceKind::Container);
    let sink = Arc::new(TestSink::default());
    let (_, endpoint, stop, task) = server(
        Arc::new(ParticipantAuthority { allowed }),
        sink.clone(),
        Limits::default(),
    )
    .await;
    let mut client = ExecutionParticipantsClient::connect(endpoint)
        .await
        .unwrap();
    let mut fact = cases::lifecycle();
    fact.first_seen_unix_nano = unix_nanos().unwrap() - 1000;
    fact.last_seen_unix_nano = fact.first_seen_unix_nano;
    let request = |fact| {
        let mut request = Request::new(fact);
        request
            .metadata_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        request
    };
    for field in ["project", "node", "host", "malformed"] {
        let mut bad = fact.clone();
        let code = if field == "malformed" {
            Code::InvalidArgument
        } else {
            Code::PermissionDenied
        };
        match field {
            "project" => bad.project_id = cases::CHILD.into(),
            "node" => bad.node_id = cases::CHILD.into(),
            "host" => bad.host_id = "other".into(),
            _ => bad.execution_key = "".into(),
        }
        assert_eq!(client.claim(request(bad)).await.unwrap_err().code(), code);
    }
    assert!(sink.participants.lock().unwrap().is_empty());
    assert_eq!(
        client
            .claim(Request::new(fact.clone()))
            .await
            .unwrap_err()
            .code(),
        Code::Unauthenticated
    );
    client.claim(request(fact.clone())).await.unwrap();
    client.claim(request(fact.clone())).await.unwrap();
    assert_eq!(sink.participants.lock().unwrap().len(), 2);
    let mut member = cases::child();
    member.first_seen_unix_nano = fact.first_seen_unix_nano;
    member.last_seen_unix_nano = fact.last_seen_unix_nano;
    client.claim(request(member)).await.unwrap();
    {
        let rows = sink.participants.lock().unwrap();
        assert!(rows[0].process_resource_id.is_none());
        assert_eq!(rows[0].environment_variable, "SLURM_JOB_ID");
        assert!(rows[2].process_resource_id.is_some());
    }
    sink.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        client.claim(request(fact)).await.unwrap_err().code(),
        Code::Unavailable
    );
    assert_eq!(sink.participants.lock().unwrap().len(), 3);
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn missing_local_grants_and_expired_or_oversized_claims_never_publish() {
    for policy in [
        "process",
        "adapter",
        "expired",
        "oversized",
        "future_end",
        "subject",
        "variable",
    ] {
        let mut allowed = source();
        allowed.security.source_id = cases::NODE.into();
        allowed.local_kinds.remove(&ResourceKind::Container);
        match policy {
            "process" => {
                allowed.local_kinds.remove(&ResourceKind::Process);
            }
            "adapter" => allowed.adapter = "standard".into(),
            _ => {}
        }
        let maximum_age_ns = allowed.maximum_age_ns;
        let skew_ns = allowed.skew_ns;
        let sink = Arc::new(TestSink::default());
        let (_, endpoint, stop, task) = server(
            Arc::new(ParticipantAuthority { allowed }),
            sink.clone(),
            Limits::default(),
        )
        .await;
        let mut client = ExecutionParticipantsClient::connect(endpoint)
            .await
            .unwrap();
        let mut fact = cases::lifecycle();
        let now = unix_nanos().unwrap();
        fact.first_seen_unix_nano = now - 1000;
        fact.last_seen_unix_nano = fact.first_seen_unix_nano;
        let code = match policy {
            "expired" => {
                fact.first_seen_unix_nano = now - maximum_age_ns - 1;
                fact.last_seen_unix_nano = fact.first_seen_unix_nano;
                Code::FailedPrecondition
            }
            "oversized" => {
                fact.metadata.as_mut().unwrap().name = Some("x".repeat(70000));
                Code::ResourceExhausted
            }
            "future_end" => {
                fact.ended_unix_nano = Some(now + skew_ns + 60_000_000_000);
                Code::InvalidArgument
            }
            "subject" => {
                fact.subject = cases::child().subject;
                Code::InvalidArgument
            }
            "variable" => {
                fact.provenance.as_mut().unwrap().environment_variable =
                    "SLURM_JOB_ID=private".into();
                Code::InvalidArgument
            }
            _ => Code::PermissionDenied,
        };
        let mut request = Request::new(fact);
        request
            .metadata_mut()
            .insert("authorization", "Bearer test".parse().unwrap());
        assert_eq!(
            client.claim(request).await.unwrap_err().code(),
            code,
            "{policy}"
        );
        assert!(sink.participants.lock().unwrap().is_empty());
        stop.send(()).unwrap();
        task.await.unwrap();
    }
}
