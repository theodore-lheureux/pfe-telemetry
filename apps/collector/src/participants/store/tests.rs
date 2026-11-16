use prost::Message;
use recount_telemetry_schema::wire::{ParticipantFact, ParticipantFactKind};

use crate::participants::test_support::*;

#[tokio::test]
async fn acknowledgement_preserves_inflight_bytes_and_prunes_only_final_acknowledged_revisions() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    engine
        .scan(&mut store, &scan(10, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let initial = store.front().await.unwrap().unwrap();
    assert_eq!(
        ParticipantFact::decode(initial.payload.as_slice())
            .unwrap()
            .kind,
        ParticipantFactKind::ParticipantLifecycle as i32
    );
    engine.scan(&mut store, &scan(20, &[])).await.unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 2);
    assert_eq!(
        store.front().await.unwrap().unwrap().payload,
        initial.payload
    );
    store.close().await.unwrap();
    let mut store = fixture.open().await;
    assert_eq!(
        store.front().await.unwrap().unwrap().payload,
        initial.payload
    );
    store.accept(&initial).await.unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 2);
    let membership = store.front().await.unwrap().unwrap();
    assert_eq!(
        ParticipantFact::decode(membership.payload.as_slice())
            .unwrap()
            .kind,
        ParticipantFactKind::ProcessMembership as i32
    );
    store.accept(&membership).await.unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 2);
    acknowledge(&mut store).await;
    assert!(store.facts().await.unwrap().is_empty());
    assert_eq!(store.remaining().await.unwrap(), 0);
    let statuses: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM participant_status")
        .fetch_one(store.spool.connection())
        .await
        .unwrap();
    assert_eq!(statuses, 0);
    store.close().await.unwrap();
}

#[tokio::test]
async fn revisions_and_metadata_identity_are_enforced_and_retraction_is_retained() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    fixture
        .engine()
        .scan(&mut store, &scan(10, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let original = store
        .facts()
        .await
        .unwrap()
        .into_iter()
        .find(|f| f.subject.is_none())
        .unwrap();
    let mut changed = original.clone();
    changed.last_seen_unix_nano = 20;
    assert!(store.commit(&[changed.clone()]).await.is_err());
    changed.revision = 2;
    changed.execution_key = "run:foreign".into();
    assert!(store.commit(&[changed]).await.is_err());
    let mut retracted = original;
    retracted.revision = 2;
    retracted.retracted = true;
    retracted.ended_unix_nano = Some(20);
    store.commit(&[retracted.clone()]).await.unwrap();
    acknowledge(&mut store).await;
    assert!(store.facts().await.unwrap().contains(&retracted));
    store.close().await.unwrap();
}

#[tokio::test]
async fn deterministic_rejection_is_retained_and_never_unlocks_memberships() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    fixture
        .engine()
        .scan(&mut store, &scan(10, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let lifecycle = store.front().await.unwrap().unwrap();
    store
        .reject(&lifecycle, tonic::Code::FailedPrecondition)
        .await
        .unwrap();
    assert!(store.front().await.unwrap().is_none());
    assert_eq!(store.remaining().await.unwrap(), 1);
    assert_eq!(store.facts().await.unwrap().len(), 2);
    let rejected: Vec<u8> = sqlx::query_scalar("SELECT payload FROM participant_rejections")
        .fetch_one(store.spool.connection())
        .await
        .unwrap();
    assert_eq!(rejected, lifecycle.payload);
    store.close().await.unwrap();
}

#[tokio::test]
async fn new_boot_ends_previous_coverage_without_extending_it_through_downtime() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    fixture
        .engine()
        .scan(&mut store, &scan(10, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let mut scope = fixture.scope.clone();
    scope.boot = uuid::Uuid::new_v4().to_string();
    let mut engine = crate::participants::engine::Engine::new(scope, fixture.settings.max_facts);
    engine
        .scan(&mut store, &scan(100, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    let facts = store.facts().await.unwrap();
    assert_eq!(facts.len(), 4);
    assert!(
        facts
            .iter()
            .filter(|f| f.boot_id == fixture.scope.boot)
            .all(|f| f.ended_unix_nano == Some(11) && f.last_seen_unix_nano == 10)
    );
    store.close().await.unwrap();
}
