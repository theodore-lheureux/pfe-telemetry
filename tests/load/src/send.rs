use crate::{
    Result,
    allocation::{Allocation, NodeKind, phase_dir, unix_nanos},
    monitor,
    stats::{Distribution, distribution},
    workload::{self, Shape},
};
use clap::Args;
use opentelemetry_proto::tonic::collector::metrics::v1::{
    ExportMetricsServiceRequest, metrics_service_client::MetricsServiceClient,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc},
    time::Instant,
};
use tonic::{Code, Request, codec::CompressionEncoding, transport::Channel};

#[derive(Args, Clone, Debug, Serialize, Deserialize)]
pub struct SendArgs {
    /// Phase label; batch identities are `<label>-<node>-<sequence>` and must stay unique.
    #[arg(long)]
    pub label: String,
    /// Mean offered batches per second across the selected nodes, as Poisson arrivals.
    #[arg(long)]
    pub rate: f64,
    #[arg(long)]
    pub seconds: f64,
    /// Use only the first N nodes; all by default.
    #[arg(long)]
    pub nodes: Option<usize>,
    /// Send every batch from this node index only.
    #[arg(long, conflicts_with = "nodes")]
    pub only_node: Option<usize>,
    #[command(flatten)]
    pub shape: Shape,
    /// HTTP/2 connections shared by the nodes.
    #[arg(long, default_value_t = 8)]
    pub connections: usize,
    /// Client-side bound on unfinished batches; a schedule slot without capacity is skipped
    /// and counted instead of delaying later arrivals.
    #[arg(long, default_value_t = 512)]
    pub max_outstanding: usize,
    #[arg(long, default_value_t = 6)]
    pub max_attempts: u32,
    #[arg(long, default_value_t = 10_000)]
    pub timeout_ms: u64,
    /// Resend every Nth acknowledged batch unchanged, as after a lost response; 0 disables.
    #[arg(long, default_value_t = 0)]
    pub resend_every: u64,
    /// Delay before such a resend; beyond the 2 s flush window the copy lands in another
    /// insert block instead of being collapsed while the block is written.
    #[arg(long, default_value_t = 0)]
    pub resend_delay_ms: u64,
    /// Interval between single-point freshness probes; 0 disables.
    #[arg(long, default_value_t = 1000)]
    pub probe_interval_ms: u64,
    #[arg(long, default_value_t = 5)]
    pub monitor_interval: u64,
    #[arg(long)]
    pub gzip: bool,
    /// Send to this address instead of the allocation's, such as a fault-injection proxy.
    #[arg(long)]
    pub address: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BatchRecord {
    pub node: usize,
    pub sequence: u64,
    pub batch: String,
    pub created: u64,
    pub layout: Vec<u32>,
    pub points: u32,
    pub samples: u64,
    pub bytes: usize,
    /// `acked`, `rejected` (terminal code before publication) or `ambiguous`.
    pub outcome: String,
    pub code: String,
    pub attempts: u32,
    pub first_ms: f64,
    pub total_ms: f64,
    pub schedule_delay_ms: f64,
    pub resent: Option<String>,
    pub probe: bool,
    pub visible_ms: Option<f64>,
    pub codes: BTreeMap<String, u32>,
    pub sent_at_ms: f64,
}

#[derive(Serialize)]
pub struct Summary {
    pub label: String,
    pub args: SendArgs,
    pub host: serde_json::Value,
    pub started_unix_nano: u64,
    pub schedule_seconds: f64,
    pub completion_seconds: f64,
    pub offered_batches: u64,
    pub skipped_batches: u64,
    pub outcomes: BTreeMap<String, u64>,
    pub codes: BTreeMap<String, u64>,
    pub acked_samples: u64,
    pub acked_bytes: u64,
    pub acked_batches_per_second: f64,
    pub acked_samples_per_second: f64,
    pub acked_bytes_per_second: f64,
    pub mean_batch_bytes: f64,
    pub mean_samples_per_batch: f64,
    pub first_attempt_ms: Distribution,
    pub acknowledged_ms: Distribution,
    pub schedule_delay_ms: Distribution,
    pub probe_ack_ms: Distribution,
    pub probe_visible_ms: Distribution,
    pub probe_visible_after_ack_ms: Distribution,
    pub resends: BTreeMap<String, u64>,
    /// First and last acknowledgement times after the phase start, per terminal code.
    pub code_windows_ms: BTreeMap<String, (f64, f64)>,
}

struct Context {
    allocation: Allocation,
    args: SendArgs,
    clients: Vec<MetricsServiceClient<Channel>>,
    tokens: Mutex<Vec<(u64, String)>>,
    started: Instant,
}

impl Context {
    fn token(&self, node: usize) -> String {
        let now = unix_nanos() / 1_000_000_000;
        let mut tokens = self.tokens.lock().expect("token cache");
        if now.saturating_sub(tokens[node].0) > workload::TOKEN_SECONDS / 2 {
            let signing = self.allocation.signing_key();
            tokens[node] = (
                now,
                workload::token(
                    &signing,
                    &self.allocation,
                    &self.allocation.nodes[node],
                    now,
                ),
            );
        }
        tokens[node].1.clone()
    }

