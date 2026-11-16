#![cfg(target_os = "linux")]

use nix::{
    sys::{
        signal::{Signal, kill},
        wait::{Id, WaitPidFlag, WaitStatus, waitid},
    },
    unistd::Pid,
};
use recount_execution_claims::{Inbox, LocalExecutionClaim, process_exit::Outcome};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

struct Fixture {
    temporary: TempDir,
    directory: PathBuf,
    uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let uid = nix::unistd::geteuid().as_raw();
        let directory = temporary.path().join(uid.to_string());
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            temporary,
            directory,
            uid,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_recount"));
        command
            .env("RECOUNT_CLAIM_DIRECTORY", self.temporary.path())
            .env("RECOUNT_CGROUP_SUBTREE", "/recount-launcher-unavailable");
        command
    }

    fn claims(&self) -> Vec<LocalExecutionClaim> {
        let mut inbox = Inbox::open(self.temporary.path(), self.uid).unwrap();
        let locked = inbox.lock().unwrap();
        locked
            .enumerate()
            .unwrap()
            .iter()
            .map(|id| locked.read(id).unwrap())
            .collect()
    }

    fn interactive(&self, script: &str) -> (Child, BufReader<std::process::ChildStdout>) {
        let mut child = self
            .command()
            .args([
                "run",
                "--execution",
                "run:interactive",
                "--",
                "sh",
                "-c",
                script,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        if line != "ready\n" {
            let result = child.wait_with_output().unwrap();
            panic!(
                "launcher exited before ready: {:?}: {}",
                result.status,
                String::from_utf8_lossy(&result.stderr)
            );
        }
        (child, output)
    }
}

#[test]
fn gate_persists_original_identity_before_exec_and_preserves_streams_metadata_and_status() {
    let fixture = Fixture::new();
    let mut child = fixture.command().args([
        "run", "--execution", "slurm:48213", "--name", "Simulation", "--version", "1.2",
        "--param", "z=last=value", "--param", "a=", "--", "sh", "-c",
        "printf 'ready\\n'; read value; printf 'input:%s\\n' \"$value\"; printf 'workload-error\\n' >&2; exit 37",
    ]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    if ready != "ready\n" {
        let result = child.wait_with_output().unwrap();
        panic!(
            "launcher exited before ready: {:?}: {}",
            result.status,
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let initial = fixture.claims().pop().unwrap();
    assert_eq!(initial.revision, 1);
    assert!(initial.exit.is_none());
    assert!(initial.ended_unix_nano.is_none());
    let subject = initial.subject.as_ref().unwrap();
    assert!(!subject.dedicated_cgroup);
    let root = subject.process.unwrap();
    let stat = fs::read_to_string(format!("/proc/{}/stat", root.pid)).unwrap();
    let ticks: u64 = stat
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(ticks, root.start_time_ticks);
    let metadata = initial.metadata.as_ref().unwrap();
    assert_eq!(metadata.parameters[0].key, "a");
    assert_eq!(metadata.parameters[0].value, "");
    assert_eq!(metadata.parameters[1].value, "last=value");
    assert_eq!(metadata.name.as_deref(), Some("Simulation"));
    assert_eq!(metadata.workload_version.as_deref(), Some("1.2"));
    child.stdin.take().unwrap().write_all(b"hello\n").unwrap();
    let mut rest = String::new();
    output.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "input:hello\n");
    let result = child.wait_with_output().unwrap();
    assert_eq!(result.status.code(), Some(37));
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.contains("falling back to ancestry"));
    assert!(stderr.ends_with("workload-error\n"));
    let terminal = fixture.claims().pop().unwrap();
    assert_eq!(terminal.claim_id, initial.claim_id);
    assert_eq!(terminal.subject, initial.subject);
    assert_eq!(terminal.first_seen_unix_nano, initial.first_seen_unix_nano);
    assert_eq!(terminal.revision, 2);
    assert_eq!(terminal.exit.unwrap().outcome, Some(Outcome::Code(37)));
    assert_eq!(terminal.last_seen_unix_nano, initial.last_seen_unix_nano);
    assert_eq!(
        terminal.ended_unix_nano,
        Some(terminal.exit.unwrap().time_unix_nano)
    );
    assert!(terminal.ended_unix_nano.unwrap() > terminal.last_seen_unix_nano);
}

#[test]
fn initial_persistence_failure_never_executes_the_command() {
    let fixture = Fixture::new();
    let marker = fixture.temporary.path().join("must-not-exist");
    fs::write(fixture.directory.join("unexpected"), b"invalid entry").unwrap();
    let output = fixture
        .command()
        .args(["run", "--execution", "run:fail", "--", "touch"])
        .arg(&marker)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!marker.exists());
    assert!(fixture.directory.read_dir().unwrap().all(|entry| {
        !entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "pb")
    }));
}

