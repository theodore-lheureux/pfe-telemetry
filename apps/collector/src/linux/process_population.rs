use super::{Collector, ProcessDetail, process::ProcessSample};
use crate::metrics::{Distribution, gauge, histogram, string};
use opentelemetry_proto::tonic::metrics::v1::{Metric, ResourceMetrics, number_data_point::Value};
use recount_telemetry_validation::catalogue;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io,
    time::{Duration, Instant},
};

type Identity = (i32, u64);
type GpuIdentities = BTreeMap<i32, u64>;
const TOP: usize = 16;
const MAX_BASELINES: usize = 65_536;

#[derive(Default)]
pub(super) struct Population {
    previous: HashMap<Identity, Baseline>,
    tracked_cursor: Option<Identity>,
}

struct Baseline {
    cpu: [u64; 2],
    cpu_at: Instant,
    disk: Option<[u64; 2]>,
    disk_at: Instant,
}

fn rate(current: u64, previous: u64, now: Instant, then: Instant) -> Option<f64> {
    let elapsed = now.checked_duration_since(then)?.as_secs_f64();
    (elapsed > 0.0).then_some(())?;
    Some(current.checked_sub(previous)? as f64 / elapsed)
}

#[derive(Clone, Copy)]
struct Candidate {
    identity: Identity,
    tracked: bool,
    resident: bool,
    cpu: Option<f64>,
    rss: Option<i64>,
    io: f64,
}

fn select(
    candidates: &[Candidate],
    cursor: &mut Option<Identity>,
    detail: ProcessDetail,
) -> (BTreeSet<usize>, usize) {
    if detail.cap == 0 {
        return ((0..candidates.len()).collect(), candidates.len());
    }
    let mut tracked: Vec<_> = (0..candidates.len())
        .filter(|&i| candidates[i].tracked)
        .collect();
    tracked.sort_unstable_by_key(|&i| candidates[i].identity);
    let start = cursor.map_or(0, |cursor| {
        tracked.partition_point(|&i| candidates[i].identity <= cursor)
    });
    let mut selected = BTreeSet::new();
    for &i in tracked[start..]
        .iter()
        .chain(&tracked[..start])
        .take(detail.cap)
    {
        selected.insert(i);
        *cursor = Some(candidates[i].identity);
    }
    let mut eligible: BTreeSet<_> = tracked.into_iter().collect();
    let mut ranked: Vec<_> = (0..candidates.len())
        .filter(|&i| candidates[i].resident)
        .collect();
    ranked.sort_unstable_by(|&a, &b| {
        candidates[b]
            .cpu
            .unwrap_or(-1.0)
            .total_cmp(&candidates[a].cpu.unwrap_or(-1.0))
            .then_with(|| candidates[a].identity.cmp(&candidates[b].identity))
    });
    let cpu: Vec<_> = ranked
        .iter()
        .copied()
        .filter(|&i| candidates[i].cpu.is_some_and(|v| v > 0.0))
        .take(TOP)
        .collect();
    ranked
        .sort_unstable_by_key(|&i| (std::cmp::Reverse(candidates[i].rss), candidates[i].identity));
    let rss = ranked
        .iter()
        .copied()
        .filter(|&i| candidates[i].rss.is_some_and(|v| v > 0))
        .take(TOP);
    for i in cpu
        .into_iter()
        .chain(rss)
        .chain(ranked.iter().copied().filter(|&i| {
            let c = candidates[i];
            c.cpu
                .is_some_and(|v| v >= f64::from(detail.cpu_percent) / 100.0)
                || c.rss.is_some_and(|v| v as u64 >= detail.rss_bytes)
                || c.io >= detail.io_bytes_per_second as f64
        }))
    {
        eligible.insert(i);
        if selected.len() < detail.cap {
            selected.insert(i);
        }
    }
    (selected, eligible.len())
}

