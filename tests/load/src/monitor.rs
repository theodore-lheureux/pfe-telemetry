use crate::{
    Result,
    allocation::{Allocation, phase_dir, unix_nanos},
    kafka::{self, GroupLag},
    postgres,
    services::{self, Service},
};
use serde::Serialize;
use std::{io::Write, path::Path, sync::Arc, time::Duration};
use tokio::{sync::Notify, time::Instant};

fn cpu_seconds(value: &str) -> Option<f64> {
    // ps prints [[dd-]hh:]mm:ss.ss
    let (days, rest) = value.split_once('-').unwrap_or(("0", value));
    let mut seconds = days.parse::<f64>().ok()? * 86400.0;
    let mut scale = 1.0;
    for part in rest.rsplit(':') {
        seconds += part.parse::<f64>().ok()? * scale;
        scale *= 60.0;
    }
    Some(seconds)
}

fn process(pid: u32) -> Option<serde_json::Value> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=,pcpu=,time=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let fields: Vec<_> = text.split_whitespace().collect();
    if fields.len() < 3 {
        return None;
    }
    Some(serde_json::json!({
        "pid": pid,
        "rss_kib": fields[0].parse::<u64>().ok()?,
        "cpu_percent": fields[1].parse::<f64>().ok()?,
        "cpu_seconds": cpu_seconds(fields[2])?,
    }))
}

async fn containers() -> serde_json::Value {
    let Ok(names) = std::env::var("RECOUNT_LOAD_CONTAINERS") else {
        return serde_json::Value::Null;
    };
    let mut command = tokio::process::Command::new("docker");
    command.args(["stats", "--no-stream", "--format", "{{json .}}"]);
    command.args(names.split(',').filter(|n| !n.is_empty()));
    let Ok(output) = command.output().await else {
        return serde_json::Value::Null;
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|v| {
            serde_json::json!({
                "name": v["Name"], "cpu": v["CPUPerc"], "memory": v["MemUsage"],
                "net": v["NetIO"], "block": v["BlockIO"],
            })
        })
        .collect()
}

pub fn lags(allocation: &Allocation) -> Result<Vec<GroupLag>> {
    Ok(vec![
        kafka::lag(
            allocation,
            &allocation.raw_topic,
            &allocation.normalizer_group,
        )?,
        kafka::lag(
            allocation,
            &allocation.normalized_topic,
            &allocation.clickhouse_group,
        )?,
        kafka::lag(
            allocation,
            &allocation.late_topic,
            &allocation.clickhouse_late_group,
        )?,
    ])
}

async fn clickhouse(allocation: &Allocation) -> serde_json::Value {
    let Ok(client) = allocation.clickhouse() else {
        return serde_json::Value::Null;
    };
    let database = &allocation.database;
    let sql = format!(
        "SELECT
           (SELECT count() FROM system.parts WHERE database='{database}' AND table='metric_points' AND active) AS active_parts,
           (SELECT max(c) FROM (SELECT count() AS c FROM system.parts WHERE database='{database}' AND table='metric_points' AND active GROUP BY partition)) AS max_parts_in_partition,
           (SELECT sum(rows) FROM system.parts WHERE database='{database}' AND table='metric_points' AND active) AS physical_rows,
           (SELECT sum(bytes_on_disk) FROM system.parts WHERE database='{database}' AND table='metric_points' AND active) AS bytes_on_disk,
           (SELECT count() FROM system.merges WHERE database='{database}') AS running_merges,
           (SELECT value FROM system.metrics WHERE metric='MemoryTracking') AS server_memory_tracking,
           (SELECT sum(num_messages_read) FROM system.kafka_consumers WHERE database='{database}' AND table='normalized_kafka') AS kafka_messages_read,
           (SELECT sum(num_commits) FROM system.kafka_consumers WHERE database='{database}' AND table='normalized_kafka') AS kafka_commits,
           (SELECT sum(length(`exceptions.text`)) FROM system.kafka_consumers WHERE database='{database}') AS kafka_exceptions
         FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers=0"
    );
    match client.query(&sql).await {
        Ok(text) => serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null),
        Err(error) => serde_json::json!({ "error": error.to_string() }),
    }
}