#[test]
fn scheduler_environment_expansion_and_invalid_metadata_are_not_inferred() {
    let fixture = Fixture::new();
    let output = Command::new("sh")
        .arg("-c")
        .arg("exec \"$1\" run --execution \"slurm:$SLURM_JOB_ID\" -- true")
        .arg("sh")
        .arg(env!("CARGO_BIN_EXE_recount"))
        .env("SLURM_JOB_ID", "901")
        .env("SECRET_WORKLOAD_PARAMETER", "not metadata")
        .env("RECOUNT_CLAIM_DIRECTORY", fixture.temporary.path())
        .env_remove("RECOUNT_CGROUP_SUBTREE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let claim = fixture.claims().pop().unwrap();
    assert_eq!(claim.execution_key, "slurm:901");
    let metadata = claim.metadata.unwrap();
    assert!(metadata.name.is_none());
    assert!(metadata.workload_version.is_none());
    assert!(metadata.parameters.is_empty());
    for arguments in [
        vec!["--execution", "bad key"],
        vec!["--execution", "valid", "--param", "x=1", "--param", "x=2"],
        vec!["--execution", "valid", "--param", "not-a-pair"],
    ] {
        let output = fixture
            .command()
            .arg("run")
            .args(arguments)
            .args(["--", "true"])
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
    assert_eq!(fixture.claims().len(), 1);
}

#[test]
fn directed_signals_reach_root_and_launcher_has_the_same_wait_signal() {
    let fixture = Fixture::new();
    for number in [Signal::SIGTERM as i32, 35] {
        let (mut child, _) = fixture.interactive("printf 'ready\\n'; exec sleep 60");
        assert!(
            Command::new("sh")
                .args([
                    "-c",
                    "kill -\"$1\" \"$2\"",
                    "sh",
                    &number.to_string(),
                    &child.id().to_string(),
                ])
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(child.wait().unwrap().signal(), Some(number));
        assert!(
            fixture
                .claims()
                .iter()
                .any(|claim| claim.exit.unwrap().outcome == Some(Outcome::Signal(number as u32)))
        );
    }
}

#[test]
fn root_signal_and_exec_failure_are_retained() {
    let fixture = Fixture::new();
    for signal in [
        Signal::SIGUSR1 as i32,
        Signal::SIGPIPE as i32,
        Signal::SIGKILL as i32,
        35,
    ] {
        let output = fixture
            .command()
            .args([
                "run",
                "--execution",
                "run:signal",
                "--",
                "sh",
                "-c",
                &format!("kill -{signal} $$"),
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.signal(), Some(signal));
    }
    let output = fixture
        .command()
        .args([
            "run",
            "--execution",
            "run:missing",
            "--",
            "/does/not/exist/recount-command",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(127));
    let claims = fixture.claims();
    assert!(
        claims
            .iter()
            .any(|claim| claim.exit.unwrap().outcome
                == Some(Outcome::Signal(Signal::SIGUSR1 as u32)))
    );
    assert!(
        claims
            .iter()
            .any(|claim| claim.exit.unwrap().outcome == Some(Outcome::Code(127)))
    );
}

#[test]
fn final_persistence_failure_is_explicit_without_changing_child_status() {
    let fixture = Fixture::new();
    let (mut child, _) = fixture.interactive("printf 'ready\\n'; read value; exit 23");
    let initial = fixture.claims().pop().unwrap();
    let path = fixture.directory.join(format!("{}.pb", initial.claim_id));
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    child.stdin.take().unwrap().write_all(b"done\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(23));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("FAILED to persist final execution claim")
    );
}

fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
fn root_exit_before_gate_release_is_still_terminal_and_preserves_its_signal() {
    let fixture = Fixture::new();
    let mut inbox = Inbox::open(fixture.temporary.path(), fixture.uid).unwrap();
    let lock = inbox.lock().unwrap();
    let marker = fixture.temporary.path().join("must-not-execute");
    let mut launcher = fixture
        .command()
        .args(["run", "--execution", "run:early-exit", "--", "touch"])
        .arg(&marker)
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut root = None;
    let found = wait_until(|| {
        root = fs::read_to_string(format!("/proc/{0}/task/{0}/children", launcher.id()))
            .ok()
            .and_then(|children| children.split_whitespace().next()?.parse::<i32>().ok());
        root.is_some()
    });
    if !found {
        launcher.kill().unwrap();
        launcher.wait().unwrap();
        panic!("launcher did not create its gated root");
    }
    let root = root.unwrap();
    kill(Pid::from_raw(root), Signal::SIGTERM).unwrap();
    let exited = wait_until(|| {
        fs::read_to_string(format!("/proc/{root}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, fields)| fields.starts_with("Z "))
        })
    });
    drop(lock);
    assert!(exited, "gated root did not exit");
    let result = launcher.wait_with_output().unwrap();
    assert_eq!(result.status.signal(), Some(Signal::SIGTERM as i32));
    let claim = fixture.claims().pop().unwrap();
    assert_eq!(claim.revision, 2);
    assert_eq!(
        claim.exit.unwrap().outcome,
        Some(Outcome::Signal(Signal::SIGTERM as u32))
    );
    assert!(!marker.exists());
}

#[test]
fn child_initiated_stop_stops_launcher_and_directed_continue_resumes_both() {
    let fixture = Fixture::new();
    let (mut launcher, _) = fixture.interactive("printf 'ready\\n'; kill -STOP $$; exit 19");
    let root = fixture
        .claims()
        .pop()
        .unwrap()
        .subject
        .unwrap()
        .process
        .unwrap()
        .pid;
    let stopped = wait_until(|| {
        matches!(
            waitid(
                Id::Pid(Pid::from_raw(launcher.id() as i32)),
                WaitPidFlag::WSTOPPED | WaitPidFlag::WNOHANG
            ),
            Ok(WaitStatus::Stopped(_, Signal::SIGSTOP))
        )
    });
    if !stopped {
        let _ = kill(Pid::from_raw(root as i32), Signal::SIGKILL);
        let _ = launcher.kill();
        let _ = launcher.wait();
        panic!("launcher did not follow its root's job-control stop");
    }
    kill(Pid::from_raw(launcher.id() as i32), Signal::SIGCONT).unwrap();
    assert_eq!(launcher.wait().unwrap().code(), Some(19));
    assert_eq!(
        fixture.claims().pop().unwrap().exit.unwrap().outcome,
        Some(Outcome::Code(19))
    );
}

#[test]
#[ignore = "requires an explicitly provisioned writable cgroup v2 delegation"]
fn delegated_cgroup_placement_is_persisted_before_workload_and_root_exit_is_not_group_end() {
    let fixture = Fixture::new();
    let subtree =
        std::env::var("RECOUNT_TEST_CGROUP_SUBTREE").expect("provision a test delegation");
    let output = fixture
        .command()
        .env("RECOUNT_CGROUP_SUBTREE", &subtree)
        .args([
            "run",
            "--execution",
            "run:cgroup",
            "--",
            "cat",
            "/proc/self/cgroup",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let claim = fixture.claims().pop().unwrap();
    assert!(
        claim.subject.unwrap().dedicated_cgroup,
        "must not fall back to ancestry"
    );
    let expected_path = format!(
        "{}/recount-{}",
        subtree.trim_end_matches('/'),
        claim.claim_id
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("0::{expected_path}")
    );
    assert!(claim.exit.is_some());
    assert_eq!(
        claim.ended_unix_nano,
        Some(claim.exit.unwrap().time_unix_nano)
    );
}
