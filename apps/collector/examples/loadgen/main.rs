mod payload;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use clap::Parser;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use recount_collector::{
    Result,
    enrollment::{self, Authorization, EnrollmentConfig},
    transport::{self, Client, TIMEOUT},
};
use serde::Serialize;
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::{mpsc, watch},
    task::JoinSet,
    time::{self, Instant, MissedTickBehavior},
};
use tonic::{Code, Status, transport::Endpoint};
use uuid::Uuid;

const CADENCE: Duration = Duration::from_secs(1);

#[derive(Parser)]
struct Args {
    #[arg(long, value_delimiter = ',', default_value = "20")]
    stages: Vec<usize>,
    /// Seconds at each stage.
    #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u64).range(1..=86400))]
    seconds: u64,
    #[arg(long)]
    endpoint: String,
    #[arg(long)]
    enrollment_url: reqwest::Url,
    #[arg(long)]
    enrollment_key_file: PathBuf,
    #[arg(long)]
    state_directory: PathBuf,
    #[arg(long)]
    project: Uuid,
    #[arg(long)]
    run: Uuid,
    #[arg(long)]
    allow_remote: bool,
}

struct Node {
    machine: String,
    auth: Authorization,
}

struct Event {
    missed: u64,
    points: usize,
    elapsed: Option<Duration>,
    failure: Option<String>,
}

#[derive(Default, Serialize)]
struct Window {
    exports: u64,
    accepted_points: usize,
    missed_cycles: u64,
    failures: BTreeMap<String, u64>,
    #[serde(skip)]
    latencies: Vec<u64>,
}

impl Window {
    fn record(&mut self, event: Event) {
        self.missed_cycles += event.missed;
        self.accepted_points += event.points;
        if let Some(elapsed) = event.elapsed {
            self.exports += 1;
            let ms = elapsed.as_millis().min(TIMEOUT.as_millis()) as usize;
            if self.latencies.len() <= ms {
                self.latencies.resize(ms + 1, 0);
            }
            self.latencies[ms] += 1;
        }
        if let Some(failure) = event.failure {
            let key = if self.failures.len() < 128 || self.failures.contains_key(&failure) {
                failure
            } else {
                "other failures".into()
            };
            *self.failures.entry(key).or_default() += 1;
        }
    }

    fn report(&mut self, kind: &str, nodes: usize, bytes: u64, elapsed: Duration) -> Result<()> {
        let percentile = |p: u64| {
            if self.exports == 0 {
                return None;
            }
            let rank = (self.exports * p).div_ceil(100);
            let mut seen = 0;
            self.latencies.iter().position(|count| {
                seen += count;
                seen >= rank
            })
        };
        let seconds = elapsed.as_secs_f64();
        println!(
            "{}",
            serde_json::json!({
                "type": kind, "unix_ms": transport::unix_nanos()? / 1_000_000, "nodes": nodes,
                "seconds": seconds, "bytes_sent": bytes, "exports_per_second": self.exports as f64 / seconds,
                "accepted_points_per_second": self.accepted_points as f64 / seconds,
                "latency_p50_ms": percentile(50), "latency_p95_ms": percentile(95), "counts": self,
            })
        );
        Ok(())
    }
}

fn failure(status: &Status) -> String {
    let code = status.code();
    let message = status.message();
    let kind = if code == Code::DeadlineExceeded
        || code == Code::Cancelled && message == "Timeout expired"
        || message == "Connection timed out"
    {
        "deadline"
    } else if matches!(message, "Connection failed" | "gRPC connection failed")
        || code == Code::Unavailable && std::error::Error::source(status).is_some()
    {
        "transport"
    } else {
        "grpc"
    };
    format!(
        "{kind}: {code:?}: {}",
        message.chars().take(200).collect::<String>()
    )
}

async fn run_node(
    node: Node,
    ordinal: usize,
    fixture: ExportMetricsServiceRequest,
    endpoint: Endpoint,
    sent: Arc<AtomicU64>,
    events: mpsc::Sender<Event>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut replay = payload::Replay::new(fixture, &node.machine, ordinal);
    let mut client = Client::synthetic(endpoint, sent);
    let epoch = transport::unix_nanos()? / 1_000_000 * 1_000_000;
    let phase = u64::from_le_bytes(*Uuid::new_v4().as_bytes().first_chunk::<8>().unwrap()) % 1000;
    let mut next = Instant::now() + Duration::from_millis(phase);
    let mut cycle = 0;
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            () = time::sleep_until(next) => {},
        }
        let missed = Instant::now().saturating_duration_since(next).as_secs();
        next += Duration::from_secs(missed + 1);
        cycle += missed;
        let mut event = Event {
            missed,
            points: 0,
            elapsed: None,
            failure: None,
        };
        if let Some(token) = node.auth.current() {
            let now = transport::unix_nanos()?;
            let body = replay.next(now / 1_000_000 * 1_000_000, epoch, cycle);
            let mut request = transport::batch_request(body, &Uuid::now_v7().to_string(), now)?;
            request.metadata_mut().insert("authorization", token);
            let start = Instant::now();
            let result = time::timeout(TIMEOUT, client.export(request)).await;
            event.elapsed = Some(start.elapsed());
            match result {
                Ok(Ok(_)) => event.points = replay.points(),
                Ok(Err(status)) => {
                    if status.code() == Code::Unauthenticated {
                        node.auth.reject();
                    }
                    event.failure = Some(failure(&status));
                }
                Err(_) => {
                    client.disconnect();
                    event.failure = Some("deadline: export exceeded 3 seconds".into());
                }
            }
        } else {
            event.failure = Some("token: no valid access token".into());
            event.missed += 1;
        }
        cycle += 1;
        if events.send(event).await.is_err() {
            return Ok(());
        }
    }
}

