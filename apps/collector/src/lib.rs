//! External Linux resource sampling and persistent OTLP export.
//!
//! Environment-labelled execution facts are independent of measurement identities.

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
#[cfg(unix)]
pub mod enrollment;
#[cfg(target_os = "linux")]
mod gpu;
#[cfg(any(target_os = "linux", test))]
mod identity;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod metrics;
#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
mod participants;
#[cfg(target_os = "linux")]
pub mod runtime;
#[cfg(target_os = "linux")]
pub mod spool;
#[cfg(unix)]
pub mod transport;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[cfg(target_os = "linux")]
pub use delivery::{LossReason, LossTracker, Scan, ScanContents, point_count};
#[cfg(target_os = "linux")]
pub use linux::{Collector, CollectorConfig};
