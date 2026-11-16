//! Durable local launcher snapshots. No backend access or kernel attestation.
//!
//! Provision the root and each decimal UID directory before use. Open an
//! [`Inbox`], then use [`Inbox::try_lock`] for collector scans. Hold the guard
//! across enumeration, copying snapshots into collector state and terminal
//! removal. Kernel identity verification, member UID checks and durable
//! collector ownership belong to the caller.

mod directory;
mod validation;

pub use directory::{Inbox, LockedInbox};
pub use recount_telemetry_schema::wire::{
    ExecutionMetadata, ExecutionParameter, LocalExecutionClaim, LocalParticipantSubject,
    LocalProcessIncarnation, ProcessExit, process_exit,
};
pub use validation::{validate, validate_metadata};
