use std::io;

use opentelemetry_proto::tonic::metrics::v1::{Metric, number_data_point::Value};
use procfs::{Current, CurrentSI, KernelStats, Meminfo};

use super::Collector;
use crate::{
    diagnostics::ReadStatus,
    metrics::{counter, gauge, string},
};

const CPU_TIME: &str = "pfe.node.cpu.time";
const TOTAL_MEMORY: &str = "pfe.node.memory.total";
const AVAILABLE_MEMORY: &str = "pfe.node.memory.available";
const DISK_IO: &str = "system.disk.io";

impl Collector {
    pub(super) fn node_metrics(&mut self) -> io::Result<Vec<Metric>> {
        let mut metrics = Vec::new();
        let mut statuses = Vec::new();
        let stats = KernelStats::current();
        let time = self.clock.timestamp()?;
        match stats {
            Ok(stats) => {
                let cpu = stats.total;
                let mut status = ReadStatus::Read;
                let mut points = Vec::new();
                for (mode, raw) in [
                    ("user", Some(cpu.user)),
                    ("nice", Some(cpu.nice)),
                    ("system", Some(cpu.system)),
                    ("idle", Some(cpu.idle)),
                    ("interrupt", cpu.irq),
                    ("softirq", cpu.softirq),
                    ("steal", cpu.steal),
                ] {
                    if let Some(raw) = raw {
                        points.push(self.counter_point(
                            format!("node/{CPU_TIME}/{mode}"),
                            raw,
                            Value::AsDouble(raw as f64 / self.ticks_per_second as f64),
                            time,
                            if self.boot_time_ns <= time {
                                self.boot_time_ns
                            } else {
                                0
                            },
                            vec![string("cpu.mode", mode)],
                        )?);
                    } else {
                        status = ReadStatus::Unsupported;
                    }
                }
                metrics.push(counter(CPU_TIME, "s", points));
                statuses.push(self.read_status(CPU_TIME, status, time));
            }
            Err(error) => {
                statuses.push(self.read_status(CPU_TIME, ReadStatus::from_error(&error), time))
            }
        }
        let memory = Meminfo::current();
        let time = self.clock.timestamp()?;
        match memory {
            Ok(memory) => {
                for (name, bytes) in [
                    (TOTAL_MEMORY, Some(memory.mem_total)),
                    (AVAILABLE_MEMORY, memory.mem_available),
                ] {
                    let status = match bytes {
                        Some(bytes) => match i64::try_from(bytes) {
                            Ok(bytes) => {
                                metrics.push(self.int_gauge(name, "By", bytes, time));
                                ReadStatus::Read
                            }
                            Err(_) => ReadStatus::OutOfRange,
                        },
                        None => ReadStatus::Unsupported,
                    };
                    statuses.push(self.read_status(name, status, time));
                }
            }
            Err(error) => {
                for name in [TOTAL_MEMORY, AVAILABLE_MEMORY] {
                    statuses.push(self.read_status(name, ReadStatus::from_error(&error), time));
                }
            }
        }
        let disks = procfs::diskstats();
        let time = self.clock.timestamp()?;
        let mut disk_points = Vec::new();
        let disk_status = match disks {
            Ok(disks) => {
                let mut status = ReadStatus::Read;
                for disk in disks {
                    let device = format!("block:{}:{}", disk.major, disk.minor);
                    for (direction, sectors) in
                        [("read", disk.sectors_read), ("write", disk.sectors_written)]
                    {
                        if let Some(bytes) = sectors
                            .checked_mul(512)
                            .and_then(|bytes| i64::try_from(bytes).ok())
                        {
                            disk_points.push(self.counter_point(
                                format!("node/{DISK_IO}/{device}/{direction}"),
                                sectors,
                                Value::AsInt(bytes),
                                time,
                                0,
                                vec![
                                    string("system.device", device.clone()),
                                    string("disk.io.direction", direction),
                                ],
                            )?);
                        } else {
                            status = ReadStatus::OutOfRange;
                        }
                    }
                }
                status
            }
            Err(error) => ReadStatus::from_error(&error),
        };
        if !disk_points.is_empty() {
            metrics.push(counter(DISK_IO, "By", disk_points));
        }
        statuses.push(self.read_status(DISK_IO, disk_status, time));
        metrics.push(gauge("pfe.collection.read.status", "1", statuses));
        Ok(metrics)
    }
}
