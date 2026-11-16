use super::*;

#[test]
fn configured_host_and_namespace_reject_control_characters() {
    for control in ['\n', '\t', '\0', '\u{0085}'] {
        for host_invalid in [true, false] {
            let invalid = format!("test{control}identity");
            let error = Collector::new(
                CollectorConfig {
                    interval: Duration::from_secs(1),
                    host_id: Some(if host_invalid {
                        invalid.clone()
                    } else {
                        "test-host".into()
                    }),
                    namespace_id: Some(if host_invalid {
                        "test-namespace".into()
                    } else {
                        invalid
                    }),
                    host_visibility: false,
                },
                LossTracker::default(),
            )
            .err()
            .expect("Control characters must be rejected");
            assert!(error.to_string().contains("without control characters"));
        }
    }
}

#[test]
fn sampled_resources_obey_shared_identity_catalogue_and_window_contracts() {
    let mut collector = Collector::new(
        CollectorConfig {
            interval: Duration::from_secs(1),
            host_id: Some("test-host".into()),
            namespace_id: Some("test-namespace".into()),
            host_visibility: false,
        },
        LossTracker::default(),
    )
    .unwrap();
    let contents = collector
        .sample()
        .unwrap()
        .expect("Stable sampling clock")
        .into_contents();
    let window_names = contents
        .window
        .scope_metrics
        .iter()
        .flat_map(|s| &s.metrics)
        .map(|m| m.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        window_names,
        [catalogue::SCAN_DURATION.name, catalogue::CLOCK_STATUS.name]
    );
    let mut saw_self = false;
    let mut saw_cpu = false;
    for resource in contents
        .measurements
        .iter()
        .chain([&contents.window, &contents.diagnostics])
    {
        let identity =
            adapter::resource_identity(&resource.resource.as_ref().unwrap().attributes).unwrap();
        assert_eq!(identity.host, "test-host");
        if let Some(process) = identity.process {
            assert_eq!(process.namespace, "test-namespace");
            saw_self |= process.pid == u64::from(std::process::id());
        }
        for metric in resource.scope_metrics.iter().flat_map(|s| &s.metrics) {
            catalogue::validate_adapter_metric(metric, catalogue::Adapter::Linux).unwrap();
            assert_ne!(metric.name, catalogue::CLOCK_UNCERTAINTY.name);
            saw_cpu |= metric.name == catalogue::NODE_CPU_TIME.name;
        }
    }
    assert!(saw_self && saw_cpu);
}
