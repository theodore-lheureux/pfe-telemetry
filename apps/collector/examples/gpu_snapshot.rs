#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use opentelemetry_proto::tonic::metrics::v1::{metric::Data, number_data_point::Value};
    use recount_collector::{Collector, CollectorConfig, LossTracker};
    use recount_telemetry_validation::linux_adapter;
    use std::{thread, time::Duration};

    let mut collector = Collector::new(
        CollectorConfig {
            interval: Duration::from_secs(1),
            host_id: Some("gpu-validation".into()),
            namespace_id: Some("host".into()),
            host_visibility: true,
            tcp_rtt: false,
        },
        LossTracker::default(),
    )?;
    for _ in 0..15 {
        thread::sleep(Duration::from_secs(1));
        let Some(scan) = collector.sample()? else {
            continue;
        };
        for resource in scan.into_contents().measurements {
            let attrs = resource.resource.as_ref().unwrap().attributes.as_slice();
            let identity = linux_adapter::resource_identity(attrs)?;
            let process = identity.process.as_ref().map(|process| {
                serde_json::json!({
                    "pid": process.pid, "start_ticks": process.start_ticks.to_string(),
                    "incarnation": process.incarnation(),
                })
            });
            for scope in &resource.scope_metrics {
                let Some(scope_info) = &scope.scope else {
                    continue;
                };
                if scope_info.name == "recount.collector.procfs" && process.is_some() {
                    println!(
                        "{}",
                        serde_json::json!({
                            "scope": scope_info.name, "process": process, "identity_only": true,
                        })
                    );
                }
                if !matches!(
                    scope_info.name.as_str(),
                    "recount.collector.nvml" | "recount.collector.dcgm"
                ) {
                    continue;
                }
                for metric in &scope.metrics {
                    let Some(Data::Gauge(gauge)) = &metric.data else {
                        continue;
                    };
                    for point in &gauge.data_points {
                        let (kind, value) = match point.value {
                            Some(Value::AsInt(value)) => ("int64", value.to_string()),
                            Some(Value::AsDouble(value)) => ("double", value.to_string()),
                            None => ("unavailable", String::new()),
                        };
                        let dimensions: Vec<_> = point
                            .attributes
                            .iter()
                            .map(|attribute| {
                                (attribute.key.clone(), format!("{:?}", attribute.value))
                            })
                            .collect();
                        println!(
                            "{}",
                            serde_json::json!({
                                "scope": scope_info.name, "process": process, "gpu_uuid": identity.gpu,
                                "metric": metric.name, "unit": metric.unit,
                                "time_ns": point.time_unix_nano.to_string(),
                                "value_type": kind, "value": value, "dimensions": dimensions,
                            })
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("GPU snapshot validation requires an initial-host-PID Linux environment");
    std::process::exit(1);
}
