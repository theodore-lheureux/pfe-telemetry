use clap::Parser;
use recount_normalizer::{
    config::{Cli, Command},
    retention, runtime as normalizer,
};
use tracing_subscriber::{filter::LevelFilter, prelude::*};

fn main() {
    let cli = Cli::parse();
    let command = cli.command;
    let config = cli.into_config().unwrap_or_else(|error| error.exit());
    if command == Some(Command::Validate) {
        println!("configuration valid (declarations only; broker state not checked)");
        return;
    }
    let metrics =
        retention::RetentionMetrics::new(config.group.clone(), config.metrics_file.clone())
            .unwrap_or_else(|reason| {
                eprintln!("state=fatal reason=retention_metrics_initialization error={reason}");
                std::process::exit(1);
            });
    tracing_subscriber::registry()
        .with(LevelFilter::INFO)
        .with(metrics)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(false),
        )
        .init();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("state=fatal reason=runtime_initialization");
            std::process::exit(1);
        }
    };
    let result = runtime.block_on(normalizer::run(config));
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    if let Err(reason) = result {
        eprintln!("state=fatal reason={reason}");
        std::process::exit(1);
    }
}
