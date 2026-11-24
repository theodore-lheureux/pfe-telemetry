use super::{Identities, status};
use crate::{clock::SamplingClock, diagnostics::ReadStatus};
use nvml_wrapper::{
    Device, Nvml,
    enums::device::UsedGpuMemory,
    error::NvmlError,
    struct_wrappers::device::{ProcessInfo, ProcessUtilizationSample},
};
use procfs::process::Process;
use std::collections::BTreeMap;

const MAX_PROCESS_RECORDS: usize = 4096;

pub(super) struct Memory {
    pub bytes: Result<u64, ReadStatus>,
    pub time_ns: u64,
}
pub(super) struct Batch {
    pub uuid: String,
    pub memory: BTreeMap<i32, Memory>,
    pub utilization: Result<Vec<ProcessUtilizationSample>, ReadStatus>,
    pub finished_ns: u64,
    pub discovery: ReadStatus,
}

pub(super) fn devices(nvml: &Nvml) -> Result<(Vec<Device<'_>>, ReadStatus, bool), ReadStatus> {
    let count = nvml.device_count().map_err(|error| status(&error))?;
    if count > 128 {
        return Err(ReadStatus::OutOfRange);
    }
    let mut devices = vec![];
    let mut discovery = ReadStatus::Read;
    for index in 0..count {
        let device = match nvml.device_by_index(index) {
            Ok(device) => device,
            Err(error) => {
                discovery = status(&error);
                continue;
            }
        };
        match device.mig_mode() {
            Ok(mode) if mode.current == 1 => {
                let slots = match device.mig_device_count() {
                    Ok(slots) if slots <= 64 => slots,
                    Ok(_) => {
                        discovery = ReadStatus::OutOfRange;
                        continue;
                    }
                    Err(error) => {
                        discovery = status(&error);
                        continue;
                    }
                };
                for slot in 0..slots {
                    match device.mig_device_by_index(slot) {
                        Ok(child) => devices.push(child),
                        Err(NvmlError::NotFound) => {}
                        Err(error) => discovery = status(&error),
                    }
                }
            }
            Ok(mode) if mode.current == 0 => devices.push(device),
            Err(NvmlError::NotSupported) => devices.push(device),
            Err(error) => discovery = status(&error),
            Ok(_) => discovery = ReadStatus::Failed,
        }
    }
    Ok((devices, discovery, count > 0))
}

fn retry<T>(mut read: impl FnMut() -> Result<T, NvmlError>) -> Result<T, ReadStatus> {
    for attempt in 0..3 {
        match read() {
            Ok(value) => return Ok(value),
            Err(NvmlError::InsufficientSize(_)) if attempt < 2 => {}
            Err(error) => return Err(status(&error)),
        }
    }
    Err(ReadStatus::Unavailable)
}

pub(super) fn read(
    device: &Device<'_>,
    uuid: &str,
    clock: &mut SamplingClock,
    cursor: u64,
) -> Result<Batch, ReadStatus> {
    let mut memory: BTreeMap<i32, Memory> = BTreeMap::new();
    let mut discovery = ReadStatus::Read;
    for graphics in [false, true] {
        let result = process_list(device, graphics);
        let time_ns = clock.timestamp().map_err(|_| ReadStatus::Unavailable)?;
        match result {
            Ok(processes) => {
                for process in processes {
                    let Ok(pid) = i32::try_from(process.pid) else {
                        discovery = ReadStatus::OutOfRange;
                        continue;
                    };
                    let bytes = match process.used_gpu_memory {
                        UsedGpuMemory::Used(bytes) => Ok(bytes),
                        UsedGpuMemory::Unavailable => Err(ReadStatus::Unavailable),
                    };
                    let entry = memory.entry(pid).or_insert(Memory { bytes, time_ns });
                    // Both lists describe the same allocation; never sum them.
                    if entry.bytes.is_err() && bytes.is_ok() {
                        *entry = Memory { bytes, time_ns };
                    }
                }
            }
            Err(error) => discovery = error,
        }
    }
    let utilization = retry(|| device.process_utilization_stats(Some(cursor))).and_then(bounded);
    let finished_ns = clock.timestamp().map_err(|_| ReadStatus::Unavailable)?;
    Ok(Batch {
        uuid: uuid.into(),
        memory,
        utilization,
        finished_ns,
        discovery,
    })
}

fn bounded<T>(records: Vec<T>) -> Result<Vec<T>, ReadStatus> {
    if records.len() > MAX_PROCESS_RECORDS {
        return Err(ReadStatus::OutOfRange);
    }
    Ok(records)
}

fn process_list(device: &Device<'_>, graphics: bool) -> Result<Vec<ProcessInfo>, ReadStatus> {
    let count = if graphics {
        device.running_graphics_processes_count()
    } else {
        device.running_compute_processes_count()
    }
    .map_err(|error| status(&error))?;
    if count as usize > MAX_PROCESS_RECORDS {
        return Err(ReadStatus::OutOfRange);
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let records = if graphics {
        device.running_graphics_processes()
    } else {
        device.running_compute_processes()
    }
    .map_err(|error| status(&error))?;
    bounded(records)
}

pub(super) fn recheck(before: &Identities, batch: &Batch) -> Identities {
    let pids: std::collections::BTreeSet<_> = batch
        .memory
        .keys()
        .copied()
        .chain(
            batch
                .utilization
                .as_ref()
                .into_iter()
                .flatten()
                .filter_map(|sample| i32::try_from(sample.pid).ok()),
        )
        .collect();
    pids.into_iter()
        .filter_map(|pid| {
            let ticks = *before.get(&pid)?;
            let stat = Process::new(pid).and_then(|process| process.stat()).ok()?;
            (stat.pid == pid && stat.starttime == ticks).then_some((pid, ticks))
        })
        .collect()
}
