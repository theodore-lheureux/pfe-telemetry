use super::{Context, Reading};
use crate::{
    diagnostics::ReadStatus,
    metrics::{gauge, integer, point, resource as measured_resource, string},
};
use opentelemetry_proto::tonic::{
    common::v1::InstrumentationScope,
    metrics::v1::{
        Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, number_data_point::Value,
    },
};
use recount_telemetry_validation::{catalogue, linux_adapter as adapter};
use std::{collections::BTreeMap, time::Duration};

pub(crate) fn context(resources: &[ResourceMetrics], enabled: bool) -> Context {
    let identities = if enabled {
        resources
            .iter()
            .filter_map(|resource| {
                let identity =
                    adapter::resource_identity(&resource.resource.as_ref()?.attributes).ok()?;
                let process = identity.process?;
                Some((i32::try_from(process.pid).ok()?, process.start_ticks))
            })
            .collect()
    } else {
        BTreeMap::new()
    };
    Context {
        identities,
        enabled,
    }
}

pub(in crate::gpu) fn attach(
    resources: &[ResourceMetrics],
    readings: Vec<Reading>,
    now: u64,
    interval: Duration,
) -> Vec<ResourceMetrics> {
    if readings.is_empty() {
        return vec![];
    }
    let mut by_identity: BTreeMap<(i32, u64), Vec<Reading>> = BTreeMap::new();
    for reading in readings {
        by_identity
            .entry((reading.pid, reading.ticks))
            .or_default()
            .push(reading);
    }
    let mut measured = vec![];
    for resource in resources {
        let identity = resource
            .resource
            .as_ref()
            .and_then(|resource| adapter::resource_identity(&resource.attributes).ok());
        let Some(process) = identity.and_then(|id| id.process) else {
            continue;
        };
        let mut metrics: BTreeMap<&str, Metric> = BTreeMap::new();
        let mut statuses: Vec<NumberDataPoint> = vec![];
        let Ok(pid) = i32::try_from(process.pid) else {
            continue;
        };
        let Some(readings) = by_identity.remove(&(pid, process.start_ticks)) else {
            continue;
        };
        for reading in readings {
            let labels = vec![string("gpu.uuid", &reading.uuid)];
            let status = match reading.value {
                Ok(value) if reading.time_ns > 0 && reading.time_ns <= now => {
                    let metric = metrics
                        .entry(reading.metric.name)
                        .or_insert_with(|| gauge(reading.metric, vec![]));
                    if let Some(opentelemetry_proto::tonic::metrics::v1::metric::Data::Gauge(
                        gauge,
                    )) = &mut metric.data
                    {
                        gauge
                            .data_points
                            .push(point(value, reading.time_ns, 0, labels.clone()));
                    }
                    ReadStatus::Read
                }
                Ok(_) => ReadStatus::Unavailable,
                Err(error) => error,
            };
            let mut labels = labels;
            labels.push(string("recount.metric.name", reading.metric.name));
            statuses.push(point(Value::AsInt(status as i64), now, 0, labels));
        }
        if statuses.is_empty() {
            continue;
        }
        let mut metrics: Vec<_> = metrics.into_values().collect();
        metrics.push(gauge(&catalogue::READ_STATUS, statuses));
        let mut attrs = resource.resource.as_ref().unwrap().attributes.clone();
        attrs.retain(|attribute| {
            !matches!(
                attribute.key.as_str(),
                "recount.collection.source" | adapter::INTERVAL_NS
            )
        });
        attrs.push(string("recount.collection.source", "nvml"));
        attrs.push(integer(
            adapter::INTERVAL_NS,
            i64::try_from(interval.max(Duration::from_secs(1)).as_nanos()).unwrap_or(i64::MAX),
        ));
        let mut resource = measured_resource(attrs, vec![]);
        resource.scope_metrics = vec![ScopeMetrics {
            scope: Some(InstrumentationScope {
                name: "recount.collector.nvml".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                ..Default::default()
            }),
            metrics,
            ..Default::default()
        }];
        measured.push(resource);
    }
    measured
}
