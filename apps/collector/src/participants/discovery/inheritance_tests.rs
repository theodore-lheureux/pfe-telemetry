use super::*;
use crate::participants::test_support::*;

fn labelled_parent(fixture: &Fixture) -> Discovery {
    fixture.process(100, 1, b"SLURM_JOB_ID=123\0");
    let mut discovery = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    discovery.root = fixture.proc_root();
    discovery.scan().unwrap();
    discovery
}

fn child(fixture: &Fixture, environment: &[u8]) -> Incarnation {
    fixture.process(200, 10, environment);
    stat_with_parent(&fixture.proc_root().join("200/stat"), 200, 10, 100);
    Incarnation {
        pid: 200,
        ticks: 10,
    }
}

#[tokio::test]
async fn renamed_child_inherits_cached_label_and_provenance_once() {
    let fixture = Fixture::new();
    let mut discovery = labelled_parent(&fixture);
    let id = child(&fixture, b"stress-ng-cpu\0\0");
    let scan = discovery.scan().unwrap();
    let label = scan.processes[&id].label.as_ref().unwrap();
    assert_eq!(label.key, "slurm:123");
    assert_eq!(label.variable, "SLURM_JOB_ID");
    assert_eq!(
        scan.processes[&id].uid,
        scan.processes[&Incarnation { pid: 100, ticks: 1 }].uid
    );

    let mut store = fixture.open().await;
    fixture.engine().scan(&mut store, &scan).await.unwrap();
    let facts = store.facts().await.unwrap();
    assert_eq!(facts.len(), 3);
    assert!(facts.iter().all(|fact| {
        fact.execution_key == "slurm:123"
            && fact.provenance.as_ref().unwrap().environment_variable == "SLURM_JOB_ID"
    }));
    store.close().await.unwrap();

    child(&fixture, b"RECOUNT_EXECUTION=run:not-reread\0");
    let next = discovery.scan().unwrap();
    assert!(next.processes[&id].label == scan.processes[&id].label);
}

#[test]
fn reused_parent_pid_cannot_transfer_a_cached_label() {
    let fixture = Fixture::new();
    let discovery = labelled_parent(&fixture);
    let id = child(&fixture, b"renamed\0");
    // Reuse after cache verification, still earlier than the child.
    fixture.process(100, 2, b"RECOUNT_EXECUTION=run:unrelated\0");
    let uid = discovery.cache[&Incarnation { pid: 100, ticks: 1 }].uid;
    assert!(discovery.inherited_label(100, id, uid).is_none());
}

#[test]
fn inheritance_requires_a_verified_parent_not_newer_than_child_and_matching_known_uids() {
    let fixture = Fixture::new();
    let mut discovery = labelled_parent(&fixture);
    let id = child(&fixture, b"renamed\0");
    let parent_id = Incarnation { pid: 100, ticks: 1 };
    let uid = discovery.cache[&parent_id].uid.unwrap();
    assert!(discovery.inherited_label(100, id, Some(uid)).is_some());
    assert!(discovery.inherited_label(100, id, Some(uid + 1)).is_none());
    assert!(discovery.inherited_label(100, id, None).is_none());
    assert!(
        discovery
            .inherited_label(100, Incarnation { ticks: 0, ..id }, Some(uid))
            .is_none()
    );
    discovery.cache.get_mut(&parent_id).unwrap().verified = false;
    assert!(discovery.inherited_label(100, id, Some(uid)).is_none());
    discovery.cache.get_mut(&parent_id).unwrap().verified = true;
    discovery.cache.get_mut(&parent_id).unwrap().uid = Some(uid + 1);
    assert!(discovery.inherited_label(100, id, Some(uid)).is_none());
}

#[test]
fn same_tick_child_inherits_parent_label() {
    let fixture = Fixture::new();
    let mut discovery = labelled_parent(&fixture);
    child(&fixture, b"stress-ng-cpu\0\0");
    stat_with_parent(&fixture.proc_root().join("200/stat"), 200, 1, 100);
    let scan = discovery.scan().unwrap();
    assert_eq!(
        scan.processes[&Incarnation { pid: 200, ticks: 1 }]
            .label
            .as_ref()
            .unwrap()
            .key,
        "slurm:123"
    );
}

#[test]
fn child_enumerated_before_parent_inherits_in_the_same_scan() {
    let fixture = Fixture::new();
    fixture.process(100, 0, b"");
    fixture.process(200, 0, b"");
    let pids: Vec<i32> = fs::read_dir(fixture.proc_root())
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_str()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    let (child_pid, parent_pid) = (pids[0], pids[1]);
    fixture.process(child_pid, 10, b"stress-ng-cpu\0\0");
    stat_with_parent(
        &fixture.proc_root().join(format!("{child_pid}/stat")),
        child_pid,
        10,
        parent_pid,
    );
    fixture.process(parent_pid, 1, b"SLURM_JOB_ID=123\0");
    let mut discovery = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    discovery.root = fixture.proc_root();
    let scan = discovery.scan().unwrap();
    assert_eq!(
        scan.processes[&Incarnation {
            pid: child_pid,
            ticks: 10,
        }]
            .label
            .as_ref()
            .unwrap()
            .key,
        "slurm:123"
    );
}

#[test]
fn explicit_invalid_labels_never_inherit_or_use_scheduler_fallback() {
    for environment in [
        b"RECOUNT_EXECUTION= bad\0SLURM_JOB_ID=456\0".as_slice(),
        b"RECOUNT_EXECUTION=\0",
        b"RECOUNT_EXECUTION=\xff\0",
        b"renamed\0RECOUNT_EXECUTION= bad\0",
        b"RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION=run:2\0",
        b"RECOUNT_EXECUTION=run:1\0RECOUNT_EXECUTION_PARAMETERS=invalid\0",
    ] {
        let fixture = Fixture::new();
        let mut discovery = labelled_parent(&fixture);
        let id = child(&fixture, environment);
        assert!(discovery.scan().unwrap().processes[&id].label.is_none());
    }
}

#[test]
fn readable_child_label_takes_precedence_over_parent() {
    let fixture = Fixture::new();
    let mut discovery = labelled_parent(&fixture);
    let id = child(&fixture, b"RECOUNT_EXECUTION=run:child\0");
    let scan = discovery.scan().unwrap();
    let label = scan.processes[&id].label.as_ref().unwrap();
    assert_eq!(label.key, "run:child");
    assert_eq!(label.variable, "RECOUNT_EXECUTION");
}
