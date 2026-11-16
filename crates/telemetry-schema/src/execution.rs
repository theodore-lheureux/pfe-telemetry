//! Limits and transport names for environment-labelled execution participants.

pub const CLAIM_RPC: &str = "/recount.telemetry.ExecutionParticipants/Claim";
pub const TOPIC: &str = "recount.participants";
pub const CLICKHOUSE_GROUP: &str = "recount-clickhouse-participants";

pub const MAX_CLAIM_BYTES: usize = 65_536;
pub const MAX_ANALYTICAL_RECORD_BYTES: usize = 73_728;
pub const MAX_ENVIRONMENT_BYTES: usize = 65_536;
pub const MAX_ENVIRONMENT_VARIABLE_BYTES: usize = 128;
pub const MAX_EXECUTION_KEY_BYTES: usize = 128;
pub const MAX_NAME_BYTES: usize = 128;
pub const MAX_WORKLOAD_VERSION_BYTES: usize = 256;
pub const MAX_PARAMETERS: usize = 32;
pub const MAX_PARAMETER_KEY_BYTES: usize = 64;
pub const MAX_PARAMETER_VALUE_BYTES: usize = 1024;
pub const MAX_NAMESPACE_BYTES: usize = 128;

#[cfg(test)]
mod tests {
    use crate::wire::{
        ParticipantFact, ParticipantFactKind, ParticipantOrigin, ParticipantProvenance,
    };
    use prost::Message;

    #[test]
    fn lifecycle_without_root_preserves_environment_provenance_and_unknown_end() {
        let mut fact = ParticipantFact {
            kind: ParticipantFactKind::ParticipantLifecycle as i32,
            provenance: Some(ParticipantProvenance {
                origin: ParticipantOrigin::Environment as i32,
                environment_variable: "SLURM_JOB_ID".into(),
            }),
            first_seen_unix_nano: 10,
            last_seen_unix_nano: 10,
            ..Default::default()
        };
        let decoded = ParticipantFact::decode(fact.encode_to_vec().as_slice()).unwrap();
        assert!(decoded.subject.is_none());
        assert!(decoded.ended_unix_nano.is_none());
        assert_eq!(decoded.provenance, fact.provenance);
        fact.revision = 2;
        fact.ended_unix_nano = Some(100);
        assert_eq!(
            ParticipantFact::decode(fact.encode_to_vec().as_slice()).unwrap(),
            fact
        );
    }
}