    fn request(
        &self,
        node: usize,
        batch: &str,
        created: u64,
        body: &ExportMetricsServiceRequest,
    ) -> Request<ExportMetricsServiceRequest> {
        let mut request = Request::new(body.clone());
        request.set_timeout(Duration::from_millis(self.args.timeout_ms));
        let metadata = request.metadata_mut();
        metadata.insert(
            "authorization",
            format!("Bearer {}", self.token(node))
                .parse()
                .expect("ASCII token"),
        );
        metadata.insert("recount-batch-id", batch.parse().expect("ASCII batch"));
        metadata.insert(
            "recount-batch-created-unix-nano",
            created.to_string().parse().expect("digits"),
        );
        if self.allocation.nodes[node].kind == NodeKind::Linux {
            metadata.insert(
                "recount-collection-profile",
                "linux".parse().expect("ASCII"),
            );
        }
        request
    }

    fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }
}

/// Seeded Poisson arrivals: many independent collectors exporting on their own intervals
/// arrive at random rather than in lockstep, and the label makes a run repeatable.
struct Arrivals {
    state: u64,
    rate: f64,
    elapsed: f64,
}

impl Arrivals {
    fn new(label: &str, rate: f64) -> Self {
        let digest = Sha256::digest(label.as_bytes());
        Self {
            state: u64::from_be_bytes(digest[..8].try_into().expect("eight bytes")),
            rate,
            elapsed: 0.0,
        }
    }

    /// Offset of the next arrival from the phase start.
    fn next(&mut self) -> Duration {
        // SplitMix64, then an exponential gap with the configured mean.
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let uniform = ((z >> 11) as f64 + 0.5) / (1u64 << 53) as f64;
        self.elapsed += -uniform.ln() / self.rate;
        Duration::from_secs_f64(self.elapsed)
    }
}

fn code_name(code: Code) -> String {
    format!("{code:?}")
}

fn retryable(code: Code) -> bool {
    matches!(
        code,
        Code::Unavailable
            | Code::DeadlineExceeded
            | Code::Cancelled
            | Code::Unknown
            | Code::Internal
    )
}

/// Whether the request may have been published although it was not acknowledged. Only the
/// admission limit rejects before reading the body.
fn ambiguous(status: &tonic::Status) -> bool {
    retryable(status.code()) && !status.message().contains("at capacity")
}

