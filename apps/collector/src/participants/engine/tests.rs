use recount_telemetry_schema::wire::{ExecutionMetadata, ParticipantFactKind};

use crate::participants::{discovery::Incarnation, test_support::*};

#[tokio::test]
async fn lifecycle_spans_labelled_incarnations_and_reappearance_gets_fresh_identity() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    let mut first = scan(10, &[(100, 1, "run:1"), (200, 2, "run:1")]);
    first
        .processes
        .get_mut(&Incarnation { pid: 100, ticks: 1 })
        .unwrap()
        .label
        .as_mut()
        .unwrap()
        .metadata = Some(ExecutionMetadata {
        name: Some("first".into()),
        ..Default::default()
    });
    first
        .processes
        .get_mut(&Incarnation { pid: 200, ticks: 2 })
        .unwrap()
        .uid = Some(2000);
    engine.scan(&mut store, &first).await.unwrap();
    let facts = store.facts().await.unwrap();
    assert_eq!(facts.len(), 3);
    let lifecycle = facts.iter().find(|f| f.subject.is_none()).unwrap().clone();
    assert_eq!(lifecycle.owner_uid, Some(1000));
    assert_eq!(
        lifecycle.metadata.as_ref().unwrap().name.as_deref(),
        Some("first")
    );
    assert_eq!(lifecycle.fact_id, lifecycle.participant_id);
    assert!(
        facts
            .iter()
            .filter(|f| f.subject.is_some())
            .all(|f| f.metadata.is_none()
                && f.fact_id != f.participant_id
                && f.participant_id == lifecycle.fact_id)
    );
    acknowledge(&mut store).await;
    engine
        .scan(&mut store, &scan(20, &[(200, 2, "run:1")]))
        .await
        .unwrap();
    let facts = store.facts().await.unwrap();
    let updated = facts.iter().find(|f| f.subject.is_none()).unwrap();
    assert!(updated.ended_unix_nano.is_none());
    assert_eq!(updated.metadata, lifecycle.metadata);
    assert_eq!(updated.owner_uid, lifecycle.owner_uid);
    assert!(facts.iter().any(|f| f.ended_unix_nano == Some(20)));
    acknowledge(&mut store).await;
    engine.scan(&mut store, &scan(30, &[])).await.unwrap();
    assert!(
        store
            .facts()
            .await
            .unwrap()
            .iter()
            .all(|f| f.ended_unix_nano == Some(30))
    );
    engine
        .scan(&mut store, &scan(40, &[(200, 3, "run:1")]))
        .await
        .unwrap();
    let facts = store.facts().await.unwrap();
    assert!(facts.iter().any(
        |f| f.kind == ParticipantFactKind::ParticipantLifecycle as i32
            && f.fact_id != lifecycle.fact_id
            && f.first_seen_unix_nano == 40
            && f.ended_unix_nano.is_none()
    ));
    acknowledge(&mut store).await;
    assert_eq!(store.facts().await.unwrap().len(), 2);
    store.close().await.unwrap();
}

#[tokio::test]
async fn global_cap_skips_once_without_evicting_live_facts_and_pruning_releases_capacity() {
    let mut fixture = Fixture::new();
    fixture.settings.max_facts = 3;
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    engine
        .scan(
            &mut store,
            &scan(10, &[(100, 1, "run:1"), (200, 2, "run:2")]),
        )
        .await
        .unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 2);
    engine
        .scan(
            &mut store,
            &scan(
                20,
                &[(100, 1, "run:1"), (200, 2, "run:2"), (300, 3, "run:1")],
            ),
        )
        .await
        .unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 3);
    engine
        .scan(&mut store, &scan(30, &[(200, 2, "run:2")]))
        .await
        .unwrap();
    acknowledge(&mut store).await;
    assert!(store.facts().await.unwrap().is_empty());
    engine
        .scan(&mut store, &scan(40, &[(200, 2, "run:2")]))
        .await
        .unwrap();
    assert!(
        store.facts().await.unwrap().is_empty(),
        "Cap-skipped incarnation must not be associated later"
    );
    engine
        .scan(&mut store, &scan(50, &[(200, 3, "run:2")]))
        .await
        .unwrap();
    assert_eq!(store.facts().await.unwrap().len(), 2);
    store.close().await.unwrap();
}

#[tokio::test]
async fn cap_skipped_process_keeps_existing_lifecycle_alive_and_unverified_does_not_extend_time() {
    let mut fixture = Fixture::new();
    fixture.settings.max_facts = 2;
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    engine
        .scan(&mut store, &scan(10, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    engine
        .scan(
            &mut store,
            &scan(20, &[(100, 1, "run:1"), (200, 2, "run:1")]),
        )
        .await
        .unwrap();
    acknowledge(&mut store).await;
    engine
        .scan(&mut store, &scan(30, &[(200, 2, "run:1")]))
        .await
        .unwrap();
    acknowledge(&mut store).await;
    let facts = store.facts().await.unwrap();
    assert_eq!(facts.len(), 1);
    assert!(facts[0].ended_unix_nano.is_none());
    let mut unverified = scan(40, &[(200, 2, "run:1")]);
    unverified.processes.values_mut().next().unwrap().verified = false;
    engine.scan(&mut store, &unverified).await.unwrap();
    assert_eq!(store.facts().await.unwrap()[0].last_seen_unix_nano, 30);
    engine.scan(&mut store, &scan(50, &[])).await.unwrap();
    acknowledge(&mut store).await;
    assert!(store.facts().await.unwrap().is_empty());
    store.close().await.unwrap();
}
