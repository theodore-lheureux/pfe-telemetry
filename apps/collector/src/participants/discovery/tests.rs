use procfs::process::Process;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
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
    let observation =
        discovery(&fixture).observe(&process, Incarnation { pid: 100, ticks: 1 }, 0, || {
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
    // The shell reports the forked PID before the child's exec has necessarily completed.
    let deadline = Instant::now() + Duration::from_secs(3);
    while !fs::read_to_string(format!("/proc/{}/comm", family.child))
        .is_ok_and(|comm| comm == "sleep\n")
        || !fs::read(format!("/proc/{}/environ", family.child)).is_ok_and(|bytes| {
            bytes
                .split(|&b| b == 0)
                .any(|entry| entry == b"RECOUNT_EXECUTION=run:inherited")
        })
    {
        assert!(Instant::now() < deadline, "Child exec did not become ready");
        std::thread::sleep(Duration::from_millis(10));
    }
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

#[tokio::test]
async fn unlabelled_unreadable_and_between_scan_processes_create_no_facts() {
    let fixture = Fixture::new();
    fixture.process(100, 1, b"UNRELATED=value\0");
    fixture.process(200, 2, b"RECOUNT_EXECUTION=run:unreadable\0");
    fs::remove_file(fixture.proc_root().join("200/environ")).unwrap();
    fixture.process(300, 3, b"RECOUNT_EXECUTION=run:short-lived\0");
    fs::remove_dir_all(fixture.proc_root().join("300")).unwrap();
    let scan = discovery(&fixture).scan().unwrap();
    assert_eq!(scan.processes.len(), 2);
    assert!(
        scan.processes
            .values()
            .all(|p| p.verified && p.label.is_none())
    );
    let mut store = fixture.open().await;
    fixture.engine().scan(&mut store, &scan).await.unwrap();
    assert!(store.facts().await.unwrap().is_empty());
    assert_eq!(store.remaining().await.unwrap(), 0);
    store.close().await.unwrap();
}

#[tokio::test]
async fn restart_does_not_transfer_membership_across_pid_boot_or_namespace_identity() {
    for changed in ["ticks", "boot", "namespace"] {
        let fixture = Fixture::new();
        fixture.process(100, 1, b"RECOUNT_EXECUTION=run:old\0");
        let mut first = discovery(&fixture).scan().unwrap();
        first.time = 10;
        let mut store = fixture.open().await;
        fixture.engine().scan(&mut store, &first).await.unwrap();
        let retained = store.facts().await.unwrap();
        store.close().await.unwrap();

        let mut scope = fixture.scope.clone();
        let ticks = if changed == "ticks" { 2 } else { 1 };
        if changed == "boot" {
            scope.boot = uuid::Uuid::new_v4().to_string();
        }
        if changed == "namespace" {
            scope.namespace = "replacement-namespace".into();
        }
        fixture.process(100, ticks, b"RECOUNT_EXECUTION=run:new\0");
        let mut restored = Discovery::new(&scope, fixture.settings.clone(), &retained).unwrap();
        restored.root = fixture.proc_root();
        let mut next = restored.scan().unwrap();
        next.time = 100;
        assert_eq!(next.processes.len(), 1, "{changed}");
        assert_eq!(
            next.processes
                .values()
                .next()
                .unwrap()
                .label
                .as_ref()
                .unwrap()
                .key,
            "run:new",
            "{changed}"
        );
        let mut store = fixture.open().await;
        crate::participants::engine::Engine::new(scope.clone(), fixture.settings.max_facts)
            .scan(&mut store, &next)
            .await
            .unwrap();
        let facts = store.facts().await.unwrap();
        let old = facts
            .iter()
            .find(|f| f.execution_key == "run:old" && f.subject.is_some())
            .unwrap();
        assert_eq!(old.last_seen_unix_nano, 10, "{changed}");
        assert_eq!(
            old.ended_unix_nano,
            Some(if changed == "ticks" { 100 } else { 11 }),
            "{changed}"
        );
        let new = facts
            .iter()
            .find(|f| f.execution_key == "run:new" && f.subject.is_some())
            .unwrap();
        assert!(
            !retained.iter().any(|f| f.fact_id == new.fact_id),
            "{changed}"
        );
        assert_eq!(new.revision, 1);
        assert_eq!(new.boot_id, scope.boot);
        let process = new.subject.as_ref().unwrap().process.as_ref().unwrap();
        assert_eq!(process.namespace_id, scope.namespace);
        assert_eq!(process.start_time_ticks, ticks);
        assert_eq!(new.first_seen_unix_nano, 100);
        store.close().await.unwrap();
    }
}

#[tokio::test]
async fn exec_keeps_cached_incarnation_but_fresh_discovery_sees_cleared_environment() {
    let fixture = Fixture::new();
    let mut root = Command::new("sh")
        .args([
            "-c",
            "echo ready; read line; exec env -i PATH=/usr/bin:/bin sleep 60",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("RECOUNT_EXECUTION", "run:exec")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(root.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready.trim(), "ready");
    let mut process = Family {
        child: root.id() as i32,
        root,
    };
    let mut cached = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    let first = cached.scan().unwrap();
    let id = *first
        .processes
        .keys()
        .find(|id| id.pid == process.child)
        .unwrap();
    assert_eq!(first.processes[&id].label.as_ref().unwrap().key, "run:exec");
    process
        .root
        .stdin
        .take()
        .unwrap()
        .write_all(b"go\n")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let environment = fs::read(format!("/proc/{}/environ", process.child)).unwrap();
            if environment == b"PATH=/usr/bin:/bin\0" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let next = cached.scan().unwrap();
    assert!(next.processes[&id].label == first.processes[&id].label);
    let fresh = Discovery::new(&fixture.scope, fixture.settings.clone(), &[])
        .unwrap()
        .scan()
        .unwrap();
    assert!(fresh.processes[&id].label.is_none());
}