/// Sends one batch with collector-style retries of identical bytes and identity.
async fn deliver(
    context: &Context,
    node: usize,
    record: &mut BatchRecord,
    body: &ExportMetricsServiceRequest,
    scheduled: Instant,
) {
    let mut client = context.clients[node % context.clients.len()].clone();
    let mut uncertain = false;
    record.sent_at_ms = context.elapsed_ms();
    for attempt in 1..=context.args.max_attempts {
        record.attempts = attempt;
        let started = Instant::now();
        let result = client
            .export(context.request(node, &record.batch, record.created, body))
            .await;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        if attempt == 1 {
            record.first_ms = elapsed;
        }
        let code = result
            .as_ref()
            .err()
            .map_or(Code::Ok, |status| status.code());
        *record.codes.entry(code_name(code)).or_default() += 1;
        record.code = code_name(code);
        if code == Code::Ok {
            record.outcome = "acked".into();
            record.total_ms = scheduled.elapsed().as_secs_f64() * 1000.0;
            return;
        }
        uncertain |= result.as_ref().err().is_some_and(ambiguous);
        if !retryable(code) || attempt == context.args.max_attempts {
            break;
        }
        // The collector's equal jitter, with a shorter ceiling for bounded experiments.
        let ceiling = (200u64 << (attempt - 1).min(4)).min(3000);
        let random = uuid::Uuid::now_v7().as_u128() as u64;
        let backoff = ceiling / 2 + random % (ceiling / 2 + 1);
        tokio::time::sleep(Duration::from_millis(backoff)).await;
    }
    record.total_ms = scheduled.elapsed().as_secs_f64() * 1000.0;
    record.outcome = if uncertain { "ambiguous" } else { "rejected" }.into();
}