fn normalizer_metrics(run: &Path) -> serde_json::Value {
    let Ok(text) = std::fs::read_to_string(run.join("normalizer.prom")) else {
        return serde_json::Value::Null;
    };
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.rsplit_once(' '))
        .filter_map(|(key, value)| Some((key.to_owned(), value.parse::<f64>().ok()?.into())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

pub async fn sample(allocation: &Allocation, run: &Path, started: Instant) -> serde_json::Value {
    let mut processes = serde_json::Map::new();
    for service in [Service::IngestionApi, Service::Normalizer] {
        if let Some(value) = services::pid(run, service).and_then(process) {
            processes.insert(format!("{service:?}"), value);
        }
    }
    let lag_allocation = allocation.clone();
    let lags = tokio::task::spawn_blocking(move || lags(&lag_allocation))
        .await
        .ok()
        .and_then(Result::ok)
        .map(|v| serde_json::to_value(v).unwrap_or_default())
        .unwrap_or_default();
    let (containers, clickhouse, postgres) = tokio::join!(
        containers(),
        clickhouse(allocation),
        postgres::activity(allocation)
    );
    serde_json::json!({
        "t_ms": (started.elapsed().as_secs_f64() * 1000.0).round(),
        "unix_nano": unix_nanos(),
        "processes": processes,
        "lags": lags,
        "clickhouse": clickhouse,
        "containers": containers,
        "postgres": postgres.unwrap_or_default(),
        "normalizer": normalizer_metrics(run),
    })
}

pub async fn sample_until(
    allocation: Allocation,
    run: std::path::PathBuf,
    label: String,
    interval: u64,
    stop: Arc<Notify>,
) -> Result<()> {
    let path = phase_dir(&run, &label)?.join("resources.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let started = Instant::now();
    let stopped = stop.notified();
    tokio::pin!(stopped);
    loop {
        let value = sample(&allocation, &run, started).await;
        serde_json::to_writer(&mut file, &value)?;
        file.write_all(b"\n")?;
        tokio::select! {
            () = &mut stopped => break,
            () = tokio::time::sleep(Duration::from_secs(interval.max(1))) => {}
        }
    }
    let value = sample(&allocation, &run, started).await;
    serde_json::to_writer(&mut file, &value)?;
    file.write_all(b"\n")?;
    Ok(())
}

pub async fn run(
    allocation: &Allocation,
    run: &Path,
    label: &str,
    seconds: u64,
    interval: u64,
) -> Result<()> {
    let stop = Arc::new(Notify::new());
    let task = tokio::spawn(sample_until(
        allocation.clone(),
        run.to_owned(),
        label.to_owned(),
        interval,
        stop.clone(),
    ));
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    stop.notify_one();
    task.await?
}

#[derive(Serialize)]
pub struct Drain {
    pub label: String,
    pub drained: bool,
    pub seconds: f64,
    pub initial: Vec<GroupLag>,
    pub records_per_second: Vec<f64>,
}

/// Polls every second until all three groups report zero lag.
pub async fn drain(
    allocation: &Allocation,
    run: &Path,
    label: &str,
    timeout: u64,
) -> Result<Drain> {
    let directory = phase_dir(run, label)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("drain.jsonl"))?;
    let started = Instant::now();
    let initial = lags(allocation)?;
    let mut drained = false;
    while started.elapsed() < Duration::from_secs(timeout) {
        let current = lags(allocation)?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({ "t_ms": (started.elapsed().as_secs_f64() * 1000.0).round(), "lags": current }),
        )?;
        file.write_all(b"\n")?;
        if current.iter().all(|lag| lag.lag == 0) {
            drained = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let seconds = started.elapsed().as_secs_f64();
    let result = Drain {
        label: label.to_owned(),
        drained,
        seconds,
        records_per_second: initial
            .iter()
            .map(|lag| {
                if seconds > 0.0 {
                    lag.lag as f64 / seconds
                } else {
                    0.0
                }
            })
            .collect(),
        initial,
    };
    std::fs::write(
        directory.join("drain.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    Ok(result)
}

/// Insert and merge activity of the owned point table since a time, from `system.part_log`.
pub async fn part_log(allocation: &Allocation, since_unix: u64) -> Result<serde_json::Value> {
    let client = allocation.clickhouse()?;
    client.query("SYSTEM FLUSH LOGS").await?;
    let text = client
        .query(&format!(
            "SELECT event_type, count() AS events, sum(rows) AS row_count, round(avg(rows), 1) AS mean_rows,
               sum(size_in_bytes) AS bytes, quantileExact(0.5)(duration_ms) AS duration_p50_ms,
               quantileExact(0.95)(duration_ms) AS duration_p95_ms, max(duration_ms) AS duration_max_ms,
               quantileExact(0.5)(peak_memory_usage) AS peak_memory_p50, max(peak_memory_usage) AS peak_memory_max,
               countIf(error != 0) AS errors
             FROM system.part_log WHERE database='{}' AND table='metric_points' AND event_time >= toDateTime({since_unix})
             GROUP BY event_type ORDER BY event_type FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers=0",
            allocation.database
        ))
        .await?;
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect())
}