fn validate_origin(url: &reqwest::Url, allow_remote: bool) -> Result<()> {
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host().is_none()
        || !((local && url.scheme() == "http")
            || (url.scheme() == "https" && (local || allow_remote)))
    {
        return Err(
            "explicit origins required; remote load requires HTTPS and --allow-remote".into(),
        );
    }
    Ok(())
}

async fn enroll(args: &Args) -> Result<Vec<Node>> {
    let count = *args.stages.last().ok_or("supply at least one stage")?;
    let mut nodes = Vec::with_capacity(count);
    for ordinal in 1..=count {
        let machine = format!("load-{}-{ordinal}", args.run);
        let config = EnrollmentConfig {
            url: args.enrollment_url.clone(),
            key_file: Some(args.enrollment_key_file.clone()),
            state_directory: args.state_directory.join(ordinal.to_string()),
        };
        let (_, auth) = time::timeout(
            Duration::from_secs(30),
            enrollment::start_as(config, &machine, &machine),
        )
        .await??;
        if auth.project != Some(args.project) {
            return Err("enrollment returned an unexpected project".into());
        }
        nodes.push(Node { machine, auth });
    }
    eprintln!(
        "Enrolled {} synthetic nodes in {}",
        nodes.len(),
        args.project
    );
    Ok(nodes)
}

async fn drive(args: Args, mut stop_signal: impl Future<Output = ()> + Unpin) -> Result<()> {
    validate_origin(&args.enrollment_url, args.allow_remote)?;
    validate_origin(&reqwest::Url::parse(&args.endpoint)?, args.allow_remote)?;
    if args.stages.first().is_none_or(|&n| n == 0)
        || args.stages.last().is_some_and(|&n| n > 1500)
        || args.stages.windows(2).any(|stages| stages[0] >= stages[1])
    {
        return Err("stages must be strictly increasing counts from 1 through 1500".into());
    }
    let endpoint = transport::endpoint(args.endpoint.clone())?;
    let fixture = payload::fixture()?;
    let mut nodes = tokio::select! {
        nodes = enroll(&args) => nodes?.into_iter().enumerate(),
        () = &mut stop_signal => return Ok(()),
    };
    let sent = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = mpsc::channel(4096);
    let (stop, stopped) = watch::channel(false);
    let mut tasks = JoinSet::new();
    let mut total = Window::default();
    let start = Instant::now();
    let mut stamp = start;
    let mut window = Window::default();
    let mut previous_bytes = 0;
    let mut active = 0;
    let mut ticks = time::interval_at(start + CADENCE, CADENCE);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    'stages: for &count in &args.stages {
        for (index, node) in nodes.by_ref().take(count - active) {
            tasks.spawn(run_node(
                node,
                index + 1,
                fixture.clone(),
                endpoint.clone(),
                sent.clone(),
                tx.clone(),
                stopped.clone(),
            ));
        }
        active = count;
        let end = time::sleep(Duration::from_secs(args.seconds));
        tokio::pin!(end);
        loop {
            tokio::select! {
                () = &mut stop_signal => break 'stages,
                _ = &mut end => break,
                Some(task) = tasks.join_next() => return task?.and(Err("node stopped early".into())),
                Some(event) = rx.recv() => {
                    window.record(Event { failure: event.failure.clone(), ..event });
                    total.record(event);
                }
                _ = ticks.tick() => {
                    let now = Instant::now();
                    let bytes = sent.load(Ordering::Relaxed);
                    window.report("second", active, bytes - previous_bytes, now - stamp)?;
                    stamp = now;
                    previous_bytes = bytes;
                    window = Window::default();
                }
            }
        }
    }
    stop.send_replace(true);
    drop(tx);
    while let Some(event) = rx.recv().await {
        total.record(event);
    }
    while let Some(task) = tasks.join_next().await {
        task??;
    }
    total.report(
        "total",
        active,
        sent.load(Ordering::Relaxed),
        start.elapsed(),
    )?;
    if total.accepted_points == 0 {
        return Err("no OTLP points accepted".into());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    drive(
        Args::parse(),
        Box::pin(async move {
            tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
        }),
    )
    .await
}
