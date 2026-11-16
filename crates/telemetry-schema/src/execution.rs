//! Limits and transport names for execution participant claims.
//! Admission and local delivery are implemented by their respective services.

pub const CLAIM_RPC: &str = "/recount.telemetry.ExecutionParticipants/Claim";
pub const TOPIC: &str = "recount.participants";
pub const CLICKHOUSE_GROUP: &str = "recount-clickhouse-participants";

pub const MAX_CLAIM_BYTES: usize = 65_536;
pub const MAX_ANALYTICAL_RECORD_BYTES: usize = 73_728;
pub const MAX_EXECUTION_KEY_BYTES: usize = 128;
pub const MAX_NAME_BYTES: usize = 128;
pub const MAX_WORKLOAD_VERSION_BYTES: usize = 256;
pub const MAX_PARAMETERS: usize = 32;
pub const MAX_PARAMETER_KEY_BYTES: usize = 64;
pub const MAX_PARAMETER_VALUE_BYTES: usize = 1024;
pub const MAX_NAMESPACE_BYTES: usize = 128;
pub const MAX_CGROUP_PATH_BYTES: usize = 4096;
pub const MAX_ADAPTER_BYTES: usize = 64;
pub const MAX_SPOOL_CLAIMS_PER_UID: usize = 1024;
pub const MAX_SPOOL_BYTES_PER_UID: usize = 64 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use crate::wire::{
        LocalExecutionClaim, LocalParticipantSubject, LocalProcessIncarnation, ProcessExit,
        process_exit::Outcome,
    };
    use prost::Message;

    #[test]
    fn snapshots_preserve_unknown_end_and_successful_zero_exit() {
        let mut claim = LocalExecutionClaim {
            claim_id: "c79af849-a633-4551-a312-8fb3df8a30cd".into(),
            revision: 1,
            execution_key: "slurm:48213".into(),
            subject: Some(LocalParticipantSubject {
                process: Some(LocalProcessIncarnation {
                    pid: 42,
                    start_time_ticks: 17,
                }),
                dedicated_cgroup: true,
            }),
            first_seen_unix_nano: 10,
            last_seen_unix_nano: 10,
            ..Default::default()
        };
        let decoded = LocalExecutionClaim::decode(claim.encode_to_vec().as_slice()).unwrap();
        assert_eq!(decoded.ended_unix_nano, None);
        assert_eq!(decoded.exit, None);
        assert_eq!(decoded.subject, claim.subject);
        claim.revision = 2;
        claim.ended_unix_nano = Some(100);
        claim.exit = Some(ProcessExit {
            time_unix_nano: 100,
            outcome: Some(Outcome::Code(0)),
        });
        assert_eq!(
            LocalExecutionClaim::decode(claim.encode_to_vec().as_slice()).unwrap(),
            claim
        );
    }
}
