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
    tracing::dispatcher::with_default(&logs.subscriber(), || {
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
    let reads: Vec<usize> = log
        .split_whitespace()
        .filter_map(|field| field.strip_prefix("environment_reads="))
        .map(|value| value.parse().unwrap())
        .collect();
    assert_eq!(reads.len(), 2, "{log}");
    assert!(
        reads[0] > 0 && reads[0] <= fixture.settings.max_processes,
        "{log}"
    );
    assert_eq!(reads[1], 0, "{log}");
    assert!(log.contains("scan_micros="), "{log}");
}
