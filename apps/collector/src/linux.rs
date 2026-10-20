mod node;
mod process;

use process::discovered_entry;

use std::{
    fs, io,
    time::{Duration, Instant},
};

use opentelemetry_proto::tonic::{
    common::v1::KeyValue,
    metrics::v1::{Metric, NumberDataPoint, ResourceMetrics, number_data_point::Value},
};
use procfs::{CurrentSI, KernelStats, process::Process};

use crate::{
    clock::{SamplingClock, is_discontinuity},
    continuity::Continuity,
    delivery::{LossReason, LossTracker, Scan, point_count},
    diagnostics::ReadStatus,
    identity::{IdentifierKind, parse_identifier},
    metrics::{counter, gauge, integer, point, resource, string},
};

/// Sampling identity and interval for one collection epoch.
pub struct CollectorConfig {
    /// Intended time between scans.
    pub interval: Duration,
    /// Enrolled identity; absent values use the Linux machine ID.
    pub host_id: Option<String>,
    /// Boot-local process namespace identity supplied by deployment.
    pub namespace_id: Option<String>,
    /// Deployment has verified visibility of initial host PIDs.
    pub host_visibility: bool,
}

/// Blocking Linux baseline sampling with verified process identity.
pub struct Collector {
    host: Vec<KeyValue>,
    namespace: String,
    visibility: &'static str,
    interval_ns: i64,
    boot_time_ns: u64,
    ticks_per_second: u64,
    page_size: u64,
    epoch: String,
    epoch_start: u64,
    clock: SamplingClock,
    continuity: Continuity,
    loss: LossTracker,
    loss_generation: u64,
    cycle_points: u64,
}

