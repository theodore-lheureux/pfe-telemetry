use super::{Identities, Reading, acquire::Batch};
use crate::diagnostics::ReadStatus;
use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value;
use recount_telemetry_validation::catalogue as c;
use std::{collections::BTreeMap, time::Duration};

#[derive(Default)]
pub(super) struct Window {
    seen: BTreeMap<(i32, u64), u64>,
    cursors: BTreeMap<String, u64>,
}

impl Window {
    pub fn begin(&mut self, before: &Identities, time: u64) {
        self.seen
            .retain(|(pid, ticks), _| before.get(pid) == Some(ticks));
        for (pid, ticks) in before {
            self.seen.entry((*pid, *ticks)).or_insert(time);
        }
    }
    pub fn cursor(&self, uuid: &str) -> u64 {
        self.cursors.get(uuid).copied().unwrap_or(0)
    }
    pub fn retain_devices(&mut self, uuids: &[String]) {
        self.cursors.retain(|uuid, _| uuids.contains(uuid));
    }

    pub fn resolve(
        &mut self,
        batch: Batch,
        before: &Identities,
        after: &Identities,
        period: Duration,
    ) -> Vec<Reading> {
        let warmup = u64::try_from(period.max(Duration::from_secs(1)).as_nanos())
            .unwrap_or(u64::MAX)
            .saturating_mul(2);
        let cursor = self.cursor(&batch.uuid);
        let mut readings = vec![];
        let mut available = BTreeMap::new();
        let mut memory_pids = std::collections::BTreeSet::new();
        let valid = |pid: i32| {
            before
                .get(&pid)
                .copied()
                .filter(|ticks| after.get(&pid) == Some(ticks))
        };
        for (pid, memory) in batch.memory {
            let Some(ticks) = valid(pid) else { continue };
            readings.push(Reading {
                pid,
                ticks,
                uuid: batch.uuid.clone(),
                metric: &c::PROCESS_GPU_MEMORY_USED,
                time_ns: memory.time_ns,
                value: memory.bytes.and_then(|bytes| {
                    i64::try_from(bytes)
                        .map(Value::AsInt)
                        .map_err(|_| ReadStatus::OutOfRange)
                }),
            });
            available.insert(pid, ticks);
            memory_pids.insert(pid);
        }
        let mut received = BTreeMap::new();
        let mut utilization_status = ReadStatus::Unavailable;
        if let Ok(samples) = &batch.utilization {
            let mut sample_ids = std::collections::BTreeSet::new();
            let distinct = samples
                .iter()
                .all(|sample| sample_ids.insert((sample.pid, sample.timestamp)));
            let timestamps_valid = samples.iter().all(|sample| {
                sample
                    .timestamp
                    .checked_mul(1000)
                    .is_some_and(|time| time > 0 && time <= batch.finished_ns)
            });
            if timestamps_valid && distinct {
                // Advance only after examining the entire batch, including equal timestamps.
                if let Some(latest) = samples.iter().map(|sample| sample.timestamp).max() {
                    self.cursors.insert(batch.uuid.clone(), latest.max(cursor));
                }
                if cursor != 0 {
                    for sample in samples {
                        let Ok(pid) = i32::try_from(sample.pid) else {
                            continue;
                        };
                        let Some(ticks) = valid(pid) else { continue };
                        available.insert(pid, ticks);
                        let first = self.seen.get(&(pid, ticks)).copied().unwrap_or(u64::MAX);
                        let time = sample.timestamp * 1000;
                        if sample.timestamp <= cursor || time < first.saturating_add(warmup) {
                            continue;
                        }
                        for (metric, percent) in [
                            (&c::PROCESS_GPU_UTILIZATION, sample.sm_util),
                            (&c::PROCESS_GPU_MEMORY_ACTIVITY, sample.mem_util),
                        ] {
                            readings.push(Reading {
                                pid,
                                ticks,
                                uuid: batch.uuid.clone(),
                                metric,
                                time_ns: time,
                                value: if percent <= 100 {
                                    Ok(Value::AsDouble(percent as f64 / 100.0))
                                } else {
                                    Err(ReadStatus::OutOfRange)
                                },
                            });
                        }
                        received.insert(pid, ());
                    }
                }
            } else {
                utilization_status = if timestamps_valid {
                    ReadStatus::Failed
                } else {
                    ReadStatus::OutOfRange
                };
            }
        } else if let Err(error) = batch.utilization {
            utilization_status = error;
        }
        for (pid, ticks) in available {
            if !memory_pids.contains(&pid) {
                readings.push(Reading {
                    pid,
                    ticks,
                    uuid: batch.uuid.clone(),
                    metric: &c::PROCESS_GPU_MEMORY_USED,
                    time_ns: batch.finished_ns,
                    value: Err(ReadStatus::Unavailable),
                });
            }
            if received.contains_key(&pid) {
                continue;
            }
            for metric in [&c::PROCESS_GPU_UTILIZATION, &c::PROCESS_GPU_MEMORY_ACTIVITY] {
                readings.push(Reading {
                    pid,
                    ticks,
                    uuid: batch.uuid.clone(),
                    metric,
                    time_ns: batch.finished_ns,
                    value: Err(utilization_status),
                });
            }
        }
        readings
    }
}
