mod cgroup;
mod command;
mod process;
mod signals;

use clap::{Args, Parser, Subcommand};
use recount_execution_claims::{
    ExecutionMetadata, ExecutionParameter, Inbox, LocalExecutionClaim, LocalParticipantSubject,
    ProcessExit, process_exit::Outcome, validate_metadata,
};
use std::{
    ffi::OsString,
    io,
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[derive(Parser)]
#[command(
    name = "recount",
    version,
    about = "Launch Recount execution participants"
)]
struct Cli {
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Run a command as an execution participant, without a backend connection.
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
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("__recount_exec")) {
        command::exec_helper();
    }
    let Action::Run(options) = Cli::parse().action;
    match run(options) {
        Ok(status) => command::exit_like(status),
        Err(error) => {
            eprintln!("recount: {error}");
            std::process::exit(1);
        }
    }
}

fn now() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_nanos()).ok())
        .filter(|time| *time > 0)
        .ok_or_else(|| io::Error::other("invalid system clock"))
}

fn metadata(options: &Run) -> io::Result<ExecutionMetadata> {
    let mut parameters = options
        .parameters
        .iter()
        .map(|parameter| {
            let (key, value) = parameter
                .split_once('=')
                .ok_or_else(|| io::Error::other("--param requires KEY=VALUE"))?;
            Ok(ExecutionParameter {
                key: key.into(),
                value: value.into(),
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    parameters.sort_by(|left, right| left.key.cmp(&right.key));
    let metadata = ExecutionMetadata {
        name: options.name.clone(),
        workload_version: options.workload_version.clone(),
        parameters,
    };
    validate_metadata(&metadata)?;
    Ok(metadata)
}

fn run(options: Run) -> io::Result<std::process::ExitStatus> {
    let uid = nix::unistd::geteuid().as_raw();
    if nix::unistd::getuid().as_raw() != uid {
        return Err(io::Error::other("setuid launchers are not supported"));
    }
    let metadata = metadata(&options)?;
    let claim_directory = std::env::var_os("RECOUNT_CLAIM_DIRECTORY")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("RECOUNT_CLAIM_DIRECTORY is not configured"))?;
    let mut inbox = Inbox::open(claim_directory, uid)?;
    let id = Uuid::new_v4().to_string();
    let mut cgroup = match cgroup::DelegatedCgroup::create(&id, uid) {
        Ok(cgroup) => Some(cgroup),
        Err(error) => {
            eprintln!(
                "recount: cgroup unavailable ({error}); falling back to ancestry from the launched root; \
                 children that reparent between collector observations may remain unassociated"
            );
            None
        }
    };
    let mut child = command::GatedChild::spawn(&options.command)?;
    let initial = (|| {
        let root = process::verify(child.id(), uid)?;
        if let Some(cgroup) = &mut cgroup {
            cgroup.attach(child.id())?;
        }
        let start = now()?;
        let claim = LocalExecutionClaim {
            claim_id: id,
            revision: 1,
            execution_key: options.execution,
            boot_id: std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
                .trim_end_matches('\n')
                .to_owned(),
            subject: Some(LocalParticipantSubject {
                process: Some(root),
                dedicated_cgroup: cgroup.is_some(),
            }),
            owner_uid: uid,
            metadata: Some(metadata),
            first_seen_unix_nano: start,
            last_seen_unix_nano: start,
            ended_unix_nano: None,
            exit: None,
        };
        inbox.lock()?.write(&claim)?;
        Ok::<_, io::Error>(claim)
    })();
    let mut claim = initial?;
    if let Some(cgroup) = &mut cgroup {
        cgroup.retain_for_collector();
    }
    if let Err(error) = child.release() {
        eprintln!("recount: failed to release launched root: {error}");
    }
    let status = child.wait()?;
    let final_snapshot = (|| {
        let exit_time = now()?.max(claim.first_seen_unix_nano.saturating_add(1));
        let outcome = match status.code() {
            Some(code) => Outcome::Code(code as u32),
            None => Outcome::Signal(
                status
                    .signal()
                    .ok_or_else(|| io::Error::other("missing child wait outcome"))?
                    as u32,
            ),
        };
        claim.revision += 1;
        claim.ended_unix_nano = Some(exit_time);
        claim.exit = Some(ProcessExit {
            time_unix_nano: exit_time,
            outcome: Some(outcome),
        });
        // The local end describes only the root. A collector that already
        // observed its cgroup owns that cgroup's separate lifecycle closure.
        inbox.lock()?.write(&claim)
    })();
    if let Err(error) = final_snapshot {
        eprintln!("recount: FAILED to persist final execution claim: {error}");
    }
    Ok(status)
}