async fn probe(context: Arc<Context>, index: u64, results: mpsc::UnboundedSender<BatchRecord>) {
    let shape = Shape {
        metrics: 1,
        processes: 0,
        points: 1,
        attributes: 1,
        series: 1,
        padding: 0,
        foreign_resource: false,
    };
    let node = 0;
    let created = unix_nanos();
    let batch = format!("{}-probe-{index}", context.args.label);
    let body = workload::request(
        node,
        &context.allocation.nodes[node],
        index,
        created,
        &shape,
    );
    let layout = workload::layout(NodeKind::Direct, &shape);
    let mut record = BatchRecord {
        node,
        sequence: index,
        batch: batch.clone(),
        created,
        samples: 1,
        bytes: body.encoded_len(),
        layout: layout.clone(),
        points: 1,
        probe: true,
        ..Default::default()
    };
    let started = Instant::now();
    deliver(&context, node, &mut record, &body, started).await;
    if record.outcome == "acked" {
        let allocation = &context.allocation;
        let id = workload::sample_ids(
            &allocation.projects[allocation.nodes[node].project],
            &allocation.nodes[node].id,
            &batch,
            &layout,
            1,
        )[0];
        let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
        let definition = &allocation.nodes[node];
        // The full sorting key and partition, so each poll reads one granule rather than
        // scanning the table while it grows.
        let sql = format!(
            "SELECT count() FROM {}.metric_points WHERE event_day = {} AND project_id = '{}'
               AND source_id = '{}' AND resource_id = '{}' AND metric_name = 'load.gauge.0'
               AND time_unix_nano = {created} AND sample_id = unhex('{hex}')",
            allocation.database,
            created / 86_400_000_000_000,
            allocation.projects[definition.project],
            definition.id,
            definition.root,
        );
        if let Ok(clickhouse) = allocation.clickhouse() {
            let deadline = started + Duration::from_secs(300);
            while Instant::now() < deadline {
                if clickhouse.number(&sql).await.is_ok_and(|n| n > 0) {
                    record.visible_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    let _ = results.send(record);
}

pub fn host() -> serde_json::Value {
    let run = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    serde_json::json!({
        "uname": run("uname", &["-srm"]),
        "cpus": run("sysctl", &["-n", "hw.ncpu"]).or_else(|| run("nproc", &[])),
        "memory_bytes": run("sysctl", &["-n", "hw.memsize"]),
        "load_average": run("sysctl", &["-n", "vm.loadavg"]),
    })
}

pub async fn run(allocation: &Allocation, run: &Path, args: SendArgs) -> Result<Summary> {
    let directory = phase_dir(run, &args.label)?;
    let path = directory.join("batches.jsonl");
    if path.exists() {
        return Err("phase label already used; batch identities must stay unique".into());
    }
    if !(args.rate > 0.0 && args.seconds > 0.0) || args.shape.points == 0 {
        return Err("positive rate, duration and points are required".into());
    }
    let selected = args
        .nodes
        .unwrap_or(allocation.nodes.len())
        .min(allocation.nodes.len());
    if args
        .only_node
        .is_some_and(|node| node >= allocation.nodes.len())
        || selected == 0
    {
        return Err("node selection outside the allocation".into());
    }
    let mut clients = Vec::new();
    for _ in 0..args.connections.max(1) {
        let channel = Channel::from_shared(format!(
            "http://{}",
            args.address.as_ref().unwrap_or(&allocation.ingestion_addr)
        ))?
        .tcp_nodelay(true)
        .connect_timeout(Duration::from_secs(3))
        .connect_lazy();
        let mut client = MetricsServiceClient::new(channel)
            .max_decoding_message_size(64 * 1024 * 1024)
            .max_encoding_message_size(64 * 1024 * 1024);
        if args.gzip {
            client = client.send_compressed(CompressionEncoding::Gzip);
        }
        clients.push(client);
    }
    let context = Arc::new(Context {
        allocation: allocation.clone(),
        clients,
        tokens: Mutex::new(vec![(0, String::new()); allocation.nodes.len()]),
        started: Instant::now(),
        args: args.clone(),
    });
    let started_unix_nano = unix_nanos();
    let stop = Arc::new(tokio::sync::Notify::new());
    let sampler = tokio::spawn(monitor::sample_until(
        allocation.clone(),
        run.to_owned(),
        args.label.clone(),
        args.monitor_interval,
        stop.clone(),
    ));
    let (results, mut received) = mpsc::unbounded_channel::<BatchRecord>();
    let writer = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<BatchRecord>> {
            let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
            let mut all = Vec::new();
            while let Some(record) = received.blocking_recv() {
                serde_json::to_writer(&mut file, &record)?;
                file.write_all(b"\n")?;
                all.push(record);
            }
            file.flush()?;
            Ok(all)
        })
    };
    let permits = Arc::new(Semaphore::new(args.max_outstanding));
    let mut arrivals = Arrivals::new(&args.label, args.rate);
    let end = context.started + Duration::from_secs_f64(args.seconds);
    let mut skipped = 0;
    let mut offered = 0u64;
    let probes = {
        let context = context.clone();
        let results = results.clone();
        tokio::spawn(async move {
            let mut tasks = Vec::new();
            if context.args.probe_interval_ms > 0 {
                let mut index = 0;
                let interval = Duration::from_millis(context.args.probe_interval_ms);
                while Instant::now() + interval <= end {
                    tokio::time::sleep(interval).await;
                    tasks.push(tokio::spawn(probe(context.clone(), index, results.clone())));
                    index += 1;
                }
            }
            for task in tasks {
                let _ = task.await;
            }
        })
    };
    let mut tasks = Vec::new();
    loop {
        let scheduled = context.started + arrivals.next();
        if scheduled >= end {
            break;
        }
        tokio::time::sleep_until(scheduled).await;
        let slot = offered;
        offered += 1;
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            skipped += 1;
            continue;
        };
        let context = context.clone();
        let results = results.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            let (node, sequence) = match context.args.only_node {
                Some(node) => (node, slot),
                None => ((slot % selected as u64) as usize, slot / selected as u64),
            };
            let definition = &context.allocation.nodes[node];
            let created = unix_nanos();
            let shape = &context.args.shape;
            let body = workload::request(node, definition, sequence, created, shape);
            let layout = workload::layout(definition.kind, shape);
            let mut record = BatchRecord {
                node,
                sequence,
                batch: format!("{}-{node}-{sequence}", context.args.label),
                created,
                samples: u64::from(layout.iter().sum::<u32>()) * u64::from(shape.points),
                layout,
                points: shape.points,
                bytes: body.encoded_len(),
                schedule_delay_ms: scheduled.elapsed().as_secs_f64() * 1000.0,
                ..Default::default()
            };
            deliver(&context, node, &mut record, &body, scheduled).await;
            if record.outcome == "acked"
                && context.args.resend_every > 0
                && slot.is_multiple_of(context.args.resend_every)
            {
                tokio::time::sleep(Duration::from_millis(context.args.resend_delay_ms)).await;
                let mut resend = record.clone();
                deliver(&context, node, &mut resend, &body, Instant::now()).await;
                record.resent = Some(resend.outcome);
            }
            let _ = results.send(record);
        }));
    }
    let schedule_seconds = context.started.elapsed().as_secs_f64();
    for task in tasks {
        task.await?;
    }
    probes.await?;
    let completion_seconds = context.started.elapsed().as_secs_f64();
    drop(results);
    let records = writer.await??;
    stop.notify_one();
    sampler.await??;
    let mut outcomes = BTreeMap::new();
    let mut codes = BTreeMap::new();
    let mut resends = BTreeMap::new();
    let mut windows: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let (mut samples, mut bytes, mut load_batches) = (0, 0, 0u64);
    let (mut first, mut acked_ms, mut delay) = (Vec::new(), Vec::new(), Vec::new());
    let (mut probe_ack, mut probe_visible, mut probe_after) = (Vec::new(), Vec::new(), Vec::new());
    for record in &records {
        *outcomes
            .entry(format!(
                "{}{}",
                if record.probe { "probe_" } else { "" },
                record.outcome
            ))
            .or_insert(0) += 1;
        for (code, count) in &record.codes {
            *codes.entry(code.clone()).or_insert(0) += u64::from(*count);
        }
        let window = windows
            .entry(record.code.clone())
            .or_insert((f64::MAX, 0.0));
        window.0 = window.0.min(record.sent_at_ms);
        window.1 = window.1.max(record.sent_at_ms);
        if let Some(resent) = &record.resent {
            *resends.entry(resent.clone()).or_insert(0) += 1;
        }
        if record.probe {
            if record.outcome == "acked" {
                probe_ack.push(record.total_ms);
                if let Some(visible) = record.visible_ms {
                    probe_visible.push(visible);
                    probe_after.push(visible - record.total_ms);
                }
            }
            continue;
        }
        load_batches += 1;
        delay.push(record.schedule_delay_ms);
        if record.outcome == "acked" {
            samples += record.samples;
            bytes += record.bytes as u64;
            acked_ms.push(record.total_ms);
            if record.attempts == 1 {
                first.push(record.first_ms);
            }
        }
    }
    let acked = acked_ms.len() as f64;
    let summary = Summary {
        label: args.label.clone(),
        host: host(),
        started_unix_nano,
        schedule_seconds,
        completion_seconds,
        offered_batches: offered,
        skipped_batches: skipped,
        outcomes,
        codes,
        acked_samples: samples,
        acked_bytes: bytes,
        acked_batches_per_second: acked / schedule_seconds,
        acked_samples_per_second: samples as f64 / schedule_seconds,
        acked_bytes_per_second: bytes as f64 / schedule_seconds,
        mean_batch_bytes: if acked > 0.0 {
            bytes as f64 / acked
        } else {
            0.0
        },
        mean_samples_per_batch: if acked > 0.0 {
            samples as f64 / acked
        } else {
            0.0
        },
        first_attempt_ms: distribution(&first),
        acknowledged_ms: distribution(&acked_ms),
        schedule_delay_ms: distribution(&delay),
        probe_ack_ms: distribution(&probe_ack),
        probe_visible_ms: distribution(&probe_visible),
        probe_visible_after_ack_ms: distribution(&probe_after),
        resends,
        code_windows_ms: windows,
        args,
    };
    debug_assert!(load_batches + skipped == offered);
    std::fs::write(
        directory.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrivals_are_repeatable_with_the_requested_mean_rate() {
        let mut first = Arrivals::new("phase", 100.0);
        let mut second = Arrivals::new("phase", 100.0);
        let times: Vec<_> = (0..20_000).map(|_| first.next()).collect();
        assert!(times.iter().all(|t| *t == second.next()));
        let rate = 20_000.0 / times.last().unwrap().as_secs_f64();
        assert!((95.0..105.0).contains(&rate), "{rate}");
        assert_ne!(Arrivals::new("other", 100.0).next(), times[0]);
    }
}
