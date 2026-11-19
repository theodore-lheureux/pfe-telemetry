use crate::{Result, allocation::Allocation, postgres};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::ValueEnum;
use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::Mutex,
    time::Duration,
};
use tonic_health::pb::{
    HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Service {
    IngestionApi,
    Normalizer,
}

impl Service {
    fn binary(self) -> &'static str {
        match self {
            Self::IngestionApi => "recount-ingestion-api",
            Self::Normalizer => "recount-normalizer",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::IngestionApi => "ingestion-api",
            Self::Normalizer => "normalizer",
        }
    }
}

pub fn pid_file(run: &Path, service: Service) -> PathBuf {
    run.join(format!("{}.pid", service.name()))
}

pub fn pid(run: &Path, service: Service) -> Option<u32> {
    std::fs::read_to_string(pid_file(run, service))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Children started by this process, so a stopped child is reaped rather than left a zombie
/// that `kill -0` still reports.
static CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

fn alive(pid: u32) -> bool {
    if let Ok(mut children) = CHILDREN.lock()
        && let Some(index) = children.iter().position(|c| c.id() == pid)
    {
        if children[index].try_wait().is_ok_and(|s| s.is_none()) {
            return true;
        }
        // Already exited: wait returns the collected status immediately.
        let _ = children.remove(index).wait();
        return false;
    }
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn environment(
    allocation: &Allocation,
    run: &Path,
    service: Service,
) -> Result<Vec<(String, String)>> {
    let settings = &allocation.settings;
    let mut values = vec![
        ("RECOUNT_KAFKA_BOOTSTRAP", allocation.broker.clone()),
        ("RECOUNT_RAW_TOPIC", allocation.raw_topic.clone()),
        (
            "RECOUNT_RAW_PARTITIONS",
            settings.raw_partitions.to_string(),
        ),
        ("RUST_LOG", "warn".into()),
    ];
    match service {
        Service::IngestionApi => {
            let public =
                URL_SAFE_NO_PAD.encode(allocation.signing_key().verifying_key().as_bytes());
            values.extend([
                ("RECOUNT_INGESTION_ADDR", allocation.ingestion_addr.clone()),
                (
                    "RECOUNT_INGESTION_DATABASE_URL",
                    postgres::ingestion_url(allocation)?,
                ),
                ("RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS", public),
                (
                    "RECOUNT_PARTICIPANT_TOPIC",
                    allocation.participant_topic.clone(),
                ),
                ("RECOUNT_LIVE_TOPIC", allocation.live_topic.clone()),
                (
                    "RECOUNT_INGESTION_MAX_IN_FLIGHT",
                    settings.ingestion_max_in_flight.to_string(),
                ),
            ]);
        }
        Service::Normalizer => values.extend([
            (
                "RECOUNT_NORMALIZED_TOPIC",
                allocation.normalized_topic.clone(),
            ),
            ("RECOUNT_LATE_TOPIC", allocation.late_topic.clone()),
            (
                "RECOUNT_NORMALIZER_GROUP",
                allocation.normalizer_group.clone(),
            ),
            (
                "RECOUNT_NORMALIZED_PARTITIONS",
                settings.normalized_partitions.to_string(),
            ),
            (
                "RECOUNT_NORMALIZER_MAX_ACTIVE",
                settings.normalizer_max_active.to_string(),
            ),
            (
                "RECOUNT_NORMALIZER_METRICS_FILE",
                run.join("normalizer.prom")
                    .canonicalize()
                    .unwrap_or(run.join("normalizer.prom"))
                    .display()
                    .to_string(),
            ),
        ]),
    }
    Ok(values.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

pub async fn start(
    allocation: &Allocation,
    run: &Path,
    service: Service,
    bin_dir: Option<PathBuf>,
) -> Result<()> {
    if pid(run, service).is_some_and(alive) {
        return Err(format!("{} is already running", service.name()).into());
    }
    let directory = match bin_dir {
        Some(directory) => directory,
        None => std::env::current_exe()?
            .parent()
            .ok_or("executable directory")?
            .to_owned(),
    };
    let log_path = run.join("logs").join(format!("{}.log", service.name()));
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_offset = log.metadata()?.len() as usize;
    let mut command = std::process::Command::new(directory.join(service.binary()));
    // Only explicit settings reach the service, never the caller's broader environment.
    // A separate process group outlives the shell or tool invocation that started it.
    command
        .process_group(0)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(environment(allocation, run, service)?)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    let child = command.spawn()?;
    let id = child.id();
    std::fs::write(pid_file(run, service), id.to_string())?;
    CHILDREN.lock().map_err(|_| "child registry")?.push(child);
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(60);
    loop {
        if !alive(id) {
            return Err(format!("{} exited; see {}", service.name(), log_path.display()).into());
        }
        if ready(allocation, &log_path, log_offset, service).await {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            return Err(format!("{} not ready within 60 s", service.name()).into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    eprintln!(
        "service_ready service={} pid={} seconds={:.3}",
        service.name(),
        id,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn ready(allocation: &Allocation, log: &Path, offset: usize, service: Service) -> bool {
    match service {
        Service::IngestionApi => {
            let Ok(endpoint) = tonic::transport::Endpoint::from_shared(format!(
                "http://{}",
                allocation.ingestion_addr
            )) else {
                return false;
            };
            let Ok(channel) = endpoint.connect().await else {
                return false;
            };
            let mut client = HealthClient::new(channel);
            client
                .check(HealthCheckRequest {
                    service: "opentelemetry.proto.collector.metrics.v1.MetricsService".into(),
                })
                .await
                .is_ok_and(|r| r.into_inner().status == ServingStatus::Serving as i32)
        }
        Service::Normalizer => std::fs::read(log).is_ok_and(|text| {
            String::from_utf8_lossy(text.get(offset..).unwrap_or_default()).contains("state=ready")
        }),
    }
}

pub async fn stop(run: &Path, service: Service, kill: bool) -> Result<()> {
    let Some(pid) = pid(run, service) else {
        return Ok(());
    };
    if alive(pid) {
        let signal = if kill { "-KILL" } else { "-TERM" };
        std::process::Command::new("kill")
            .args([signal, &pid.to_string()])
            .status()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while alive(pid) {
            if tokio::time::Instant::now() > deadline {
                return Err(format!("{} did not stop", service.name()).into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    std::fs::remove_file(pid_file(run, service))?;
    eprintln!(
        "service_stopped service={} pid={pid} signal={}",
        service.name(),
        if kill { "KILL" } else { "TERM" }
    );
    Ok(())
}
