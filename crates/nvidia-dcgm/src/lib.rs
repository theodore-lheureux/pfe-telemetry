//! Optional DCGM 4 acquisition. Native handles and memory never escape this crate.
//!
//! [`Session::open`] loads the installed runtime, reuses the local host engine or
//! owns an embedded engine. [`Session::sample`] returns validated, owned readings.
//! It neither installs software nor changes accounting, MIG or profiler policy.

#![cfg(target_os = "linux")]

mod decode;
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod ffi;
mod field;
mod listener;
#[cfg(target_os = "linux")]
mod session;

pub use field::{FIELDS, Field};
#[cfg(target_os = "linux")]
pub use session::Session;

/// Acquisition failure, independent of a numeric measurement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Absent,
    Unsupported,
    PermissionDenied,
    Disappeared,
    Unavailable,
    Disconnected,
    OutOfRange,
    Invalid,
    Native(i32),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DCGM {self:?}")
    }
}
impl std::error::Error for Error {}

pub(crate) fn status(code: i32) -> Result<(), Error> {
    match code {
        0 => Ok(()),
        -6 | -13 | -20 | -22 | -32 | -36 | -44 => Err(Error::Unsupported),
        -17 | -29 => Err(Error::PermissionDenied),
        -18 | -45 | -46 | -67 => Err(Error::Disappeared),
        -21 => Err(Error::Disconnected),
        -9 | -11 | -14 | -15 | -16 | -33 | -34 | -38 | -54 => Err(Error::Unavailable),
        other => Err(Error::Native(other)),
    }
}

/// Native scalar values retain integer precision until catalogue conversion.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Integer(i64),
    Double(f64),
}

#[derive(Clone, Debug)]
pub struct Reading {
    pub field: Field,
    /// Native Unix nanoseconds; never scrape/receipt time.
    pub time_ns: u64,
    pub value: Result<Value, Error>,
}

#[derive(Clone, Debug)]
pub struct Device {
    pub uuid: String,
    pub parent_uuid: Option<String>,
    pub readings: Vec<Reading>,
    /// Profiling capability discovery or watch setup can fail independently.
    pub profiling: Result<(), Error>,
    pub multiplexed: bool,
}

/// Readable devices survive a partial inventory failure without claiming
/// complete coverage of inaccessible devices or an unreadable MIG hierarchy.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub devices: Vec<Device>,
    pub discovery: Result<(), Error>,
}

#[cfg(test)]
mod tests;
