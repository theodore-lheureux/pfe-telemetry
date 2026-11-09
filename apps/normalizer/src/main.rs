use clap::Parser;
use recount_normalizer::{
    config::{Cli, Command},
    kafka, runtime as normalizer,
};

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let cli = Cli::parse();
    let command = cli.command;
    let config = cli.into_config().unwrap_or_else(|error| error.exit());
    if command == Some(Command::Validate) {
        println!("configuration valid (declarations only; broker state not checked)");
        return;
    }
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
    let result = runtime.block_on(async {
        match command {
            None => normalizer::run(config).await,
            Some(Command::Bootstrap) => kafka::bootstrap(config).await,
            Some(Command::Validate) => unreachable!(),
        }
    });
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    if let Err(reason) = result {
        eprintln!("state=fatal reason={reason}");
        std::process::exit(1);
    }
}
