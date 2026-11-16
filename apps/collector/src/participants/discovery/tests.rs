use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

use super::*;
use crate::participants::test_support::*;
use tracing::instrument::WithSubscriber;

fn discovery(fixture: &Fixture) -> Discovery {
    let mut discovery = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    discovery.root = fixture.proc_root();
    discovery
}

#[test]
fn decisions_are_once_per_incarnation_including_unknown_and_pid_reuse() {
    let fixture = Fixture::new();
    fixture.process(100, 1, b"RECOUNT_EXECUTION=run:1\0");
    fixture.process(200, 2, b"RECOUNT_EXECUTION=run:truncated");
    fixture.process(300, 3, b"RECOUNT_EXECUTION=run:unreadable\0");
    fs::remove_file(fixture.proc_root().join("300/environ")).unwrap();
    let mut discovery = discovery(&fixture);
    let first = discovery.scan().unwrap();
    assert_eq!(first.processes.len(), 3);
    assert_eq!(
        first.processes[&Incarnation { pid: 100, ticks: 1 }]
            .label
            .as_ref()
            .unwrap()
            .key,
        "run:1"
    );
    assert!(
        first.processes[&Incarnation { pid: 200, ticks: 2 }]
            .label
            .is_none()
    );
    assert!(
        first.processes[&Incarnation { pid: 300, ticks: 3 }]
            .label
            .is_none()
    );
    fixture.process(100, 1, b"RECOUNT_EXECUTION=run:changed\0");
    fixture.process(200, 2, b"RECOUNT_EXECUTION=run:repaired\0");
    fixture.process(300, 3, b"RECOUNT_EXECUTION=run:readable\0");
    let second = discovery.scan().unwrap();
    assert!(
        second.processes[&Incarnation { pid: 100, ticks: 1 }].label
            == first.processes[&Incarnation { pid: 100, ticks: 1 }].label
    );
    assert!(
        second.processes[&Incarnation { pid: 200, ticks: 2 }]
            .label
            .is_none()
    );
    assert!(
        second.processes[&Incarnation { pid: 300, ticks: 3 }]
            .label
            .is_none()
    );
    fixture.process(100, 4, b"RECOUNT_EXECUTION=run:new-incarnation\0");
    let third = discovery.scan().unwrap();
    assert!(
        !third
            .processes
            .contains_key(&Incarnation { pid: 100, ticks: 1 })
    );
    assert_eq!(
        third.processes[&Incarnation { pid: 100, ticks: 4 }]
            .label
            .as_ref()
            .unwrap()
            .key,
        "run:new-incarnation"
    );
}

#[test]
fn identity_recheck_discards_a_label_if_pid_changes_during_read() {
    let fixture = Fixture::new();
    fixture.process(100, 1, b"RECOUNT_EXECUTION=run:1\0");
    let process = Process::new_with_root(fixture.proc_root().join("100")).unwrap();
    let observation = observe(&process, Incarnation { pid: 100, ticks: 1 }, || {
        fixture.process(100, 2, b"RECOUNT_EXECUTION=run:other\0");
        environment::read(
            b"RECOUNT_EXECUTION=run:other\0".as_slice(),
            &fixture.settings.scheduler_variables,
        )
    });
    assert!(observation.label.is_none());
    assert!(observation.uid.is_none());
    assert!(!observation.verified);
}

#[test]
fn bounded_enumeration_resumes_and_cached_unknown_is_not_evicted_at_capacity() {
    let mut fixture = Fixture::new();
    fixture.settings.max_processes = 2;
    for pid in 100..110 {
        fixture.process(pid, 1, b"PRIVATE_SECRET=discard\0");
    }
    let mut discovery = discovery(&fixture);
    for _ in 0..10 {
        assert!(discovery.scan().unwrap().processes.len() <= 2);
    }
    let id = *discovery.cache.keys().next().unwrap();
    fixture.process(id.pid, 1, b"RECOUNT_EXECUTION=run:not-reread\0");
    assert!(discovery.scan().unwrap().processes[&id].label.is_none());
    fs::remove_dir_all(fixture.proc_root().join(id.pid.to_string())).unwrap();
    for _ in 0..10 {
        discovery.scan().unwrap();
    }
    assert_eq!(discovery.cache.len(), 2);
    assert!(!discovery.cache.contains_key(&id));
}

struct Family {
    root: Child,
    child: i32,
}
impl Drop for Family {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.to_string()])
            .status();
        let _ = self.root.kill();
        let _ = self.root.wait();
    }
}

