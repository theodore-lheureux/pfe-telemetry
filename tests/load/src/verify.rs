use crate::{
    Result,
    allocation::{Allocation, phase_dir},
    kafka, monitor,
    send::BatchRecord,
    workload::{fingerprint, sample_ids},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    time::Duration,
};

const FINGERPRINT: &str = "reinterpretAsUInt64(reverse(substring(sample_id, 1, 8)))";
/// Bounds each verification query on the shared server, so it fails instead of evicting
/// other work. FINAL merges each event-day partition alone, as the web reader does.
const LIMITS: &str = "max_threads = 2, max_memory_usage = 268435456, do_not_merge_across_partitions_select_final = 1, output_format_json_quote_64bit_integers = 0";

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize)]
struct Totals {
    samples: u64,
    sum: u64,
    xor: u64,
}

impl Totals {
    fn add(&mut self, id: &[u8; 32]) {
        let value = fingerprint(id);
        self.samples += 1;
        self.sum = self.sum.wrapping_add(value);
        self.xor ^= value;
    }
}

#[derive(Serialize)]
pub struct Report {
    pub passed: bool,
    pub failures: Vec<String>,
    pub acked_batches: usize,
    pub ambiguous_present: usize,
    pub ambiguous_absent: usize,
    pub rejected_batches: usize,
    pub rejected_present: usize,
    pub expected_samples: u64,
    pub physical_rows: u64,
    pub distinct_samples: u64,
    pub final_rows: u64,
    /// Physical duplicates still present in active parts when counted.
    pub duplicate_rows: u64,
    /// Active physical rows per logical sample when counted; merges lower it over time.
    pub amplification: f64,
    /// Retained raw records (accepted requests, including resends).
    pub raw_records: u64,
    /// Retained normalized point records, including replayed and resent points.
    pub normalized_records: u64,
    /// Rows written in new parts since the allocation, before any replacing merge.
    pub inserted_rows: u64,
    pub normalized_amplification: f64,
    pub insert_amplification: f64,
    /// Stored project/source pairs that no synthetic principal was enrolled as.
    pub unenrolled_sources: u64,
    pub divergent_replicas: u64,
    pub sources: usize,
    pub wait_seconds: f64,
    pub lags: Vec<kafka::GroupLag>,
    pub part_log: serde_json::Value,
    pub retained_bytes: serde_json::Value,
}

/// Every phase's batch records, keyed by batch identity; resends are the same batch.
fn batches(run: &Path) -> Result<BTreeMap<String, BatchRecord>> {
    let mut all = BTreeMap::new();
    let Ok(phases) = std::fs::read_dir(run.join("phases")) else {
        return Ok(all);
    };
    for phase in phases {
        let phase = phase?.path();
        if let Ok(text) = std::fs::read_to_string(phase.join("batches.jsonl")) {
            for line in text.lines() {
                let record: BatchRecord = serde_json::from_str(line)?;
                merge(&mut all, record);
            }
        }
        // k6 writes `ACK <node> <batch> <points>` and `NACK ... <status>` console lines for
        // one-gauge batches.
        if let Ok(text) = std::fs::read_to_string(phase.join("k6-console.log")) {
            for line in text.lines() {
                let Some(start) = line.find("ACK ") else {
                    continue;
                };
                let acked = !line[..start].ends_with('N');
                let fields: Vec<_> = line[start + 4..]
                    .split_whitespace()
                    .map(|f| f.trim_end_matches('"'))
                    .collect();
                let [node, batch, points, ..] = fields[..] else {
                    continue;
                };
                // InvalidArgument, NotFound, PermissionDenied, ResourceExhausted,
                // FailedPrecondition and Unauthenticated end before publication.
                let terminal = fields
                    .get(3)
                    .is_some_and(|code| ["3", "5", "7", "8", "9", "16"].contains(code));
                let outcome = match (acked, terminal) {
                    (true, _) => "acked",
                    (false, true) => "rejected",
                    (false, false) => "ambiguous",
                };
                merge(
                    &mut all,
                    BatchRecord {
                        node: node.parse()?,
                        batch: batch.into(),
                        layout: vec![1],
                        points: points.parse()?,
                        outcome: outcome.into(),
                        ..Default::default()
                    },
                );
            }
        }
    }
    Ok(all)
}

fn merge(all: &mut BTreeMap<String, BatchRecord>, record: BatchRecord) {
    match all.get(&record.batch) {
        Some(existing) if existing.outcome == "acked" => {}
        _ => {
            all.insert(record.batch.clone(), record);
        }
    }
}

