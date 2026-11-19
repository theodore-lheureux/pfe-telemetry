mod allocation;
mod check;
mod clickhouse;
mod kafka;
mod monitor;
mod postgres;
mod send;
mod services;
mod stats;
mod verify;
mod workload;

use allocation::{Allocation, PrepareArgs};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Parser)]
#[command(
    name = "recount-pipeline-load",
    version,
    about = "Isolated load, fault and exact-identity experiments for the metric pipeline"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create disposable topics, ClickHouse and PostgreSQL databases and synthetic principals.
    Prepare {
        #[arg(long)]
        run: PathBuf,
        #[command(flatten)]
        args: PrepareArgs,
    },
    /// Start the native ingestion API or normalizer against the run's allocation.
    Start {
        #[arg(long)]
        run: PathBuf,
        service: services::Service,
        /// Directory holding recount-ingestion-api and recount-normalizer; defaults to this
        /// executable's directory.
        #[arg(long, env = "RECOUNT_LOAD_BIN_DIR")]
        bin_dir: Option<PathBuf>,
    },
    /// Stop a started service with SIGTERM, or SIGKILL with --kill.
    Stop {
        #[arg(long)]
        run: PathBuf,
        service: services::Service,
        #[arg(long)]
        kill: bool,
    },
    /// Send a deterministic open-loop workload and record acknowledgements and freshness.
    Send {
        #[arg(long)]
        run: PathBuf,
        #[command(flatten)]
        args: send::SendArgs,
    },
    /// Sample service, container, Kafka and ClickHouse state until the deadline.
    Monitor {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        label: String,
        #[arg(long, default_value_t = 60)]
        seconds: u64,
        #[arg(long, default_value_t = 5)]
        interval: u64,
    },
    /// Wait until both consumer groups have no lag, recording the drain curve.
    Drain {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        label: String,
        #[arg(long, default_value_t = 600)]
        timeout: u64,
    },
    /// Pause or resume the ClickHouse Kafka consumer, or rewind its idle checkpoint.
    Consumer {
        #[arg(long)]
        run: PathBuf,
        #[command(subcommand)]
        action: clickhouse::ConsumerAction,
    },
    /// Revoke a synthetic node in the disposable authority database.
    Revoke {
        #[arg(long)]
        run: PathBuf,
        node: usize,
    },
    /// Compare stored rows with every acknowledged identity of the run.
    Verify {
        #[arg(long)]
        run: PathBuf,
        #[arg(long)]
        label: String,
        /// Seconds to wait for both groups to drain before comparing.
        #[arg(long, default_value_t = 120)]
        wait: u64,
    },
    /// Write signed tokens and node layout for the k6 gRPC script.
    K6Inputs {
        #[arg(long)]
        run: PathBuf,
    },
    /// Write the OTLP descriptor set that k6 loads with `loadProtoset`.
    Protoset {
        #[arg(long)]
        out: PathBuf,
    },
    /// Stop services and remove every resource the allocation created.
    Cleanup {
        #[arg(long)]
        run: PathBuf,
    },
    /// Tiny end-to-end regression with exact identity assertions, then cleanup.
    Check {
        #[arg(long, env = "RECOUNT_LOAD_BIN_DIR")]
        bin_dir: Option<PathBuf>,
        /// Run directory; a fresh temporary directory by default.
        #[arg(long)]
        run: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Prepare { run, args } => {
            let allocation = allocation::prepare(&run, args).await?;
            println!("{}", serde_json::to_string_pretty(&allocation.public())?);
        }
        Command::Start {
            run,
            service,
            bin_dir,
        } => services::start(&Allocation::load(&run)?, &run, service, bin_dir).await?,
        Command::Stop { run, service, kill } => services::stop(&run, service, kill).await?,
        Command::Send { run, args } => {
            let summary = send::run(&Allocation::load(&run)?, &run, args).await?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        Command::Monitor {
            run,
            label,
            seconds,
            interval,
        } => monitor::run(&Allocation::load(&run)?, &run, &label, seconds, interval).await?,
        Command::Drain {
            run,
            label,
            timeout,
        } => {
            let result = monitor::drain(&Allocation::load(&run)?, &run, &label, timeout).await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Consumer { run, action } => {
            let moved = clickhouse::consumer(&Allocation::load(&run)?, action).await?;
            if moved == Some(0) {
                return Err("rewind moved no records; nothing would be replayed".into());
            }
        }
        Command::Revoke { run, node } => {
            postgres::revoke(&Allocation::load(&run)?, node).await?;
        }
        Command::Verify { run, label, wait } => {
            let allocation = Allocation::load(&run)?;
            let report = verify::run(&allocation, &run, &label, wait).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.passed {
                return Err("verification failed".into());
            }
        }
        Command::K6Inputs { run } => workload::k6_inputs(&Allocation::load(&run)?, &run)?,
        Command::Protoset { out } => std::fs::write(out, opentelemetry_proto::DESCRIPTORS)?,
        Command::Cleanup { run } => allocation::cleanup(&Allocation::load(&run)?, &run).await?,
        Command::Check { bin_dir, run } => check::run(bin_dir, run).await?,
    }
    Ok(())
}
