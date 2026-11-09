#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn declaration_validation_needs_no_backends_and_preserves_cli_precedence() {
    for args in [
        vec!["validate"],
        vec!["--max-points", "1", "validate"],
        vec![
            "--max-request-bytes",
            "7000000",
            "--raw-broker-max-bytes",
            "7065536",
            "--normalized-max-record-bytes",
            "2000000",
            "--normalized-broker-max-bytes",
            "2065536",
            "validate",
        ],
        vec!["--max-points", "23", "validate"],
        vec![
            "--max-request-bytes",
            "999934464",
            "--raw-broker-max-bytes",
            "1000000000",
            "--normalized-max-record-bytes",
            "999934464",
            "--normalized-max-output-bytes",
            "999934464",
            "--normalized-broker-max-bytes",
            "1000000000",
            "validate",
        ],
    ] {
        let mut process = Process(
            Command::new(env!("CARGO_BIN_EXE_recount-normalizer"))
                .env_clear()
                .env("RECOUNT_KAFKA_BOOTSTRAP", "unresolvable.invalid:9092")
                .envs(if args.contains(&"--max-points") {
                    vec![("RECOUNT_MAX_POINTS", "0")]
                } else {
                    vec![]
                })
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "offline validation entered startup"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let mut output = String::new();
        let mut errors = String::new();
        process
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        process
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut errors)
            .unwrap();
        assert!(status.success(), "{errors}");
        assert!(output.contains("declarations only"));
        assert!(errors.is_empty());
    }
}

#[test]
fn invalid_configuration_exits_with_clap_error_before_runtime_startup() {
    for (value, diagnostic) in [
        ("0", "invalid value '0' for '--max-request-bytes"),
        ("8388608", "broker capacity plus 64 KiB framing reserve"),
    ] {
        let mut process = Process(
            Command::new(env!("CARGO_BIN_EXE_recount-normalizer"))
                .env_clear()
                .env("RECOUNT_MAX_REQUEST_BYTES", value)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = process.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "invalid configuration entered runtime startup"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let mut output = String::new();
        process
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        process
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(status.code(), Some(2), "{output}");
        assert!(
            output.contains(diagnostic),
            "wrong configuration failure: {output}"
        );
        assert!(
            !output.contains("state=starting") && !output.contains("state=ready"),
            "{output}"
        );
    }
}

#[test]
fn metadata_outage_never_becomes_ready_and_exits_nonzero_within_budget() {
    let mut process = Process(
        Command::new(env!("CARGO_BIN_EXE_recount-normalizer"))
            .env_clear()
            .env("RECOUNT_KAFKA_BOOTSTRAP", "127.0.0.1:1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stderr = process.0.stderr.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if send.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut output = String::new();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !output.contains("state=starting") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = receive
            .recv_timeout(remaining)
            .unwrap_or_else(|error| panic!("metadata outage not reported: {error}; {output}"));
        output.push_str(&line);
        output.push('\n');
    }
    assert!(
        Command::new("sh")
            .args([
                "-c",
                "kill -TERM \"$1\"",
                "recount-normalizer-signal",
                &process.0.id().to_string(),
            ])
            .status()
            .unwrap()
            .success()
    );
    let deadline = Instant::now() + Duration::from_secs(4);
    let status = loop {
        if let Some(status) = process.0.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "SIGTERM did not drain in 4s");
        thread::sleep(Duration::from_millis(20));
    };
    reader.join().unwrap();
    for line in receive {
        output.push_str(&line);
        output.push('\n');
    }
    assert_eq!(status.code(), Some(1), "{status}: {output}");
    assert!(output.contains("state=fatal"), "{output}");
    assert!(!output.contains("state=ready"), "{output}");
}
