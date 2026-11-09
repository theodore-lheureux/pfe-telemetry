use std::{
    io::Read,
    process::{Child, Command, Stdio},
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

fn run(args: &[&str], env: &[(&str, &str)]) -> (i32, String, String) {
    let mut process = Process(
        Command::new(env!("CARGO_BIN_EXE_recount-ingestion-api"))
            .env_clear()
            .envs(env.iter().copied())
            .args(args)
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
            "offline validation entered startup"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let mut out = String::new();
    let mut err = String::new();
    process
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    process
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    (status.code().unwrap(), out, err)
}

#[test]
fn declarations_need_no_credentials_network_or_listening_socket() {
    for args in [
        vec!["validate"],
        vec![
            "--max-request-bytes",
            "7000000",
            "--raw-broker-max-bytes",
            "7065536",
            "validate",
        ],
        vec![
            "--max-request-bytes",
            "999934464",
            "--raw-broker-max-bytes",
            "1000000000",
            "validate",
        ],
    ] {
        let (status, out, err) = run(
            &args,
            &[
                ("RECOUNT_INGESTION_ADDR", "203.0.113.1:1"),
                ("RECOUNT_KAFKA_BOOTSTRAP", "unresolvable.invalid:9092"),
            ],
        );
        assert_eq!(status, 0, "{err}");
        assert!(out.contains("declarations only"));
        assert!(err.is_empty());
    }
    assert_eq!(run(&[], &[]).0, 2);
}

#[test]
fn overrides_and_fail_closed_diagnostics_do_not_disclose_credentials() {
    let secret = "postgresql://owner:synthetic-secret@unresolvable.invalid/db";
    let env = [("RECOUNT_INGESTION_DATABASE_URL", secret)];
    assert_eq!(
        run(
            &["--max-points", "19", "validate"],
            &[
                ("RECOUNT_INGESTION_DATABASE_URL", secret),
                ("RECOUNT_MAX_POINTS", "0"),
            ]
        )
        .0,
        0
    );
    let (_, out, err) = run(&["--help"], &env);
    assert!(!out.contains(secret) && !err.contains(secret));
    for args in [
        vec!["--max-points", "0", "validate"],
        vec!["--max-request-bytes", "0", "validate"],
        vec!["--raw-broker-max-bytes", "4259839", "validate"],
        vec!["--normalized-max-output-bytes", "1048575", "validate"],
        vec!["--kafka-bootstrap", " ", "validate"],
    ] {
        let (status, out, err) = run(&args, &env);
        assert_eq!(status, 2, "{err}");
        assert!(!out.contains("configuration valid"));
        assert!(!out.contains(secret) && !err.contains(secret));
    }
}
