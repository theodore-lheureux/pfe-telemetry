use super::{Collector, CollectorConfig};
use crate::{clock::SamplingClock, continuity::Continuity, delivery::LossTracker, metrics::string};
use procfs::{CurrentSI, KernelStats, process::Process};
use recount_telemetry_validation::{
    authority::identifier,
    linux_adapter::{self as adapter, IdentifierKind},
};
use std::{fs, io};

pub(crate) fn host_id_or_machine_id(host_id: Option<String>) -> io::Result<String> {
    match host_id {
        Some(id) if identifier(&id) => Ok(id),
        Some(_) => Err(io::Error::other(
            "Enrolled host ID must be 1-128 bytes without control characters",
        )),
        None => adapter::parse_identifier(
            &fs::read_to_string("/etc/machine-id")?,
            IdentifierKind::Machine,
        )
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("Invalid Linux machine identifier")),
    }
}

impl Collector {
    /// Read required Linux identity once, before any optional GPU acquisition.
    pub fn new(config: CollectorConfig, loss: LossTracker) -> io::Result<Self> {
        let CollectorConfig {
            interval,
            host_id,
            namespace_id,
            host_visibility,
        } = config;
        let host_id = host_id_or_machine_id(host_id)?;
        let boot_id = adapter::parse_identifier(
            &fs::read_to_string("/proc/sys/kernel/random/boot_id")?,
            IdentifierKind::Boot,
        )
        .ok_or_else(|| io::Error::other("Invalid Linux boot identifier"))?
        .to_owned();
        let own = Process::myself()
            .and_then(|process| process.stat())
            .map_err(|_| io::Error::other("Cannot verify procfs PID namespace"))?;
        if u32::try_from(own.pid).ok() != Some(std::process::id()) {
            return Err(io::Error::other(
                "Procfs PID namespace differs from collector namespace",
            ));
        }
        let namespace = match namespace_id {
            Some(id) if identifier(&id) => id,
            Some(_) => {
                return Err(io::Error::other(
                    "Process namespace ID must be 1-128 bytes without control characters",
                ));
            }
            None if host_visibility => "host".into(),
            None => {
                return Err(io::Error::other(
                    "Restricted visibility requires RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID",
                ));
            }
        };
        if host_visibility && namespace != "host" {
            return Err(io::Error::other(
                "Host visibility requires initial host PID namespace",
            ));
        }
        let interval_ns = i64::try_from(interval.as_nanos())
            .map_err(|_| io::Error::other("Sampling interval exceeds int64"))?;
        if interval_ns <= 0 {
            return Err(io::Error::other("Sampling interval must be positive"));
        }
        let stats =
            KernelStats::current().map_err(|_| io::Error::other("Cannot read Linux boot time"))?;
        let boot_time_ns = stats
            .btime
            .checked_mul(1_000_000_000)
            .ok_or_else(|| io::Error::other("Boot time exceeds timestamp range"))?;
        let ticks_per_second = procfs::ticks_per_second();
        let page_size = procfs::page_size();
        if ticks_per_second == 0 || ticks_per_second > i64::MAX as u64 || page_size == 0 {
            return Err(io::Error::other("Invalid Linux clock tick or page size"));
        }
        let epoch = uuid::Uuid::new_v4().to_string();
        let mut clock = SamplingClock::new()?;
        let epoch_start = clock.timestamp()?;
        loss.start_epoch(&epoch);
        let mut host = vec![
            string(adapter::HOST_ID, host_id),
            string(adapter::BOOT_ID, boot_id.clone()),
            string("os.type", "linux"),
            string("recount.collection.source", "rust-procfs"),
        ];
        if let Ok(name) = fs::read_to_string("/proc/sys/kernel/hostname") {
            let name = name.trim();
            if !name.is_empty() && name.len() <= 128 {
                host.push(string("host.name", name));
            }
        }
        Ok(Self {
            host,
            boot: boot_id,
            namespace,
            visibility: if host_visibility {
                "host"
            } else {
                "restricted"
            },
            interval_ns,
            boot_time_ns,
            ticks_per_second,
            page_size,
            epoch,
            epoch_start,
            clock,
            continuity: Continuity::default(),
            loss_generation: loss.generation(),
            loss,
            cycle_points: 0,
            gpu: None,
            gpu_authorization: None,
        })
    }
}