fn hex(id: &[u8; 32]) -> String {
    id.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn run(allocation: &Allocation, run: &Path, label: &str, wait: u64) -> Result<Report> {
    let directory = phase_dir(run, label)?;
    let clickhouse = allocation.clickhouse()?;
    let database = &allocation.database;
    let waited = std::time::Instant::now();
    let deadline = waited + Duration::from_secs(wait);
    let lags = loop {
        let lags = monitor::lags(allocation)?;
        if lags.iter().all(|lag| lag.lag == 0) || std::time::Instant::now() > deadline {
            break lags;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    let wait_seconds = waited.elapsed().as_secs_f64();
    let mut failures = Vec::new();
    if lags.iter().any(|lag| lag.lag != 0) {
        failures.push(format!("groups did not drain within {wait} s: {lags:?}"));
    }
    let records = batches(run)?;
    let source_of = |node: usize| {
        let node = &allocation.nodes[node];
        (allocation.projects[node.project].clone(), node.id.clone())
    };
    let ids_of = |record: &BatchRecord| {
        let (project, source) = source_of(record.node);
        sample_ids(
            &project,
            &source,
            &record.batch,
            &record.layout,
            record.points,
        )
    };
    // A raw record is one atomic Kafka record, so its first identity decides presence.
    let mut uncertain = Vec::new();
    for record in records.values().filter(|r| r.outcome != "acked") {
        uncertain.push((record, ids_of(record)));
    }
    let mut present = BTreeSet::new();
    for chunk in uncertain.chunks(500) {
        let list = chunk
            .iter()
            .map(|(_, ids)| format!("unhex('{}')", hex(&ids[0])))
            .collect::<Vec<_>>()
            .join(",");
        let text = clickhouse
            .query(&format!(
                "SELECT DISTINCT lower(hex(sample_id)) FROM {database}.metric_points WHERE sample_id IN ({list})"
            ))
            .await?;
        present.extend(text.lines().map(str::to_owned));
    }
    let mut expected: HashMap<(String, String), Totals> = HashMap::new();
    let mut origin: HashMap<[u8; 32], String> = HashMap::new();
    let (
        mut acked,
        mut ambiguous_present,
        mut ambiguous_absent,
        mut rejected,
        mut rejected_present,
    ) = (0, 0, 0, 0, 0);
    let mut include = |record: &BatchRecord, ids: Vec<[u8; 32]>| {
        let totals = expected.entry(source_of(record.node)).or_default();
        for id in ids {
            totals.add(&id);
            origin.insert(id, record.batch.clone());
        }
    };
    for record in records.values().filter(|r| r.outcome == "acked") {
        acked += 1;
        include(record, ids_of(record));
    }
    for (record, ids) in uncertain {
        let found = present.contains(&hex(&ids[0]));
        match (record.outcome.as_str(), found) {
            ("ambiguous", true) => {
                ambiguous_present += 1;
                include(record, ids);
            }
            ("ambiguous", false) => ambiguous_absent += 1,
            (_, true) => {
                rejected += 1;
                rejected_present += 1;
                failures.push(format!("rejected batch {} was stored", record.batch));
            }
            _ => rejected += 1,
        }
    }
    // One bounded query per source keeps verification within the shared server's memory;
    // a global GROUP BY over millions of 32-byte identities does not.
    let listed = clickhouse
        .query(&format!(
            "SELECT DISTINCT project_id, source_id FROM {database}.metric_points FORMAT TSV SETTINGS {LIMITS}"
        ))
        .await?;
    let mut sources: BTreeSet<(String, String)> = expected.keys().cloned().collect();
    sources.extend(
        listed
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .map(|(project, source)| (project.to_owned(), source.to_owned())),
    );
    let enrolled: BTreeSet<_> = (0..allocation.nodes.len()).map(source_of).collect();
    let (mut physical_rows, mut distinct_samples, mut final_rows) = (0, 0, 0);
    let (mut divergent_replicas, mut unenrolled_sources) = (0, 0);
    let number = |row: &serde_json::Value, field: &str| row[field].as_u64().unwrap_or_default();
    for source in &sources {
        if !enrolled.contains(source) {
            unenrolled_sources += 1;
            failures.push(format!(
                "rows for a project/source pair that was never enrolled: {source:?}"
            ));
            continue;
        }
        let filter = format!("project_id = '{}' AND source_id = '{}'", source.0, source.1);
        let text = clickhouse
            .query(&format!(
                "SELECT
                   (SELECT count() FROM {database}.metric_points WHERE {filter}) AS physical,
                   (SELECT count() FROM {database}.metric_points FINAL WHERE {filter}) AS final_rows,
                   count() AS samples, sum(fp) AS sum, groupBitXor(fp) AS xor,
                   countIf(variants > 1) AS divergent
                 FROM (
                   SELECT any({FINGERPRINT}) AS fp,
                     uniqExact(time_unix_nano, metric_name, resource_id, int_value, double_value,
                       point_attributes.path, point_attributes.string_value) AS variants
                   FROM {database}.metric_points WHERE {filter} GROUP BY sample_id)
                 FORMAT JSONEachRow SETTINGS {LIMITS}"
            ))
            .await?;
        let row: serde_json::Value = serde_json::from_str(text.trim())?;
        physical_rows += number(&row, "physical");
        final_rows += number(&row, "final_rows");
        distinct_samples += number(&row, "samples");
        divergent_replicas += number(&row, "divergent");
        let have = Totals {
            samples: number(&row, "samples"),
            sum: number(&row, "sum"),
            xor: number(&row, "xor"),
        };
        let want = expected.get(source).copied().unwrap_or_default();
        if number(&row, "final_rows") != want.samples {
            failures.push(format!(
                "FINAL returned {} rows for {} expected samples of {source:?}",
                number(&row, "final_rows"),
                want.samples
            ));
        }
        if want == have {
            continue;
        }
        let text = clickhouse
            .query(&format!(
                "SELECT DISTINCT lower(hex(sample_id)) FROM {database}.metric_points WHERE {filter} SETTINGS {LIMITS}"
            ))
            .await?;
        let stored: BTreeSet<String> = text.lines().map(str::to_owned).collect();
        let wanted: BTreeMap<String, &String> = origin
            .iter()
            .filter(|(_, batch)| {
                records
                    .get(*batch)
                    .is_some_and(|r| source_of(r.node) == *source)
            })
            .map(|(id, batch)| (hex(id), batch))
            .collect();
        let missing: Vec<_> = wanted
            .iter()
            .filter(|(id, _)| !stored.contains(*id))
            .map(|(id, batch)| format!("{batch}:{id}"))
            .take(10)
            .collect();
        let unexpected: Vec<_> = stored
            .iter()
            .filter(|id| !wanted.contains_key(*id))
            .take(10)
            .collect();
        failures.push(format!(
            "identity mismatch for {source:?}: expected {} stored {}; missing {missing:?}; unexpected {unexpected:?}",
            want.samples, have.samples
        ));
    }
    let expected_samples: u64 = expected.values().map(|t| t.samples).sum();
    if divergent_replicas != 0 {
        failures.push(format!(
            "{divergent_replicas} samples have physically different replicas"
        ));
    }
    let part_log =
        monitor::part_log(allocation, allocation.created_unix_nano / 1_000_000_000).await?;
    let inserted_rows = part_log
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["event_type"] == "NewPart")
        .map(|row| row["row_count"].as_u64().unwrap_or_default())
        .sum::<u64>();
    let normalized_records = lags
        .iter()
        .skip(1)
        .map(|lag| (lag.high - lag.low).max(0) as u64)
        .sum::<u64>();
    let ratio = |value: u64| {
        if expected_samples > 0 {
            value as f64 / expected_samples as f64
        } else {
            0.0
        }
    };
    let report = Report {
        raw_records: lags
            .first()
            .map_or(0, |lag| (lag.high - lag.low).max(0) as u64),
        normalized_records,
        inserted_rows,
        normalized_amplification: ratio(normalized_records),
        insert_amplification: ratio(inserted_rows),
        passed: failures.is_empty(),
        failures,
        acked_batches: acked,
        ambiguous_present,
        ambiguous_absent,
        rejected_batches: rejected,
        rejected_present,
        expected_samples,
        physical_rows,
        distinct_samples,
        final_rows,
        duplicate_rows: physical_rows.saturating_sub(distinct_samples),
        amplification: if final_rows > 0 {
            physical_rows as f64 / final_rows as f64
        } else {
            0.0
        },
        unenrolled_sources,
        divergent_replicas,
        sources: sources.len(),
        wait_seconds,
        lags,
        part_log,
        retained_bytes: kafka::retained_bytes(allocation).await.unwrap_or_default(),
    };
    std::fs::write(
        directory.join("verify.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}
