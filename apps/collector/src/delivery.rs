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
    resources: Vec<ResourceMetrics>,
    loss: LossTracker,
}

impl Scan {
    pub(crate) fn new(
        epoch: String,
        generation: u64,
        resources: Vec<ResourceMetrics>,
        loss: LossTracker,
    ) -> Self {
        Self {
            epoch,
            generation,
            resources,
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
        self.loss
            .record(&self.epoch, reason, point_count(&self.resources));
        self.resources.clear();
    }

    /// Transfers the points to persistence without reporting them as lost.
    pub fn into_resources(mut self) -> Vec<ResourceMetrics> {
        std::mem::take(&mut self.resources)
    }
}

impl Drop for Scan {
    fn drop(&mut self) {
        self.loss.record(
            &self.epoch,
            LossReason::BufferExpired,
            point_count(&self.resources),
        );
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
