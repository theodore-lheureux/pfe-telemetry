use std::{collections::BTreeMap, time::Duration};

use opentelemetry_proto::tonic::{
    common::v1::{InstrumentationScope, KeyValue},
    metrics::v1::{ResourceMetrics, number_data_point::Value},
};
use recount_nvidia_dcgm::{Device, Error, Field};
use recount_telemetry_validation::{catalogue, linux_adapter as adapter};

use super::mapping;
use crate::{
    diagnostics::ReadStatus,
    metrics::{gauge, integer, point, resource, string},
};

pub(super) fn resources(
    devices: &[Device],
    seen: &mut BTreeMap<(String, Field), u64>,
    attributes: Vec<KeyValue>,
    now: u64,
    interval: Duration,
) -> Vec<ResourceMetrics> {
    let age_ns =
        u64::try_from((interval.max(Duration::from_secs(1)) * 3).as_nanos()).unwrap_or(u64::MAX);
    devices
        .iter()
        .filter(|device| {
            adapter::gpu_uuid(&device.uuid)
                && device.parent_uuid.as_ref().is_none_or(|parent| {
                    device.uuid.starts_with("MIG-")
                        && parent.starts_with("GPU-")
                        && adapter::gpu_uuid(parent)
                })
                && (!device.uuid.starts_with("MIG-") || device.parent_uuid.is_some())
        })
        .map(|device| {
            let mut metrics = vec![];
            let mut statuses = vec![];
            for reading in &device.readings {
                let (definition, dimensions) = mapping::definition(reading.field);
                let result = reading.value.as_ref().map_err(|e| *e).and_then(|value| {
                    if device.parent_uuid.is_some() && !reading.field.instance_scoped() {
                        return Err(Error::Unsupported);
                    }
                    if reading.time_ns == 0
                        || reading.time_ns > now
                        || now.saturating_sub(reading.time_ns) > age_ns
                    {
                        return Err(Error::Unavailable);
                    }
                    let key = (device.uuid.clone(), reading.field);
                    if seen.get(&key).is_some_and(|last| *last >= reading.time_ns) {
                        return Err(Error::Unavailable);
                    }
                    let converted = mapping::value(reading.field, value)?;
                    seen.insert(key, reading.time_ns);
                    Ok(converted)
                });
                let status = match result {
                    Ok(value) => {
                        metrics.push(gauge(
                            definition,
                            vec![point(value, reading.time_ns, 0, dimensions.clone())],
                        ));
                        ReadStatus::Read
                    }
                    Err(error) => mapping::status(error),
                };
                let mut labels = dimensions;
                labels.push(string("recount.metric.name", definition.name));
                statuses.push(point(Value::AsInt(status as i64), now, 0, labels));
            }
            metrics.push(gauge(&catalogue::READ_STATUS, statuses));
            let mut attrs = attributes.clone();
            attrs.retain(|a| a.key != "recount.collection.source" && a.key != adapter::INTERVAL_NS);
            attrs.push(string("recount.collection.source", "dcgm"));
            attrs.push(integer(
                adapter::INTERVAL_NS,
                i64::try_from(interval.max(Duration::from_secs(1)).as_nanos()).unwrap_or(i64::MAX),
            ));
            attrs.push(string(adapter::GPU_UUID, &device.uuid));
            if let Some(parent) = &device.parent_uuid {
                attrs.push(string(adapter::GPU_PARENT_UUID, parent));
            }
            let mut resource = resource(attrs, metrics);
            resource.scope_metrics[0].scope = Some(InstrumentationScope {
                name: "recount.collector.dcgm".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                attributes: vec![integer(
                    "gpu.profiling.multiplexing_possible",
                    i64::from(device.multiplexed),
                )],
                ..Default::default()
            });
            resource
        })
        .collect()
}
