use super::Collector;
use crate::{delivery::point_count, enrollment::Authorization, gpu::Gpu, metrics::resource};
use opentelemetry_proto::tonic::metrics::v1::ResourceMetrics;
use recount_telemetry_validation::{catalogue, linux_adapter::Scope};
use std::time::Duration;

impl Collector {
    pub(crate) fn gpu_authorization(&mut self, authorization: Option<Authorization>) {
        self.gpu_authorization = authorization;
    }

    pub(super) fn gpu_metrics(&mut self, time: u64, resources: &mut Vec<ResourceMetrics>) {
        if self
            .gpu_authorization
            .as_ref()
            .is_some_and(|auth| !auth.allows_gpu())
        {
            self.gpu = None;
            return;
        }
        let attrs = self.attributes(Scope::Gpu);
        let processes_enabled = self.visibility == "host"
            && self
                .gpu_authorization
                .as_ref()
                .is_none_or(|auth| auth.allows_process_gpu());
        let interval = Duration::from_nanos(self.interval_ns as u64);
        let gpu = self.gpu.get_or_insert_with(|| Gpu::new(interval));
        let mut added = gpu.sample(attrs, time, || {
            crate::gpu::process_context(resources, processes_enabled)
        });
        added.extend(gpu.attach_processes(resources, time));
        let status = gpu.discovery.map(crate::gpu::read_status).or_else(|| {
            gpu.has_devices()
                .then_some(crate::diagnostics::ReadStatus::Read)
        });
        let process_status = gpu.process_status;
        self.cycle_points = self.cycle_points.saturating_add(point_count(&added));
        if let Some(status) = status {
            let metric = self.int_gauge(&catalogue::GPU_DISCOVERY_STATUS, status as i64, time);
            added.push(resource(self.attributes(Scope::Collector), vec![metric]));
        }
        if let Some(status) = process_status {
            let metric = self.int_gauge(
                &catalogue::GPU_PROCESS_DISCOVERY_STATUS,
                status as i64,
                time,
            );
            added.push(resource(self.attributes(Scope::Collector), vec![metric]));
        }
        resources.extend(added);
    }
}
