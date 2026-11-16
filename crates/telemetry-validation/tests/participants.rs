#[path = "../../../tests/fixtures/telemetry/participants.rs"]
mod cases;
use prost::Message;
use recount_telemetry_schema::wire::{ParticipantOrigin, ParticipantSubject};
use recount_telemetry_validation::{Category, execution};

#[test]
fn participant_projection_keeps_pid_incarnations_nodes_children_and_replay_separate() {
    let child = cases::child();
    let row = cases::analytical(child.clone());
    assert_eq!(row, cases::analytical(child.clone()));
    assert_eq!(row.execution_key, "slurm:48213");
    assert_eq!(row.origin, ParticipantOrigin::Environment as i32);
    assert_eq!(row.environment_variable, "SLURM_JOB_ID");
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
    let lifecycle = cases::analytical(cases::lifecycle());
    assert!(lifecycle.process_resource_id.is_none());
    assert!(lifecycle.process_pid.is_none());
    assert_eq!(lifecycle.execution_name.as_deref(), Some("Distributed job"));
}

#[test]
fn malformed_facts_fail_closed() {
    for field in [
        "key",
        "uuid",
        "time",
        "subject",
        "provenance",
        "variable",
        "empty_variable",
    ] {
        let mut invalid = cases::lifecycle();
        match field {
            "key" => invalid.execution_key = "foreign\nkey".into(),
            "uuid" => invalid.node_id = "00000000-0000-0000-0000-000000000000".into(),
            "time" => invalid.last_seen_unix_nano = 0,
            "subject" => invalid.subject = Some(ParticipantSubject::default()),
            "provenance" => invalid.provenance.as_mut().unwrap().origin = 99,
            "variable" => {
                invalid.provenance.as_mut().unwrap().environment_variable = "BAD=VALUE".into()
            }
            _ => invalid
                .provenance
                .as_mut()
                .unwrap()
                .environment_variable
                .clear(),
        }
        assert_eq!(
            execution::validate(&invalid).unwrap_err().category,
            Category::Invalid,
            "{field}"
        );
    }
    let mut oversized = cases::lifecycle();
    oversized.metadata.as_mut().unwrap().name = Some("x".repeat(129));
    assert_eq!(
        execution::validate(&oversized).unwrap_err().category,
        Category::Limit
    );
}

#[test]
fn rootless_lifecycle_membership_and_retraction_have_distinct_subject_rules() {
    let lifecycle = cases::lifecycle();
    execution::validate(&lifecycle).unwrap();
    for field in [
        "missing_subject",
        "empty_subject",
        "metadata",
        "identity",
        "pid",
        "end",
    ] {
        let mut fact = cases::child();
        match field {
            "missing_subject" => fact.subject = None,
            "empty_subject" => fact.subject = Some(ParticipantSubject::default()),
            "metadata" => fact.metadata = lifecycle.metadata.clone(),
            "identity" => fact.fact_id = fact.participant_id.clone(),
            "pid" => fact.subject.as_mut().unwrap().process.as_mut().unwrap().pid = 0,
            _ => fact.ended_unix_nano = Some(fact.last_seen_unix_nano),
        }
        assert!(execution::validate(&fact).is_err(), "{field}");
    }
    let mut fact = cases::child();
    fact.revision = 2;
    fact.retracted = true;
    fact.ended_unix_nano = Some(fact.last_seen_unix_nano + 1);
    let row = cases::analytical(fact.clone());
    assert!(row.retracted);
    assert_eq!(row.revision, 2);
    assert_eq!(row.ended_unix_nano, fact.ended_unix_nano);
    let provenance =
        recount_telemetry_schema::wire::ParticipantProvenance::decode(row.provenance.as_slice())
            .unwrap();
    assert_eq!(Some(provenance), fact.provenance);
}

#[test]
fn environment_provenance_is_bounded_and_does_not_change_process_identity() {
    let mut fact = cases::child();
    let original = cases::analytical(fact.clone());
    for variable in ["RECOUNT_EXECUTION", "PBS_JOBID", "LSB_JOBID", "_JOB"] {
        fact.provenance.as_mut().unwrap().environment_variable = variable.into();
        let row = cases::analytical(fact.clone());
        assert_eq!(row.environment_variable, variable);
        assert_eq!(row.process_resource_id, original.process_resource_id);
    }
    fact.owner_uid = Some(0);
    execution::validate(&fact).unwrap();
    fact.owner_uid = None;
    execution::validate(&fact).unwrap();
    for variable in ["9INVALID", "BAD.NAME", " SECRET", "SECRET\n", ""] {
        fact.provenance.as_mut().unwrap().environment_variable = variable.into();
        assert_eq!(
            execution::validate(&fact).unwrap_err().category,
            Category::Invalid
        );
    }
    fact.provenance.as_mut().unwrap().environment_variable = "A".repeat(129);
    assert_eq!(
        execution::validate(&fact).unwrap_err().category,
        Category::Limit
    );
}
