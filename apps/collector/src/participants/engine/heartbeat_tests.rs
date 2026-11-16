use prost::Message;
use recount_telemetry_schema::wire::ParticipantFact;

use crate::participants::test_support::*;

const SECOND: u64 = 1_000_000_000;

#[tokio::test]
async fn heartbeats_throttle_open_facts_but_not_final_coverage() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    let processes = [(100, 1, "run:1")];
    engine
        .scan(&mut store, &scan(SECOND, &processes))
        .await
        .unwrap();
    acknowledge(&mut store).await;
    for second in 2..=60 {
        engine
            .scan(&mut store, &scan(second * SECOND, &processes))
            .await
            .unwrap();
        let facts = store.facts().await.unwrap();
        assert!(
            facts
                .iter()
                .all(|f| f.last_seen_unix_nano == second * SECOND && f.revision == 1)
        );
        assert_eq!(store.remaining().await.unwrap(), 0);
    }
    // Local coverage must survive restart without advancing the publication cursor.
    store.close().await.unwrap();
    let mut store = fixture.open().await;
    assert!(
        store
            .facts()
            .await
            .unwrap()
            .iter()
            .all(|f| f.last_seen_unix_nano == 60 * SECOND && f.revision == 1)
    );
    engine
        .scan(&mut store, &scan(61 * SECOND, &processes))
        .await
        .unwrap();
    assert_eq!(store.remaining().await.unwrap(), 2);
    let heartbeat = store.front().await.unwrap().unwrap();
    let heartbeat = ParticipantFact::decode(heartbeat.payload.as_slice()).unwrap();
    assert_eq!(heartbeat.revision, 2);
    assert_eq!(heartbeat.last_seen_unix_nano, 61 * SECOND);
    acknowledge(&mut store).await;
    engine
        .scan(&mut store, &scan(62 * SECOND, &processes))
        .await
        .unwrap();
    assert_eq!(store.remaining().await.unwrap(), 0);
    engine
        .scan(&mut store, &scan(63 * SECOND, &[]))
        .await
        .unwrap();
    assert_eq!(store.remaining().await.unwrap(), 2);
    while let Some(pending) = store.front().await.unwrap() {
        let fact = ParticipantFact::decode(pending.payload.as_slice()).unwrap();
        assert_eq!(fact.revision, 3);
        assert_eq!(fact.last_seen_unix_nano, 62 * SECOND);
        assert_eq!(fact.ended_unix_nano, Some(63 * SECOND));
        store.accept(&pending).await.unwrap();
    }
    assert!(store.facts().await.unwrap().is_empty());
    store.close().await.unwrap();
}

#[tokio::test]
async fn local_observations_never_mutate_retries_or_enqueue_on_acknowledgement() {
    let mut fixture = Fixture::new();
    fixture.settings.heartbeat_interval_seconds = 10;
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    let processes = [(100, 1, "run:1")];
    engine
        .scan(&mut store, &scan(SECOND, &processes))
        .await
        .unwrap();
    let initial = store.front().await.unwrap().unwrap();
    engine
        .scan(&mut store, &scan(9 * SECOND, &processes))
        .await
        .unwrap();
    assert_eq!(
        store.front().await.unwrap().unwrap().payload,
        initial.payload
    );
    store.accept(&initial).await.unwrap();
    let member = store.front().await.unwrap().unwrap();
    let member_fact = ParticipantFact::decode(member.payload.as_slice()).unwrap();
    assert_eq!(member_fact.last_seen_unix_nano, SECOND);
    store.accept(&member).await.unwrap();
    assert_eq!(store.remaining().await.unwrap(), 0);
    assert!(
        store
            .facts()
            .await
            .unwrap()
            .iter()
            .all(|f| f.last_seen_unix_nano == 9 * SECOND && f.revision == 1)
    );
    engine
        .scan(&mut store, &scan(11 * SECOND, &processes))
        .await
        .unwrap();
    assert_eq!(store.remaining().await.unwrap(), 2);
    let heartbeat = store.front().await.unwrap().unwrap();
    engine
        .scan(&mut store, &scan(12 * SECOND, &processes))
        .await
        .unwrap();
    assert_eq!(
        store.front().await.unwrap().unwrap().payload,
        heartbeat.payload
    );
    // The final replacement must bypass throttling even with an unacknowledged heartbeat.
    engine
        .scan(&mut store, &scan(13 * SECOND, &[]))
        .await
        .unwrap();
    acknowledge(&mut store).await;
    assert!(store.facts().await.unwrap().is_empty());
    store.close().await.unwrap();
}

#[tokio::test]
async fn coverage_corrections_and_retraction_bypass_the_heartbeat() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    fixture
        .engine()
        .scan(&mut store, &scan(2 * SECOND, &[(100, 1, "run:1")]))
        .await
        .unwrap();
    acknowledge(&mut store).await;
    let mut lifecycle = store
        .facts()
        .await
        .unwrap()
        .into_iter()
        .find(|f| f.subject.is_none())
        .unwrap();
    lifecycle.first_seen_unix_nano = SECOND;
    lifecycle.revision += 1;
    store.commit(&[lifecycle.clone()]).await.unwrap();
    let corrected = store.front().await.unwrap().unwrap();
    assert_eq!(
        ParticipantFact::decode(corrected.payload.as_slice()).unwrap(),
        lifecycle
    );
    store.accept(&corrected).await.unwrap();
    lifecycle.last_seen_unix_nano = SECOND + SECOND / 2;
    lifecycle.revision += 1;
    store.commit(&[lifecycle.clone()]).await.unwrap();
    let corrected = store.front().await.unwrap().unwrap();
    assert_eq!(
        ParticipantFact::decode(corrected.payload.as_slice()).unwrap(),
        lifecycle
    );
    store.accept(&corrected).await.unwrap();
    lifecycle.retracted = true;
    lifecycle.revision += 1;
    store.commit(&[lifecycle.clone()]).await.unwrap();
    let retracted = store.front().await.unwrap().unwrap();
    assert_eq!(
        ParticipantFact::decode(retracted.payload.as_slice()).unwrap(),
        lifecycle
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn eighty_second_job_publishes_start_heartbeat_and_end_not_per_scan_revisions() {
    let fixture = Fixture::new();
    let mut store = fixture.open().await;
    let mut engine = fixture.engine();
    let processes: Vec<_> = (100..107).map(|pid| (pid, 1, "run:1")).collect();
    let mut published = 0;
    for second in 1..=81 {
        let live = if second <= 80 {
            processes.as_slice()
        } else {
            &[]
        };
        engine
            .scan(&mut store, &scan(second * SECOND, live))
            .await
            .unwrap();
        while let Some(pending) = store.front().await.unwrap() {
            let fact = ParticipantFact::decode(pending.payload.as_slice()).unwrap();
            assert!(fact.revision <= 3);
            published += 1;
            store.accept(&pending).await.unwrap();
        }
    }
    assert_eq!(published, 24);
    assert!(store.facts().await.unwrap().is_empty());
    store.close().await.unwrap();
}