impl Collector {
    pub(super) fn process_population(
        &mut self,
        samples: Vec<ProcessSample>,
        time: u64,
    ) -> io::Result<(Vec<ResourceMetrics>, Vec<Metric>, GpuIdentities)> {
        let mut cpu = Distribution::new(vec![
            0., 0.01, 0.05, 0.1, 0.25, 0.5, 1., 2., 4., 8., 16., 32., 64.,
        ]);
        let mut rss = Distribution::new(
            std::iter::once(0.)
                .chain((20..=36).map(|n| (1u64 << n) as f64))
                .collect(),
        );
        let disk_bounds = || {
            std::iter::once(0.)
                .chain((12..=31).map(|n| (1u64 << n) as f64))
                .collect()
        };
        let mut disk = [
            Distribution::new(disk_bounds()),
            Distribution::new(disk_bounds()),
        ];
        let mut previous = std::mem::take(&mut self.population.previous);
        let mut candidates = Vec::with_capacity(samples.len());
        let mut gpu_identities = BTreeMap::new();
        let mut capped = 0;
        let mut idle = 0;
        let mut detail = self.process_detail;
        {
            let tracked = self.tracked_processes.as_ref().map(|rx| rx.borrow());
            let tracked = tracked.as_ref().filter(|snapshot| {
                snapshot.observed.is_some_and(|at| {
                    at.elapsed() <= Duration::from_nanos(self.interval_ns as u64) * 3
                })
            });
            for s in &samples {
                let identity = s.identity();
                if tracked.is_some_and(|snapshot| snapshot.profiling.contains(&identity)) {
                    detail.cap = 0;
                }
                gpu_identities.insert(identity.0, identity.1);
                let old = previous.remove(&identity);
                let now = Baseline {
                    cpu: [s.stat.utime, s.stat.stime],
                    cpu_at: s.cpu_instant,
                    disk: s.disk.as_ref().ok().map(|d| [d.read_bytes, d.write_bytes]),
                    disk_at: s.disk_instant,
                };
                let cpu_rate = old.as_ref().and_then(|p| {
                    Some(
                        (rate(now.cpu[0], p.cpu[0], now.cpu_at, p.cpu_at)?
                            + rate(now.cpu[1], p.cpu[1], now.cpu_at, p.cpu_at)?)
                            / self.ticks_per_second as f64,
                    )
                });
                // Only busy processes enter the CPU distribution; idle ones are counted.
                match cpu_rate {
                    Some(value) if value > 0.0 => cpu.observe(value),
                    Some(_) => idle += 1,
                    None => {}
                }
                let memory = s.rss.ok();
                if let Some(value) = memory {
                    rss.observe(value as f64);
                }
                let mut io = 0.0;
                if let Some((p, (cur, prev))) = old
                    .as_ref()
                    .and_then(|p| now.disk.zip(p.disk).map(|d| (p, d)))
                {
                    for (i, dist) in disk.iter_mut().enumerate() {
                        if let Some(value) = rate(cur[i], prev[i], now.disk_at, p.disk_at) {
                            dist.observe(value);
                            io += value;
                        }
                    }
                }
                candidates.push(Candidate {
                    identity,
                    tracked: tracked.is_some_and(|t| t.identities.contains(&identity)),
                    resident: old.is_some(),
                    cpu: cpu_rate,
                    rss: memory,
                    io,
                });
                if self.population.previous.len() < MAX_BASELINES {
                    self.population.previous.insert(identity, now);
                } else {
                    capped += 1;
                }
            }
        }
        let (selected, eligible) = select(&candidates, &mut self.population.tracked_cursor, detail);
        let coverage = [
            ("verified", samples.len() as u64),
            ("cpu", cpu.count()),
            ("cpu_idle", idle),
            ("rss", rss.count()),
            ("disk_read", disk[0].count()),
            ("disk_write", disk[1].count()),
            (
                "baseline_missing",
                candidates.iter().filter(|c| !c.resident).count() as u64,
            ),
            ("baseline_cap", capped),
            ("detail_eligible", eligible as u64),
            ("detail_emitted", selected.len() as u64),
            ("detail_deferred", (eligible - selected.len()) as u64),
            ("detail_omitted", (samples.len() - selected.len()) as u64),
        ]
        .into_iter()
        .map(|(kind, n)| {
            self.measurement_point(
                Value::AsInt(n as i64),
                time,
                0,
                vec![string("coverage", kind)],
            )
        })
        .collect();
        let mut metrics = vec![gauge(&catalogue::PROCESS_COVERAGE, coverage)];
        let [read, write] = disk;
        for (definition, points) in [
            (
                &catalogue::NODE_PROCESS_CPU_DISTRIBUTION,
                cpu.finish(time, vec![]).into_iter().collect::<Vec<_>>(),
            ),
            (
                &catalogue::NODE_PROCESS_RSS_DISTRIBUTION,
                rss.finish(time, vec![]).into_iter().collect(),
            ),
            (
                &catalogue::NODE_PROCESS_IO_DISTRIBUTION,
                [
                    read.finish(time, vec![string("disk.io.direction", "read")]),
                    write.finish(time, vec![string("disk.io.direction", "write")]),
                ]
                .into_iter()
                .flatten()
                .collect(),
            ),
        ] {
            if !points.is_empty() {
                self.cycle_points += points.len() as u64;
                metrics.push(histogram(definition, points));
            }
        }
        let resources = samples
            .into_iter()
            .enumerate()
            .filter(|(i, _)| selected.contains(i))
            .map(|(_, sample)| self.process_metrics(sample))
            .collect::<io::Result<_>>()?;
        Ok((resources, metrics, gpu_identities))
    }
}

impl Population {
    pub(super) fn invalidate(&mut self) {
        self.previous.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_cap_prioritizes_and_rotates_tracked_members() {
        let candidates: Vec<_> = (0..80)
            .map(|pid| Candidate {
                identity: (pid, 1),
                tracked: pid < 70,
                resident: false,
                cpu: None,
                rss: Some(2 << 30),
                io: 0.0,
            })
            .collect();
        let mut cursor = None;
        let detail = ProcessDetail::default();
        let (first, eligible) = select(&candidates, &mut cursor, detail);
        let (next, _) = select(&candidates, &mut cursor, detail);
        assert_eq!(eligible, 70);
        assert_eq!(first.len(), detail.cap);
        assert_eq!(next.len(), detail.cap);
        let (profiled, eligible) =
            select(&candidates, &mut cursor, ProcessDetail { cap: 0, ..detail });
        assert_eq!((profiled.len(), eligible), (80, 80));
        assert_eq!(first.union(&next).count(), 70);
    }

    #[test]
    fn rates_use_elapsed_time_and_reject_resets() {
        let start = Instant::now();
        let later = start + Duration::from_millis(500);
        assert_eq!(rate(15, 10, later, start), Some(10.0));
        assert_eq!(rate(10, 10, later, start), Some(0.0));
        assert_eq!(rate(9, 10, later, start), None);
        assert_eq!(rate(15, 10, start, start), None);
    }
}
