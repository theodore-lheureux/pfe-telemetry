use recount_telemetry_schema::wire::{
    AnalyticalParticipant, ExecutionMetadata, ParticipantFact, ParticipantFactKind,
    ParticipantOrigin, ParticipantProvenance, ParticipantSubject, ProcessIncarnation,
};

pub const PROJECT: &str = "019a4790-d1da-7000-8000-000000000002";
pub const NODE: &str = "019a4790-d1da-7000-8000-000000000003";
pub const PARTICIPANT: &str = "019a4790-d1da-7000-8000-000000000004";
pub const CHILD: &str = "019a4790-d1da-7000-8000-000000000005";
pub const NOW: u64 = 1_794_700_000_000_000_000;

pub fn lifecycle() -> ParticipantFact {
    ParticipantFact {
        project_id: PROJECT.into(),
        node_id: NODE.into(),
        host_id: "node".into(),
        boot_id: "01234567-89ab-cdef-0123-456789abcdef".into(),
        execution_key: "slurm:48213".into(),
        participant_id: PARTICIPANT.into(),
        fact_id: PARTICIPANT.into(),
        revision: 1,
        kind: ParticipantFactKind::ParticipantLifecycle as i32,
        provenance: Some(ParticipantProvenance {
            origin: ParticipantOrigin::Environment as i32,
            environment_variable: "SLURM_JOB_ID".into(),
        }),
        owner_uid: Some(1000),
        first_seen_unix_nano: NOW,
        last_seen_unix_nano: NOW + 1000,
        metadata: Some(ExecutionMetadata {
            name: Some("Distributed job".into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn child() -> ParticipantFact {
    let mut fact = lifecycle();
    fact.fact_id = CHILD.into();
    fact.kind = ParticipantFactKind::ProcessMembership as i32;
    fact.metadata = None;
    fact.subject = Some(ParticipantSubject {
        process: Some(ProcessIncarnation {
            namespace_id: "pidns:1".into(),
            pid: 43,
            start_time_ticks: 100,
        }),
    });
    fact
}

pub fn analytical(fact: ParticipantFact) -> AnalyticalParticipant {
    recount_telemetry_validation::execution::project(
        &fact,
        "019a4790-d1da-7000-8000-000000000006",
        NOW + 2000,
    )
    .unwrap()
}
