mod gpu;
mod node;
mod process;
mod process_population;
mod setup;
#[cfg(test)]
mod tests;

use process::{ProcessAttributions, discovered_entry};
pub(crate) use setup::host_id_or_machine_id;

use std::{
    io,
    time::{Duration, Instant},
};

use opentelemetry_proto::tonic::{
    common::v1::KeyValue,
    metrics::v1::{Metric, NumberDataPoint, number_data_point::Value},
};
use recount_telemetry_validation::catalogue::{self, Definition};
use recount_telemetry_validation::linux_adapter::{self as adapter, Scope};

use crate::{
    clock::{SamplingClock, is_discontinuity},
    continuity::Continuity,
    delivery::{LossReason, LossTracker, Scan, ScanContents},
    diagnostics::ReadStatus,
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
    boot: String,
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
    process_attributions: ProcessAttributions,
    loss: LossTracker,
    loss_generation: u64,
    cycle_points: u64,
    gpu: Option<crate::gpu::Gpu>,
    gpu_authorization: Option<crate::enrollment::Authorization>,
    population: process_population::Population,
    pub(crate) tracked_processes:
        Option<tokio::sync::watch::Receiver<crate::participants::TrackedProcesses>>,
}

impl Collector {
    /// Invalidates all baseline counter streams after a skipped scheduled cycle.
    pub fn missed_cycle(&mut self) {
        self.continuity.invalidate();
        self.population.invalidate();
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
            Ok(contents) => {
                self.continuity.finish_scan();
                self.process_attributions.finish_scan();
                if self.loss.generation() != generation {
                    // Export can report loss while a blocking scan is running.
                    // Do not release a scan bearing now-invalid segment IDs.
                    self.loss.record(
                        &self.epoch,
                        LossReason::BufferExpired,
                        contents.point_count(),
                    );
                    self.continuity.invalidate();
                    return Ok(None);
                }
                Ok(Some(Scan::new(
                    self.epoch.clone(),
                    generation,
                    contents,
                    self.loss.clone(),
                )))
            }
            Err(error) if is_discontinuity(&error) => {
                self.loss
                    .record(&self.epoch, LossReason::BufferExpired, self.cycle_points);
                self.continuity.invalidate();
                self.population.invalidate();
                self.epoch = uuid::Uuid::new_v4().to_string();
                if let Some(gpu) = &mut self.gpu {
                    gpu.invalidate();
                }
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

    fn scan(&mut self) -> io::Result<ScanContents> {
        self.process_attributions.begin_scan();
        // Establish the scan window before the first source read.
        self.clock.timestamp()?;
        let started = Instant::now();
        let mut node = self.node_metrics()?;
        let mut samples = Vec::new();
        let mut discovered = 0u64;
        let mut discarded = [0u64; 2];
        let mut discovery = ReadStatus::Read;
        match procfs::process::all_processes() {
            Ok(processes) => {
                for entry in processes {
                    match entry {
                        Ok(process) => {
                            discovered += 1;
                            match self.read_process(&process)? {
                                Ok(sample) => samples.push(sample),
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
        let (details, distribution, identities) = self.process_population(samples, time)?;
        node.extend(distribution);
        let mut resources = vec![resource(self.attributes(Scope::Node), node)];
        resources.extend(details);
        self.gpu_metrics(time, &mut resources, identities);
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
            self.int_gauge(&catalogue::DISCOVERY_STATUS, discovery as i64, time),
            self.int_gauge(&catalogue::DISCOVERED_PROCESSES, signed(discovered)?, time),
            gauge(
                &catalogue::DISCARDED_PROCESSES,
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
            counter(&catalogue::DROPPED_POINTS, dropped),
        ];
        let window = vec![
            gauge(
                &catalogue::SCAN_DURATION,
                vec![self.measurement_point(Value::AsDouble(duration), time, 0, vec![])],
            ),
            // No synchronization estimate is verified by this collector.
            self.int_gauge(&catalogue::CLOCK_STATUS, 0, time),
        ];
        Ok(ScanContents {
            measurements: resources,
            window: resource(self.attributes(Scope::Collector), window),
            diagnostics: resource(self.attributes(Scope::Collector), diagnostics),
        })
    }

    fn attributes(&self, scope: Scope) -> Vec<KeyValue> {
        let mut attributes = self.host.clone();
        attributes.extend([
            string(adapter::SCOPE, scope.as_str()),
            string(adapter::EPOCH_ID, self.epoch.clone()),
            integer(adapter::INTERVAL_NS, self.interval_ns),
        ]);
        if scope == Scope::Collector {
            attributes.push(string(adapter::VISIBILITY, self.visibility));
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
            "recount.counter.segment_id",
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

    fn int_gauge(&mut self, definition: &Definition, value: i64, time: u64) -> Metric {
        gauge(
            definition,
            vec![self.measurement_point(Value::AsInt(value), time, 0, vec![])],
        )
    }

    fn read_status(
        &mut self,
        definition: &Definition,
        status: ReadStatus,
        time: u64,
    ) -> NumberDataPoint {
        self.measurement_point(
            Value::AsInt(status as i64),
            time,
            0,
            vec![string("recount.metric.name", definition.name)],
        )
    }
}

fn signed(value: u64) -> io::Result<i64> {
    i64::try_from(value).map_err(|_| io::Error::other("Diagnostic count exceeds int64"))
}
