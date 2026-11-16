use clap::{Args, Parser, Subcommand};
use recount_telemetry_schema::wire::{ExecutionMetadata, ExecutionParameter};
use recount_telemetry_validation::execution;
use std::{
    collections::BTreeMap, ffi::OsString, io, os::unix::process::CommandExt, process::Command,
};

#[derive(Parser)]
#[command(name = "recount", version, about = "Label and execute a command")]
struct Cli {
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Set execution labels and replace the launcher with the command.
    Run(Run),
}

#[derive(Args)]
struct Run {
    #[arg(long)]
    execution: String,
    #[arg(long)]
    name: Option<String>,
    #[arg(long = "version")]
    workload_version: Option<String>,
    #[arg(long = "param", value_name = "KEY=VALUE")]
    parameters: Vec<String>,
    #[arg(last = true, required = true)]
    command: Vec<OsString>,
}

pub fn main() {
    let Action::Run(options) = Cli::parse().action;
    let error = run(options);
    eprintln!("recount: {error}");
    std::process::exit(match error.kind() {
        io::ErrorKind::NotFound => 127,
        io::ErrorKind::PermissionDenied => 126,
        _ => 1,
    });
}

fn run(options: Run) -> io::Error {
    match prepare(options) {
        Ok(mut command) => command.exec(),
        Err(error) => error,
    }
}

fn prepare(options: Run) -> io::Result<Command> {
    execution::execution_key(&options.execution).map_err(io::Error::other)?;
    let mut parameters = BTreeMap::new();
    for parameter in &options.parameters {
        let (key, value) = parameter
            .split_once('=')
            .ok_or_else(|| io::Error::other("--param requires KEY=VALUE"))?;
        if parameters.insert(key, value).is_some() {
            return Err(io::Error::other("duplicate execution parameter"));
        }
    }
    execution::metadata(&ExecutionMetadata {
        name: options.name.clone(),
        workload_version: options.workload_version.clone(),
        parameters: parameters
            .iter()
            .map(|(key, value)| ExecutionParameter {
                key: (*key).into(),
                value: (*value).into(),
            })
            .collect(),
    })
    .map_err(io::Error::other)?;

    let mut command = Command::new(&options.command[0]);
    command.args(&options.command[1..]);
    command.env("RECOUNT_EXECUTION", options.execution);
    // A nested launch must not inherit metadata from its previous execution.
    for (variable, value) in [
        ("RECOUNT_EXECUTION_NAME", options.name),
        ("RECOUNT_EXECUTION_VERSION", options.workload_version),
    ] {
        command.env_remove(variable);
        if let Some(value) = value {
            command.env(variable, value);
        }
    }
    command.env(
        "RECOUNT_EXECUTION_PARAMETERS",
        serde_json::to_string(&parameters)?,
    );
    Ok(command)
}
