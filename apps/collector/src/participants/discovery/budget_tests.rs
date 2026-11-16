use super::*;
use crate::participants::test_support::*;

#[test]
fn bounded_scan_cost_and_cached_environment_reads_are_measured() {
    let mut fixture = Fixture::new();
    fixture.settings.max_processes = 128;
    let mut bytes = b"RECOUNT_EXECUTION=run:bounded\0PRIVATE=".to_vec();
    bytes.resize(65_535, b'x');
    bytes.push(0);
    for pid in 100..612 {
        fixture.process(pid, 1, &bytes);
    }
    let mut discovery = Discovery::new(&fixture.scope, fixture.settings.clone(), &[]).unwrap();
    discovery.root = fixture.proc_root();
    let logs = Logs::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_ansi(false)
        .with_writer(logs.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        let started = Instant::now();
        let first = discovery.scan().unwrap();
        let cold = started.elapsed();
        let started = Instant::now();
        let next = discovery.scan().unwrap();
        let cached = started.elapsed();
        assert_eq!(first.processes.len(), 128);
        assert_eq!(next.processes.len(), 128);
        eprintln!(
            "512 processes, 128-entry scan/cache cap, 64-KiB environments: cold={cold:?}, cached={cached:?}"
        );
    });
    let log = logs.0.lock().unwrap();
    let log = String::from_utf8_lossy(&log);
    assert!(log.contains("environment_reads=128"));
    assert!(log.contains("environment_reads=0"));
    assert!(log.contains("scan_micros="));
}