impl Collector {
    /// Reads required Linux identity and source constants. An explicitly enrolled
    /// host ID overrides machine-id, including for cloned machines.
    pub fn new(config: CollectorConfig, loss: LossTracker) -> io::Result<Self> {
        let CollectorConfig {
            interval,
            host_id,
            namespace_id,
            host_visibility,
        } = config;
        let host_id = match host_id {
            Some(id) if !id.is_empty() && id.len() <= 128 => id,
            Some(_) => return Err(io::Error::other("Enrolled host ID must be 1-128 bytes")),
            None => parse_identifier(
                &fs::read_to_string("/etc/machine-id")?,
                IdentifierKind::Machine,
            )?,
        };
        let boot_id = parse_identifier(
            &fs::read_to_string("/proc/sys/kernel/random/boot_id")?,
            IdentifierKind::Boot,
        )?;
        // Refuse a proc mount whose PID numbering differs from the caller's.
        let own = Process::myself()
            .and_then(|process| process.stat())
            .map_err(|_| io::Error::other("Cannot verify procfs PID namespace"))?;
        if u32::try_from(own.pid).ok() != Some(std::process::id()) {
            return Err(io::Error::other(
                "Procfs PID namespace differs from collector namespace",
            ));
        }
        let namespace = match namespace_id {
            Some(id) if !id.is_empty() && id.len() <= 128 => id,
            Some(_) => return Err(io::Error::other("Process namespace ID must be 1-128 bytes")),
            None if host_visibility => "host".into(),
            None => {
                return Err(io::Error::other(
                    "Restricted visibility requires TELEMETRY_COLLECTOR_PROCESS_NAMESPACE_ID",
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
            string("host.id", host_id),
            string("pfe.host.boot_id", boot_id),
            string("os.type", "linux"),
            string("pfe.collection.source", "rust-procfs"),
        ];
        // Hostname is display-only and must obey the contract's string limit.
        if let Ok(name) = fs::read_to_string("/proc/sys/kernel/hostname") {
            let name = name.trim();
            if !name.is_empty() && name.len() <= 128 {
                host.push(string("host.name", name));
            }
        }
        Ok(Self {
            host,
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
        })
    }

    /// Invalidates all baseline counter streams after a skipped scheduled cycle.
    pub fn missed_cycle(&mut self) {
        self.continuity.invalidate();
    }

    /// Samples all baseline categories. A detected clock discontinuity discards
    /// the incomplete cycle and starts a new epoch before any further reads.
    /// An unrepresentable timestamp or identifier is a fatal collection error.
    /// Results hold a full scan in memory; call from a blocking worker.
    pub fn sample(&mut self) -> io::Result<Option<Scan>> {
        let generation = self.loss.generation();
        if generation != self.loss_generation {
            self.continuity.invalidate();
        }
        self.loss_generation = generation;
        self.continuity.begin_scan();
        self.cycle_points = 0;
        match self.scan() {
            Ok(resources) => {
                self.continuity.finish_scan();
                if self.loss.generation() != generation {
                    // Export can report loss while a blocking scan is running.
                    // Do not release a scan bearing now-invalid segment IDs.
                    self.loss.record(
                        &self.epoch,
                        LossReason::BufferExpired,
                        point_count(&resources),
                    );
                    self.continuity.invalidate();
                    return Ok(None);
                }
                Ok(Some(Scan::new(
                    self.epoch.clone(),
                    generation,
                    resources,
                    self.loss.clone(),
                )))
            }
            Err(error) if is_discontinuity(&error) => {
                self.loss
                    .record(&self.epoch, LossReason::BufferExpired, self.cycle_points);
                self.continuity.invalidate();
                self.epoch = uuid::Uuid::new_v4().to_string();
                self.clock = SamplingClock::new()?;
                self.epoch_start = self.clock.timestamp()?;
                // The cached boot wall time belongs to the pre-step clock.
                self.boot_time_ns = 0;
                self.loss.start_epoch(&self.epoch);
                tracing::warn!(
                    "Sampling clock discontinuity; incomplete cycle discarded and epoch changed"
                );
                Ok(None)
            }
            Err(error) => {
                self.loss
                    .record(&self.epoch, LossReason::BufferExpired, self.cycle_points);
                Err(error)
            }
        }
    }

    fn scan(&mut self) -> io::Result<Vec<ResourceMetrics>> {
        // Establish the scan window before the first source read.
        self.clock.timestamp()?;
        let started = Instant::now();
        let node = self.node_metrics()?;
        let mut resources = vec![resource(self.attributes("node"), node)];
        let mut discovered = 0u64;
        let mut discarded = [0u64; 2];
        let mut discovery = ReadStatus::Read;
        match procfs::process::all_processes() {
            Ok(processes) => {
                for entry in processes {
                    match entry {
                        Ok(process) => {
                            discovered += 1;
                            match self.process_metrics(&process)? {
                                Ok(metrics) => resources.push(metrics),
                                Err(ReadStatus::Disappeared) => discarded[1] += 1,
                                Err(_) => discarded[0] += 1,
                            }
                        }
                        Err(error) => {
                            discovery = ReadStatus::from_error(&error);
                            // A directory-iteration error is not evidence of a
                            // process. Count only a known numeric proc entry.
                            if discovered_entry(&error) {
                                discovered += 1;
                                let index = usize::from(discovery == ReadStatus::Disappeared);
                                discarded[index] += 1;
                            }
                        }
                    }
                }
            }
            Err(error) => discovery = ReadStatus::from_error(&error),
        }
        let time = self.clock.timestamp()?;
        let duration = started.elapsed().as_secs_f64();
        let (_, losses) = self.loss.snapshot();
        let dropped = [
            LossReason::BufferFull,
            LossReason::BufferExpired,
            LossReason::PermanentRejection,
        ]
        .into_iter()
        .map(|reason| {
            Ok(self.measurement_point(
                Value::AsInt(signed(losses[reason.index()])?),
                time,
                self.epoch_start,
                vec![string("reason", reason.name())],
            ))
        })
        .collect::<io::Result<Vec<_>>>()?;
        let diagnostics = vec![
            self.int_gauge(
                "pfe.collection.discovery.status",
                "1",
                discovery as i64,
                time,
            ),
            self.int_gauge(
                "pfe.collection.discovered.processes",
                "{process}",
                signed(discovered)?,
                time,
            ),
            gauge(
                "pfe.collection.discarded.processes",
                "{process}",
                vec![
                    self.measurement_point(
                        Value::AsInt(signed(discarded[0])?),
                        time,
                        0,
                        vec![string("reason", "identity_unverified")],
                    ),
                    self.measurement_point(
                        Value::AsInt(signed(discarded[1])?),
                        time,
                        0,
                        vec![string("reason", "disappeared")],
                    ),
                ],
            ),
            gauge(
                "pfe.collection.scan.duration",
                "s",
                vec![self.measurement_point(Value::AsDouble(duration), time, 0, vec![])],
            ),
            // No synchronization estimate is verified by this collector.
            self.int_gauge("pfe.clock.status", "1", 0, time),
            counter("pfe.collection.dropped.points", "{point}", dropped),
        ];
        resources.push(resource(self.attributes("collector"), diagnostics));
        Ok(resources)
    }

    fn attributes(&self, scope: &str) -> Vec<KeyValue> {
        let mut attributes = self.host.clone();
        attributes.extend([
            string("pfe.collection.scope", scope),
            string("pfe.collection.epoch_id", self.epoch.clone()),
            integer("pfe.collection.interval_ns", self.interval_ns),
        ]);
        if scope == "collector" {
            attributes.push(string("pfe.collection.visibility", self.visibility));
        }
        attributes
    }

    fn counter_point(
        &mut self,
        key: String,
        raw: u64,
        value: Value,
        time: u64,
        start: u64,
        mut dimensions: Vec<KeyValue>,
    ) -> io::Result<NumberDataPoint> {
        dimensions.push(string(
            "pfe.counter.segment_id",
            self.continuity.segment(key, raw, time),
        ));
        Ok(self.measurement_point(value, time, start, dimensions))
    }

    fn measurement_point(
        &mut self,
        value: Value,
        time: u64,
        start: u64,
        dimensions: Vec<KeyValue>,
    ) -> NumberDataPoint {
        self.cycle_points = self.cycle_points.saturating_add(1);
        point(value, time, start, dimensions)
    }

    fn int_gauge(&mut self, name: &str, unit: &str, value: i64, time: u64) -> Metric {
        gauge(
            name,
            unit,
            vec![self.measurement_point(Value::AsInt(value), time, 0, vec![])],
        )
    }

    fn read_status(&mut self, name: &str, status: ReadStatus, time: u64) -> NumberDataPoint {
        self.measurement_point(
            Value::AsInt(status as i64),
            time,
            0,
            vec![string("pfe.metric.name", name)],
        )
    }
}

fn signed(value: u64) -> io::Result<i64> {
    i64::try_from(value).map_err(|_| io::Error::other("Diagnostic count exceeds int64"))
}
