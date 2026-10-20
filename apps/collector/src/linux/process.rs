use std::io;

use opentelemetry_proto::tonic::metrics::v1::{ResourceMetrics, number_data_point::Value};
use procfs::{ProcError, process::Process};

use super::Collector;
use crate::{
    diagnostics::ReadStatus,
    identity::same_incarnation,
    metrics::{counter, gauge, integer, resource, string},
};

const CPU_TIME: &str = "process.cpu.time";
const RESIDENT_MEMORY: &str = "pfe.process.memory.rss";
const DISK_IO: &str = "process.disk.io";

impl Collector {
    pub(super) fn process_metrics(
        &mut self,
        process: &Process,
    ) -> io::Result<Result<ResourceMetrics, ReadStatus>> {
        let stat_result = process.stat();
        let cpu_time = self.clock.timestamp()?;
        let stat = match stat_result {
            Ok(stat) if stat.pid > 0 && stat.ppid >= 0 => stat,
            Ok(_) => return Ok(Err(ReadStatus::Failed)),
            Err(error) => return Ok(Err(ReadStatus::from_error(&error))),
        };
        let memory = process.statm();
        let memory_time = self.clock.timestamp()?;
        let disk = process.io();
        let disk_time = self.clock.timestamp()?;
        // Do not create counter state or resource identity before this recheck.
        let recheck = process.stat();
        self.clock.timestamp()?;
        match recheck {
            Ok(current)
                if same_incarnation(stat.pid, stat.starttime, current.pid, current.starttime) => {}
            Ok(_) => return Ok(Err(ReadStatus::Failed)),
            Err(error) => return Ok(Err(ReadStatus::from_error(&error))),
        }
        let prefix = format!("process/{}/{}/{}", self.namespace, stat.pid, stat.starttime);
        let mut cpu_points = Vec::new();
        for (mode, ticks) in [("user", stat.utime), ("system", stat.stime)] {
            cpu_points.push(self.counter_point(
                format!("{prefix}/{CPU_TIME}/{mode}"),
                ticks,
                Value::AsDouble(ticks as f64 / self.ticks_per_second as f64),
                cpu_time,
                0,
                vec![string("cpu.mode", mode)],
            )?);
        }
        let mut metrics = vec![counter(CPU_TIME, "s", cpu_points)];
        let mut statuses = vec![self.read_status(CPU_TIME, ReadStatus::Read, cpu_time)];
        let memory_status = match memory {
            Ok(memory) => match memory
                .resident
                .checked_mul(self.page_size)
                .and_then(|bytes| i64::try_from(bytes).ok())
            {
                Some(bytes) => {
                    metrics.push(self.int_gauge(RESIDENT_MEMORY, "By", bytes, memory_time));
                    ReadStatus::Read
                }
                None => ReadStatus::OutOfRange,
            },
            Err(error) => ReadStatus::from_error(&error),
        };
        statuses.push(self.read_status(RESIDENT_MEMORY, memory_status, memory_time));
        let mut disk_points = Vec::new();
        let disk_status = match disk {
            Ok(disk) => {
                let mut status = ReadStatus::Read;
                for (direction, raw) in [("read", disk.read_bytes), ("write", disk.write_bytes)] {
                    match i64::try_from(raw) {
                        Ok(bytes) => disk_points.push(self.counter_point(
                            format!("{prefix}/{DISK_IO}/{direction}"),
                            raw,
                            Value::AsInt(bytes),
                            disk_time,
                            0,
                            vec![string("disk.io.direction", direction)],
                        )?),
                        Err(_) => status = ReadStatus::OutOfRange,
                    }
                }
                status
            }
            Err(error) => ReadStatus::from_error(&error),
        };
        if !disk_points.is_empty() {
            metrics.push(counter(DISK_IO, "By", disk_points));
        }
        statuses.push(self.read_status(DISK_IO, disk_status, disk_time));
        metrics.push(gauge("pfe.collection.read.status", "1", statuses));
        let mut attributes = self.attributes("process");
        attributes.extend([
            integer("process.pid", i64::from(stat.pid)),
            integer("process.parent_pid", i64::from(stat.ppid)),
            string("pfe.process.namespace_id", self.namespace.clone()),
            string(
                "pfe.process.incarnation_id",
                format!("start-ticks:{}", stat.starttime),
            ),
            string("pfe.process.start_time_ticks", stat.starttime.to_string()),
            integer(
                "pfe.linux.clock_ticks_per_second",
                self.ticks_per_second as i64,
            ),
        ]);
        // Derived wall-clock start times are omitted: btime/tick precision alone
        // does not establish a truthful wall-clock resolution across steps.
        Ok(Ok(resource(attributes, metrics)))
    }
}

pub(super) fn discovered_entry(error: &ProcError) -> bool {
    let path = match error {
        ProcError::PermissionDenied(path)
        | ProcError::NotFound(path)
        | ProcError::Incomplete(path)
        | ProcError::Io(_, path) => path.as_ref(),
        _ => None,
    };
    path.and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .and_then(|name| name.parse::<i32>().ok())
        .is_some_and(|pid| pid > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_does_not_invent_entries_for_directory_errors() {
        assert!(!discovered_entry(&ProcError::Io(
            io::Error::from(io::ErrorKind::PermissionDenied),
            None,
        )));
        assert!(discovered_entry(&ProcError::NotFound(Some(
            "/proc/42".into()
        ))));
        assert!(!discovered_entry(&ProcError::NotFound(Some(
            "/proc".into()
        ))));
    }
}
