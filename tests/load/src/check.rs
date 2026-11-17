use crate::{
    Result,
    allocation::{self, Allocation, PrepareArgs, unix_nanos},
    clickhouse::{self, ConsumerAction},
    kafka, postgres,
    send::{self, SendArgs},
    services::{self, Service},
    verify,
    workload::Shape,
};
use std::{path::PathBuf, time::Duration};

fn args(label: &str, rate: f64, seconds: f64) -> SendArgs {
    SendArgs {
        label: label.into(),
        rate,
        seconds,
        nodes: None,
        only_node: None,
        shape: Shape {
            metrics: 2,
            processes: 2,
            points: 3,
            attributes: 2,
            series: 2,
            padding: 0,
            foreign_resource: false,
        },
        connections: 2,
        max_outstanding: 64,
        max_attempts: 6,
        timeout_ms: 10_000,
        resend_every: 0,
        resend_delay_ms: 0,
        probe_interval_ms: 0,
        monitor_interval: 5,
        gzip: false,
        address: None,
    }
}

async fn verified(
    allocation: &Allocation,
    run: &std::path::Path,
    label: &str,
) -> Result<verify::Report> {
    let report = verify::run(allocation, run, label, 120).await?;
    eprintln!(
        "check_verify label={label} expected={} final={} physical={} inserted={} ambiguous_present={} rejected={}",
        report.expected_samples,
        report.final_rows,
        report.physical_rows,
        report.inserted_rows,
        report.ambiguous_present,
        report.rejected_batches
    );
    if !report.passed {
        return Err(format!("{label}: {:?}", report.failures).into());
    }
    Ok(report)
}

async fn scenario(
    allocation: &Allocation,
    run: &std::path::Path,
    bin_dir: Option<PathBuf>,
) -> Result<()> {
    services::start(allocation, run, Service::IngestionApi, bin_dir.clone()).await?;
    services::start(allocation, run, Service::Normalizer, bin_dir.clone()).await?;

    let mut base = args("base", 20.0, 1.5);
    base.resend_every = 3;
    base.resend_delay_ms = 3000;
    base.probe_interval_ms = 400;
    let summary = send::run(allocation, run, base).await?;
    if summary.outcomes.get("acked") != Some(&summary.offered_batches) {
        return Err(format!(
            "baseline batches were not all acknowledged: {:?}",
            summary.outcomes
        )
        .into());
    }
    let report = verified(allocation, run, "base").await?;
    if report.expected_samples == 0 || report.acked_batches < 30 {
        return Err("baseline produced no expected identities".into());
    }
    // Whether copies stay physical depends on insert-block timing; that they were published
    // again and still count once does not.
    if report.normalized_records <= report.expected_samples {
        return Err("acknowledged resends did not reach the normalized log".into());
    }

    services::stop(run, Service::Normalizer, true).await?;
    let summary = send::run(allocation, run, args("outage", 10.0, 1.0)).await?;
    if summary.outcomes.get("acked") != Some(&summary.offered_batches) {
        return Err("ingestion did not accept while the normalizer was stopped".into());
    }
    let raw = kafka::lag(
        allocation,
        &allocation.raw_topic,
        &allocation.normalizer_group,
    )?;
    if raw.lag == 0 {
        return Err("killed normalizer left no raw backlog".into());
    }
    services::start(allocation, run, Service::Normalizer, bin_dir).await?;
    let before = verified(allocation, run, "outage").await?;

    clickhouse::consumer(allocation, ConsumerAction::Pause).await?;
    let moved = clickhouse::consumer(allocation, ConsumerAction::Rewind { records: 5 }).await?;
    clickhouse::consumer(allocation, ConsumerAction::Resume).await?;
    if moved.unwrap_or_default() == 0 {
        return Err("rewind moved no records; the replay step would pass vacuously".into());
    }
    let report = verified(allocation, run, "replay").await?;
    if report.inserted_rows <= before.inserted_rows {
        return Err("rewound records were not inserted again".into());
    }

    postgres::revoke(allocation, 1).await?;
    let revoked = unix_nanos();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut attempt = 0;
    loop {
        let mut probe = args(&format!("revoked-{attempt}"), 1.0, 1.0);
        probe.only_node = Some(1);
        probe.max_attempts = 1;
        let summary = send::run(allocation, run, probe).await?;
        if summary.codes.contains_key("Unauthenticated") {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            return Err("revoked node was still accepted after 45 s".into());
        }
        attempt += 1;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    eprintln!(
        "check_revocation_seconds={:.1}",
        (unix_nanos() - revoked) as f64 / 1e9
    );
    let report = verified(allocation, run, "final").await?;
    if report.rejected_batches == 0 {
        return Err("revoked batch was not recorded as rejected".into());
    }
    Ok(())
}

pub async fn run(bin_dir: Option<PathBuf>, run: Option<PathBuf>) -> Result<()> {
    let run = run.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("recount-load-check-{}", unix_nanos()))
    });
    // Only resources this invocation creates may be removed on failure.
    if run.join("allocation.json").exists() {
        return Err(format!("{} already holds an allocation", run.display()).into());
    }
    let prepared = allocation::prepare(
        &run,
        PrepareArgs {
            projects: 2,
            direct_nodes: 2,
            linux_nodes: 2,
            raw_partitions: 3,
            normalized_partitions: 3,
            retention_bytes: 134_217_728,
            ingestion_max_in_flight: 4,
            normalizer_max_active: 2,
        },
    )
    .await;
    let allocation = match prepared {
        Ok(allocation) => allocation,
        Err(error) => {
            // The guard above makes any allocation here this invocation's partial one.
            if let Ok(partial) = Allocation::load(&run) {
                let _ = allocation::cleanup(&partial, &run).await;
            }
            return Err(error);
        }
    };
    let result = scenario(&allocation, &run, bin_dir).await;
    let cleaned = allocation::cleanup(&allocation, &run).await;
    match (result, cleaned) {
        (Ok(()), Ok(())) => {
            eprintln!("check_passed run={}", run.display());
            Ok(())
        }
        (Err(error), _) => Err(format!("{error}; logs in {}", run.display()).into()),
        (Ok(()), Err(error)) => Err(error),
    }
}
