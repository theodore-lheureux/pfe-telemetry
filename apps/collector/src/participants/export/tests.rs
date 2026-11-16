use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use prost::Message;
use recount_telemetry_schema::wire::{
    ClaimParticipantResponse, ParticipantFact, ParticipantFactKind,
    execution_participants_server::{ExecutionParticipants, ExecutionParticipantsServer},
};
use tokio::sync::{Notify, watch};
use tonic::{
    Code, Request, Response, Status,
    transport::{Endpoint, Server},
};

use super::{Client, retryable};
use crate::participants::test_support::*;

#[derive(Clone, Default)]
struct Stub(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    received: Vec<Vec<u8>>,
    failures: Vec<Code>,
}

#[tonic::async_trait]
impl ExecutionParticipants for Stub {
    async fn claim(
        &self,
        request: Request<ParticipantFact>,
    ) -> Result<Response<ClaimParticipantResponse>, Status> {
        if request.metadata().get("authorization").unwrap() != "Bearer node-token" {
            return Err(Status::unauthenticated("Refused node token"));
        }
        assert!(request.metadata().get("grpc-encoding").is_none());
        let mut state = self.0.lock().unwrap();
        state.received.push(request.into_inner().encode_to_vec());
        if !state.failures.is_empty() {
            return Err(Status::new(
                state.failures.remove(0),
                "sensitive receiver error",
            ));
        }
        Ok(Response::new(ClaimParticipantResponse {}))
    }
}

async fn server(stub: Stub) -> (Endpoint, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        Server::builder()
            .add_service(ExecutionParticipantsServer::new(stub))
            .serve_with_incoming_shutdown(
                tonic::transport::server::TcpIncoming::from(listener),
                async {
                    let _ = stopped.await;
                },
            )
            .await
            .unwrap();
    });
    let endpoint = Endpoint::from_shared(format!("http://{address}")).unwrap();
    for _ in 0..100 {
        if endpoint.connect().await.is_ok() {
            return (endpoint, stop);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Claim stub failed to start");
}

#[tokio::test]
async fn lost_ack_replays_exact_fact_after_restart_before_membership_upload() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    fixture
        .engine()
        .scan(&mut store, &scan(30, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let stub = Stub::default();
    stub.0.lock().unwrap().failures.push(Code::Unavailable);
    let (endpoint, stop) = server(stub.clone()).await;
    let mut client = Client::new(endpoint.clone());
    let pending = store.front().await.unwrap().unwrap();
    let lifecycle = ParticipantFact::decode(pending.payload.as_slice()).unwrap();
    assert_eq!(
        lifecycle.kind,
        ParticipantFactKind::ParticipantLifecycle as i32
    );
    assert!(retryable(
        &client
            .claim(&pending.payload, "Bearer node-token".parse().unwrap())
            .await
            .unwrap_err()
    ));
    store.close().await.unwrap();
    let mut store = fixture.open().await;
    let retry = store.front().await.unwrap().unwrap();
    assert_eq!(retry.payload, pending.payload);
    drop(client);
    stub.0.lock().unwrap().failures.push(Code::Unavailable);
    let shared = Arc::new(tokio::sync::Mutex::new(store));
    let (_token, tokens) = watch::channel(Some("Bearer node-token".parse().unwrap()));
    let (_stop, stopped) = watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(10),
        super::run(
            Client::new(endpoint),
            shared.clone(),
            crate::enrollment::Authorization::new(tokens, Arc::new(Notify::new())),
            true,
            16,
            Arc::new(Notify::new()),
            stopped,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    {
        let state = stub.0.lock().unwrap();
        assert_eq!(state.received.len(), 4);
        assert!(
            state.received[..3]
                .iter()
                .all(|bytes| bytes == &pending.payload)
        );
        let member = ParticipantFact::decode(state.received[3].as_slice()).unwrap();
        assert_eq!(member.kind, ParticipantFactKind::ProcessMembership as i32);
        assert_eq!(member.participant_id, lifecycle.participant_id);
        assert_eq!(member.revision, 1);
    }
    let mut store = Arc::try_unwrap(shared).ok().unwrap().into_inner();
    assert!(store.front().await.unwrap().is_none());
    assert_eq!(store.facts().await.unwrap().len(), 2);
    store.close().await.unwrap();
    let _ = stop.send(());
}

#[tokio::test]
async fn exporter_renews_tokens_and_retains_inflight_bytes_while_observations_advance() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    engine
        .scan(&mut store, &scan(30, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let stub = Stub::default();
    stub.0.lock().unwrap().failures.push(Code::Unavailable);
    let (endpoint, stop_server) = server(stub.clone()).await;
    let shared = Arc::new(tokio::sync::Mutex::new(store));
    let (token, tokens) = watch::channel(Some("Bearer expired".parse().unwrap()));
    let stale = Arc::new(Notify::new());
    let authorization = crate::enrollment::Authorization::new(tokens, stale.clone());
    let (_stop, stopped) = watch::channel(false);
    let task = tokio::spawn(super::run(
        Client::new(endpoint),
        shared.clone(),
        authorization,
        true,
        16,
        Arc::new(Notify::new()),
        stopped,
    ));
    tokio::time::timeout(Duration::from_secs(5), stale.notified())
        .await
        .unwrap();
    token.send_replace(Some("Bearer node-token".parse().unwrap()));
    tokio::time::timeout(Duration::from_secs(5), async {
        while stub.0.lock().unwrap().received.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    engine
        .scan(
            &mut *shared.lock().await,
            &scan(60_000_000_040, &[(100, 1, "run:1")]),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    {
        let state = stub.0.lock().unwrap();
        assert!(state.received.len() >= 4);
        assert_eq!(state.received[0], state.received[1]);
        assert!(
            state
                .received
                .iter()
                .any(|bytes| ParticipantFact::decode(bytes.as_slice()).unwrap().revision == 2)
        );
    }
    Arc::try_unwrap(shared)
        .ok()
        .unwrap()
        .into_inner()
        .close()
        .await
        .unwrap();
    let _ = stop_server.send(());
}

#[test]
fn participant_retry_policy_is_not_the_otlp_retry_table() {
    for code in [Code::Unavailable, Code::DeadlineExceeded, Code::Cancelled] {
        assert!(retryable(&Status::new(code, "")));
    }
    for code in [
        Code::InvalidArgument,
        Code::PermissionDenied,
        Code::Unauthenticated,
        Code::ResourceExhausted,
        Code::FailedPrecondition,
        Code::Unknown,
        Code::DataLoss,
    ] {
        assert!(!retryable(&Status::new(code, "")));
    }
}
