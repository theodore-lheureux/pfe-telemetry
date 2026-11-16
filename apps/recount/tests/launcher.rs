#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::process::ExitStatusExt,
    process::{Command, Stdio},
};

fn launcher() -> Command {
    Command::new(env!("CARGO_BIN_EXE_recount"))
}

#[test]
fn exec_preserves_pid_streams_status_and_sets_only_explicit_metadata() {
    let mut child = launcher()
        .args([
            "run", "--execution", "slurm:48213", "--name", "Simulation", "--version", "1.2",
            "--param", "z=last=value", "--param", "a=", "--", "sh", "-c",
            r#"printf '%s\n' "$$" "$RECOUNT_EXECUTION" "$RECOUNT_EXECUTION_NAME" "$RECOUNT_EXECUTION_VERSION" "$RECOUNT_EXECUTION_PARAMETERS" "$UNRELATED_VARIABLE"; read value; printf 'input:%s\n' "$value"; printf 'workload-error\n' >&2; exit 37"#,
        ])
        .env("UNRELATED_VARIABLE", "retained")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    let pid = child.id();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    for expected in [
        pid.to_string(),
        "slurm:48213".into(),
        "Simulation".into(),
        "1.2".into(),
        r#"{"a":"","z":"last=value"}"#.into(),
        "retained".into(),
    ] {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim_end(), expected);
    }
    child.stdin.take().unwrap().write_all(b"hello\n").unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(line, "input:hello\n");
    let result = child.wait_with_output().unwrap();
    assert_eq!(result.status.code(), Some(37));
    assert_eq!(result.stderr, b"workload-error\n");
}

#[test]
fn nested_launch_clears_inherited_metadata() {
    let output = launcher()
        .args(["run", "--execution", "run:new", "--", "sh", "-c",
            r#"printf '%s\n' "$RECOUNT_EXECUTION" "${RECOUNT_EXECUTION_NAME-unset}" "${RECOUNT_EXECUTION_VERSION-unset}" "$RECOUNT_EXECUTION_PARAMETERS""#])
        .env("RECOUNT_EXECUTION", "run:old")
        .env("RECOUNT_EXECUTION_NAME", "old name")
        .env("RECOUNT_EXECUTION_VERSION", "old version")
        .env("RECOUNT_EXECUTION_PARAMETERS", r#"{"old":"value"}"#)
        .output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"run:new\nunset\nunset\n{}\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn invalid_inputs_never_execute() {
    for arguments in [
        vec!["--execution", "bad key"],
        vec!["--execution", "valid", "--param", "x=1", "--param", "x=2"],
        vec!["--execution", "valid", "--param", "not-a-pair"],
        vec!["--execution", "valid", "--param", "_bad=value"],
        vec!["--execution", "valid", "--name", " "],
        vec!["--execution", "valid", "--version", "bad\nversion"],
        vec!["--execution", "valid", "--param", "x=bad\nvalue"],
    ] {
        let output = launcher()
            .arg("run")
            .args(arguments)
            .args(["--", "sh", "-c", "printf executed"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn signals_and_exec_failures_pass_through() {
    let output = launcher()
        .args([
            "run",
            "--execution",
            "run:signal",
            "--",
            "sh",
            "-c",
            "kill -TERM $$",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.signal(), Some(15));
    let output = launcher()
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
}

#[test]
fn directed_kill_targets_the_command_without_a_forwarding_parent() {
    let mut child = launcher()
        .args([
            "run",
            "--execution",
            "run:directed",
            "--",
            "sh",
            "-c",
            "printf 'ready\\n'; exec sleep 60",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(ready, "ready\n");
    child.kill().unwrap();
    assert_eq!(child.wait().unwrap().signal(), Some(9));
}

#[test]
fn byte_and_parameter_count_limits_fail_before_exec() {
    let too_many: Vec<String> = (0..33)
        .flat_map(|i| ["--param".into(), format!("key{i}=value")])
        .collect();
    for arguments in [
        vec!["--execution".into(), "x".repeat(129)],
        vec![
            "--execution".into(),
            "valid".into(),
            "--name".into(),
            "é".repeat(65),
        ],
        vec![
            "--execution".into(),
            "valid".into(),
            "--version".into(),
            "x".repeat(257),
        ],
        vec![
            "--execution".into(),
            "valid".into(),
            "--param".into(),
            format!("key={}", "x".repeat(1025)),
        ],
        [vec!["--execution".into(), "valid".into()], too_many].concat(),
    ] {
        let output = launcher()
            .arg("run")
            .args(arguments)
            .args(["--", "sh", "-c", "printf executed"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
