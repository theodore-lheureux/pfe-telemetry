use std::sync::{Arc, Mutex};

use opentelemetry_proto::tonic::metrics::v1::{ResourceMetrics, metric};

/// Why measurement points were discarded before durable acceptance.
#[derive(Clone, Copy)]
pub enum LossReason {
    /// The pending-upload queue or scan buffer had no capacity.
    BufferFull,
    /// Points expired or became stale before export.
    BufferExpired,
    /// The receiver rejected points without a retryable status.
    PermanentRejection,
}

impl LossReason {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::BufferFull => 0,
            Self::BufferExpired => 1,
            Self::PermanentRejection => 2,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::BufferFull => "buffer_full",
            Self::BufferExpired => "buffer_expired",
            Self::PermanentRejection => "permanent_rejection",
        }
    }
}

#[derive(Default)]
struct LossState {
    epoch: String,
    generation: u64,
    counts: [u64; 3],
}

/// Shares loss counts with the sampler so it can start new counter segments.
#[derive(Clone, Default)]
pub struct LossTracker(Arc<Mutex<LossState>>);

impl LossTracker {
    pub(crate) fn start_epoch(&self, epoch: &str) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.epoch = epoch.into();
        state.counts = [0; 3];
    }

    pub(crate) fn snapshot(&self) -> (u64, [u64; 3]) {
        let state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.generation, state.counts)
    }

    /// Changes whenever known loss invalidates counter continuity.
    pub fn generation(&self) -> u64 {
        self.snapshot().0
    }

    /// Records loss and notifies sampling; counts belong to their collection epoch.
    pub fn record(&self, epoch: &str, reason: LossReason, points: u64) {
        if points == 0 {
            return;
        }
        tracing::warn!(
            points,
            reason = reason.name(),
            "Local measurement points discarded"
        );
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.generation = state.generation.saturating_add(1);
        // Late failures of an old epoch break continuity but cannot enter the
        // current epoch's cumulative discard counts.
        if state.epoch == epoch {
            let count = &mut state.counts[reason.index()];
            *count = count.saturating_add(points);
        }
    }
}

/// A sampled batch awaiting persistence. Dropping it records its points as lost.
pub struct Scan {
    epoch: String,
    generation: u64,
    contents: Option<ScanContents>,
    loss: LossTracker,
}

pub struct ScanContents {
    pub measurements: Vec<ResourceMetrics>,
    /// Shared observations repeated unchanged in every split export request.
    pub window: ResourceMetrics,
    pub diagnostics: ResourceMetrics,
}

impl ScanContents {
    pub fn point_count(&self) -> u64 {
        point_count(&self.measurements)
            + point_count(std::slice::from_ref(&self.window))
            + point_count(std::slice::from_ref(&self.diagnostics))
    }
}

impl Scan {
    pub(crate) fn new(
        epoch: String,
        generation: u64,
        contents: ScanContents,
        loss: LossTracker,
    ) -> Self {
        Self {
            epoch,
            generation,
            contents: Some(contents),
            loss,
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// Changes whenever known loss invalidates counter continuity.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Records the supplied loss reason and releases the sampled points.
    pub fn discard(mut self, reason: LossReason) {
        if let Some(contents) = self.contents.take() {
            self.loss
                .record(&self.epoch, reason, contents.point_count());
        }
    }

    /// Transfers the points to persistence without reporting them as lost.
    pub fn into_contents(mut self) -> ScanContents {
        self.contents
            .take()
            .expect("Scan owns its sampled contents")
    }
}

impl Drop for Scan {
    fn drop(&mut self) {
        if let Some(contents) = &self.contents {
            self.loss.record(
                &self.epoch,
                LossReason::BufferExpired,
                contents.point_count(),
            );
        }
    }
}

/// Counts the scalar points emitted by the collector.
pub fn point_count(resources: &[ResourceMetrics]) -> u64 {
    resources
        .iter()
        .flat_map(|resource| &resource.scope_metrics)
        .flat_map(|scope| &scope.metrics)
        .map(|metric| match &metric.data {
            Some(metric::Data::Gauge(data)) => data.data_points.len() as u64,
            Some(metric::Data::Sum(data)) => data.data_points.len() as u64,
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{gauge, point, resource};
    use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value;
    use recount_telemetry_validation::catalogue::CLOCK_STATUS;

    #[test]
    fn scan_drop_discard_and_transfer_account_for_all_components_once() {
        let loss = LossTracker::default();
        loss.start_epoch("epoch");
        let scalar = resource(
            vec![],
            vec![gauge(
                &CLOCK_STATUS,
                vec![point(Value::AsInt(0), 200, 0, vec![])],
            )],
        );
        let contents = || ScanContents {
            measurements: vec![scalar.clone(), scalar.clone()],
            window: scalar.clone(),
            diagnostics: scalar.clone(),
        };
        let scan = || Scan::new("epoch".into(), loss.generation(), contents(), loss.clone());
        drop(scan());
        assert_eq!(loss.snapshot(), (1, [0, 4, 0]));
        scan().discard(LossReason::BufferFull);
        assert_eq!(loss.snapshot(), (2, [4, 4, 0]));
        assert_eq!(scan().into_contents().point_count(), 4);
        assert_eq!(loss.snapshot(), (2, [4, 4, 0]));
    }

    #[test]
    fn old_epoch_loss_does_not_enter_new_epoch_counts() {
        let loss = LossTracker::default();
        loss.start_epoch("old");
        loss.record("old", LossReason::BufferFull, 3);
        assert_eq!(loss.snapshot(), (1, [3, 0, 0]));
        loss.start_epoch("new");
        loss.record("old", LossReason::BufferExpired, 2);
        assert_eq!(loss.snapshot(), (2, [0, 0, 0]));
        loss.record("new", LossReason::PermanentRejection, 4);
        assert_eq!(loss.snapshot(), (3, [0, 0, 4]));
    }
}
