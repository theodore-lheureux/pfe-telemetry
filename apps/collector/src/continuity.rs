use std::collections::{BTreeMap, BTreeSet};

struct Previous {
    raw: u64,
    time: u64,
    segment: String,
}

/// Keeps counter segments stable until a reset, missing read or known loss.
#[derive(Default)]
pub(crate) struct Continuity {
    previous: BTreeMap<String, Previous>,
    seen: BTreeSet<String>,
}

impl Continuity {
    pub(crate) fn invalidate(&mut self) {
        self.previous.clear();
        self.seen.clear();
    }

    pub(crate) fn begin_scan(&mut self) {
        self.seen.clear();
    }

    pub(crate) fn segment(&mut self, key: String, raw: u64, time: u64) -> String {
        let segment = match self.previous.get(&key) {
            Some(previous) if raw >= previous.raw && time > previous.time => {
                previous.segment.clone()
            }
            _ => uuid::Uuid::new_v4().to_string(),
        };
        self.seen.insert(key.clone());
        self.previous.insert(
            key,
            Previous {
                raw,
                time,
                segment: segment.clone(),
            },
        );
        segment
    }

    pub(crate) fn finish_scan(&mut self) {
        self.previous.retain(|key, _| self.seen.contains(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuity_requires_successive_non_decreasing_reads() {
        let mut tracker = Continuity::default();
        tracker.begin_scan();
        let first = tracker.segment("disk".into(), 10, 1);
        tracker.finish_scan();
        tracker.begin_scan();
        assert_eq!(tracker.segment("disk".into(), 10, 2), first);
        tracker.finish_scan();
        tracker.begin_scan();
        let reset = tracker.segment("disk".into(), 1, 3);
        assert_ne!(reset, first);
        tracker.finish_scan();
        tracker.begin_scan();
        tracker.finish_scan();
        tracker.begin_scan();
        let reappeared = tracker.segment("disk".into(), 2, 4);
        assert_ne!(reappeared, reset);
        tracker.invalidate();
        assert_ne!(tracker.segment("disk".into(), 3, 5), reappeared);
    }

    #[test]
    fn time_must_increase_and_stream_dimensions_are_independent() {
        let mut tracker = Continuity::default();
        let read = tracker.segment("disk/read".into(), 10, 100);
        let write = tracker.segment("disk/write".into(), 10, 100);
        assert_ne!(read, write);
        let repeated_time = tracker.segment("disk/read".into(), 11, 100);
        assert_ne!(read, repeated_time);
        assert_ne!(tracker.segment("disk/read".into(), 12, 99), repeated_time);
        assert_eq!(tracker.segment("disk/write".into(), 11, 101), write);
    }
}
