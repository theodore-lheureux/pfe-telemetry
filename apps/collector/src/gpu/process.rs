mod acquire;
mod attach;
#[cfg(test)]
mod tests;
mod window;

use crate::{clock::SamplingClock, diagnostics::ReadStatus};
use nvml_wrapper::{Nvml, error::NvmlError};
use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value;
use recount_telemetry_validation::catalogue::Definition;
use std::{collections::BTreeMap, ffi::OsStr, time::Duration};

pub(super) use attach::attach;
pub(super) type Identities = BTreeMap<i32, u64>;

#[derive(Default)]
pub(crate) struct Context {
    pub enabled: bool,
    pub identities: Identities,
}

pub(super) struct Reading {
    pub pid: i32,
    pub ticks: u64,
    pub uuid: String,
    pub metric: &'static Definition,
    pub time_ns: u64,
    pub value: Result<Value, ReadStatus>,
}

#[derive(Default)]
pub(super) struct Frame {
    pub readings: Vec<Reading>,
    pub status: Option<ReadStatus>,
    pub present: bool,
}

pub(super) struct Reader {
    nvml: Nvml,
    clock: SamplingClock,
    window: window::Window,
    generation: u64,
}

impl Reader {
    pub fn open(generation: u64) -> Result<Self, ReadStatus> {
        let nvml = Nvml::builder()
            .lib_path(OsStr::new("libnvidia-ml.so.1"))
            .init()
            .map_err(|error| status(&error))?;
        Ok(Self {
            nvml,
            clock: SamplingClock::new().map_err(|_| ReadStatus::Unavailable)?,
            window: window::Window::default(),
            generation,
        })
    }

    pub fn sample(
        &mut self,
        context: &Context,
        generation: u64,
        period: Duration,
    ) -> Result<Frame, ReadStatus> {
        if self.generation != generation {
            self.clock = SamplingClock::new().map_err(|_| ReadStatus::Unavailable)?;
            self.window = window::Window::default();
            self.generation = generation;
        }
        let started = self
            .clock
            .timestamp()
            .map_err(|_| ReadStatus::Unavailable)?;
        self.window.begin(&context.identities, started);
        let (devices, mut discovery, present) = acquire::devices(&self.nvml)?;
        let mut readings = vec![];
        let mut live = vec![];
        for device in devices {
            let uuid = match device.uuid() {
                Ok(uuid) => uuid,
                Err(error) => {
                    discovery = status(&error);
                    continue;
                }
            };
            if !recount_telemetry_validation::linux_adapter::gpu_uuid(&uuid) {
                discovery = ReadStatus::Unsupported;
                continue;
            }
            let batch = acquire::read(&device, &uuid, &mut self.clock, self.window.cursor(&uuid))?;
            match device.uuid() {
                Ok(current) if current == uuid => {}
                Ok(_) => {
                    discovery = ReadStatus::Disappeared;
                    continue;
                }
                Err(error) => {
                    discovery = status(&error);
                    continue;
                }
            }
            live.push(uuid);
            if batch.discovery != ReadStatus::Read {
                discovery = batch.discovery;
            }
            let after = acquire::recheck(&context.identities, &batch);
            readings.extend(
                self.window
                    .resolve(batch, &context.identities, &after, period),
            );
        }
        self.window.retain_devices(&live);
        self.clock
            .timestamp()
            .map_err(|_| ReadStatus::Unavailable)?;
        Ok(Frame {
            readings,
            status: Some(discovery),
            present,
        })
    }
}

pub(super) fn status(error: &NvmlError) -> ReadStatus {
    match error {
        NvmlError::NotSupported
        | NvmlError::FunctionNotFound
        | NvmlError::FailedToLoadSymbol(_)
        | NvmlError::LibraryNotFound
        | NvmlError::LibloadingError(_) => ReadStatus::Unsupported,
        NvmlError::NoPermission | NvmlError::OperatingSystem => ReadStatus::PermissionDenied,
        NvmlError::GpuLost => ReadStatus::Disappeared,
        NvmlError::NotFound
        | NvmlError::NoData
        | NvmlError::Timeout
        | NvmlError::InsufficientSize(_) => ReadStatus::Unavailable,
        _ => ReadStatus::Failed,
    }
}