#[tokio::test]
async fn inherited_environment_labels_parent_and_forked_child_with_independent_memberships() {
    let fixture = Fixture::new();
    let mut root = Command::new("sh")
        .args(["-c", "sleep 60 & echo $!; wait"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("RECOUNT_EXECUTION", "run:inherited")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut pid = String::new();
    BufReader::new(root.stdout.take().unwrap())
        .read_line(&mut pid)
        .unwrap();
    let family = Family {
        root,
        child: pid.trim().parse().unwrap(),
    };
    let mut discovery = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    let mut scan = discovery.scan().unwrap();
    scan.processes
        .retain(|id, _| [family.root.id() as i32, family.child].contains(&id.pid));
    assert_eq!(scan.processes.len(), 2);
    assert!(
        scan.processes
            .values()
            .all(|p| p.label.as_ref().unwrap().key == "run:inherited")
    );
    let mut store = fixture.open().await;
    fixture.engine().scan(&mut store, &scan).await.unwrap();
    let facts = store.facts().await.unwrap();
    assert_eq!(facts.len(), 3);
    assert_eq!(facts.iter().filter(|f| f.subject.is_some()).count(), 2);
    store.close().await.unwrap();
}

#[tokio::test]
async fn secrets_and_discarded_names_never_reach_logs_or_durable_state() {
    let mut fixture = Fixture::new();
    fixture.settings.max_facts = 2;
    fixture.process(
        100,
        1,
        b"PRIVATE_SECRET=private-sentinel-value\0RECOUNT_EXECUTION=run:1\0",
    );
    fixture.process(
        200,
        2,
        b"RECOUNT_EXECUTION=run:2\0PRIVATE_SECRET=private-sentinel-value\0",
    );
    fixture.process(
        300,
        3,
        b"RECOUNT_EXECUTION=run:3\0RECOUNT_EXECUTION_PARAMETERS={private-sentinel-value}\0",
    );
    let logs = Logs::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(logs.clone())
        .finish();
    async {
        let mut discovery = discovery(&fixture);
        let scan = discovery.scan().unwrap();
        let mut store = fixture.open().await;
        fixture.engine().scan(&mut store, &scan).await.unwrap();
        let pending = store.front().await.unwrap().unwrap();
        store
            .reject(&pending, tonic::Code::InvalidArgument)
            .await
            .unwrap();
        let facts = store.facts().await.unwrap();
        assert_eq!(facts.len(), 2);
        store.close().await.unwrap();
    }
    .with_subscriber(subscriber)
    .await;
    let log = logs.0.lock().unwrap().clone();
    assert!(String::from_utf8_lossy(&log).contains("Global fact cap"));
    let database = fs::read(fixture.path.join("queue/queue.sqlite3")).unwrap();
    for secret in ["PRIVATE_SECRET", "private-sentinel-value"] {
        assert!(!String::from_utf8_lossy(&log).contains(secret));
        assert!(!String::from_utf8_lossy(&database).contains(secret));
    }
}

#[tokio::test]
async fn restart_reuses_durable_incarnation_evidence_without_rereading_environment() {
    let fixture = Fixture::new();
    fixture.process(100, 1, b"RECOUNT_EXECUTION=run:1\0");
    let mut discovery = discovery(&fixture);
    let first = discovery.scan().unwrap();
    let mut store = fixture.open().await;
    fixture.engine().scan(&mut store, &first).await.unwrap();
    let facts = store.facts().await.unwrap();
    store.close().await.unwrap();
    fixture.process(100, 1, b"RECOUNT_EXECUTION=run:changed\0");
    let mut restored = Discovery::new(&fixture.scope, fixture.settings.clone(), &facts).unwrap();
    restored.root = fixture.proc_root();
    let next = restored.scan().unwrap();
    assert_eq!(
        next.processes
            .values()
            .next()
            .unwrap()
            .label
            .as_ref()
            .unwrap()
            .key,
        "run:1"
    );
    let mut store = fixture.open().await;
    fixture.engine().scan(&mut store, &next).await.unwrap();
    let revised = store.facts().await.unwrap();
    assert_eq!(
        facts.iter().map(|f| &f.fact_id).collect::<Vec<_>>(),
        revised.iter().map(|f| &f.fact_id).collect::<Vec<_>>()
    );
    assert!(revised.iter().all(|f| f.revision == 1));
    store.close().await.unwrap();
}
