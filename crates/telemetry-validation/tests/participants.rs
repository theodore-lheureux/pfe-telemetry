#[path = "../../../tests/fixtures/telemetry/participants.rs"]
mod cases;
use recount_telemetry_schema::wire::{ParticipantOrigin, ProcessExit, process_exit::Outcome};
use recount_telemetry_validation::{Category, execution};

#[test]
fn participant_projection_keeps_pid_incarnations_nodes_children_and_replay_separate() {
    let child = cases::child();
    let row = cases::analytical(child.clone());
    assert_eq!(row, cases::analytical(child.clone()));
    assert_eq!(row.execution_key, "slurm:48213");
    let mut reused = child.clone();
    reused
        .subject
        .as_mut()
        .unwrap()
        .process
        .as_mut()
        .unwrap()
        .start_time_ticks += 1;
    assert_ne!(
        row.process_resource_id,
        cases::analytical(reused).process_resource_id
    );
    let mut other = child.clone();
    other.node_id = "019a4790-d1da-7000-8000-000000000007".into();
    other.host_id = "node2".into();
    let other = cases::analytical(other);
    assert_eq!(row.execution_key, other.execution_key);
    assert_ne!(row.node_id, other.node_id);
    assert_ne!(row.process_resource_id, other.process_resource_id);
    let unassociated = recount_telemetry_schema::wire::ProcessIncarnation {
        pid: 999,
        ..child
            .subject
            .as_ref()
            .unwrap()
            .process
            .as_ref()
            .unwrap()
            .clone()
    };
    assert_ne!(
        row.process_resource_id.as_ref().unwrap(),
        &execution::process_resource(&child, &unassociated).unwrap()
    );
    let mut ancestry = child;
    let subject = ancestry.subject.as_mut().unwrap();
    subject.cgroup = None;
    let parent = cases::lifecycle().subject.unwrap().process;
    let provenance = ancestry.provenance.as_mut().unwrap();
    provenance.origin = ParticipantOrigin::Ancestry as i32;
    provenance.ancestry_root = parent.clone();
    provenance.parent = parent;
    let ancestry = cases::analytical(ancestry);
    assert_eq!(ancestry.process_resource_id, row.process_resource_id);
    assert!(ancestry.parent_resource_id.is_some());
    let mut missing_reference = cases::child();
    missing_reference.subject.as_mut().unwrap().cgroup = None;
    let provenance = missing_reference.provenance.as_mut().unwrap();
    provenance.origin = ParticipantOrigin::Ancestry as i32;
    provenance.launcher_claim_id = None;
    provenance.ancestry_root = cases::lifecycle().subject.unwrap().process;
    provenance.parent = provenance.ancestry_root.clone();
    assert!(execution::validate(&missing_reference).is_err());
}

#[test]
fn malformed_facts_fail_closed() {
    let fact = cases::lifecycle();
    for field in ["key", "uuid", "time", "cgroup", "provenance", "exit"] {
        let mut invalid = fact.clone();
        match field {
            "key" => invalid.execution_key = "foreign\nkey".into(),
            "uuid" => invalid.node_id = "00000000-0000-0000-0000-000000000000".into(),
            "time" => invalid.last_seen_unix_nano = 0,
            "cgroup" => {
                invalid
                    .subject
                    .as_mut()
                    .unwrap()
                    .cgroup
                    .as_mut()
                    .unwrap()
                    .path = "/a/../b".into()
            }
            "provenance" => invalid.provenance.as_mut().unwrap().origin = 99,
            _ => {
                invalid.exit = Some(ProcessExit {
                    time_unix_nano: cases::NOW,
                    outcome: Some(Outcome::Signal(0)),
                })
            }
        }
        assert_eq!(
            execution::validate(&invalid).unwrap_err().category,
            Category::Invalid,
            "{field}"
        );
    }
    let mut oversized = fact;
    oversized.metadata.as_mut().unwrap().name = Some("x".repeat(129));
    assert_eq!(
        execution::validate(&oversized).unwrap_err().category,
        Category::Limit
    );
}
