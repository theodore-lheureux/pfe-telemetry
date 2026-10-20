//! External Linux resource sampling and persistent OTLP export.
//!
//! Process discovery does not associate processes with distributed executions.

#[cfg(any(target_os = "linux", test))]
mod clock;
#[cfg(target_os = "linux")]
pub mod config;
#[cfg(any(target_os = "linux", test))]
mod continuity;
#[cfg(target_os = "linux")]
mod delivery;
#[cfg(target_os = "linux")]
mod diagnostics;
#[cfg(any(target_os = "linux", test))]
mod identity;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod metrics;
#[cfg(target_os = "linux")]
pub mod runtime;
#[cfg(target_os = "linux")]
pub mod spool;

#[cfg(target_os = "linux")]
pub use delivery::{LossReason, LossTracker, Scan, point_count};
#[cfg(target_os = "linux")]
pub use linux::{Collector, CollectorConfig};
