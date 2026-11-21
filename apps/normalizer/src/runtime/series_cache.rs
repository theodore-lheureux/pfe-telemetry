use std::sync::Mutex;

pub const DEFAULT_ENTRIES: u32 = 131_072;
pub const MAX_ENTRIES: u32 = 1_048_576;

#[derive(Clone, Copy, Default)]
pub(super) struct Emission<K = u64> {
    pub series: K,
    pub time: u64,
    pub first: u64,
    pub emitted_at: u64,
    pub lane_partition: u32,
}

#[derive(Clone, Copy, Default)]
struct Entry<K> {
    emission: Emission<K>,
}

pub(super) struct SeriesCache<K = u64> {
    state: Mutex<CacheState<K>>,
    interval: u64,
}

struct CacheState<K> {
    slots: Box<[Entry<K>]>,
    emits: u64,
    suppressed: u64,
}

pub(super) trait CacheKey: Copy + Default + Eq {
    fn prefix(self) -> u64;
}

impl CacheKey for u64 {
    fn prefix(self) -> u64 {
        self
    }
}

impl<const N: usize> CacheKey for [u8; N]
where
    [u8; N]: Default,
{
    fn prefix(self) -> u64 {
        u64::from_be_bytes(self[..8].try_into().unwrap())
    }
}

impl<K: CacheKey> SeriesCache<K> {
    pub fn new(entries: usize, interval: u64) -> Self {
        Self {
            state: Mutex::new(CacheState {
                slots: vec![Entry::default(); entries].into_boxed_slice(),
                emits: 0,
                suppressed: 0,
            }),
            interval,
        }
    }

    fn index(e: Emission<K>, len: usize) -> usize {
        (e.series.prefix() ^ u64::from(e.lane_partition).wrapping_mul(0x9e37_79b9_7f4a_7c15))
            as usize
            % len
    }

    pub fn should_emit(&self, e: Emission<K>) -> bool {
        let mut state = self.state.lock().unwrap();
        let slots = &state.slots;
        let due = if slots.is_empty() || self.interval == 0 {
            true
        } else {
            let old = slots[Self::index(e, slots.len())].emission;
            old.time == 0
                || old.series != e.series
                || old.lane_partition != e.lane_partition
                || e.emitted_at < old.emitted_at
                || e.emitted_at - old.emitted_at >= self.interval
                || e.first < old.first
                || e.time.saturating_sub(old.time) >= self.interval
        };
        if due {
            state.emits += 1;
        } else {
            state.suppressed += 1;
        }
        due
    }

    pub fn counters(&self) -> (u64, u64) {
        let state = self.state.lock().unwrap();
        (state.emits, state.suppressed)
    }

    pub fn acknowledge(&self, emissions: &[Emission<K>]) {
        let mut state = self.state.lock().unwrap();
        let slots = &mut state.slots;
        if slots.is_empty() || self.interval == 0 {
            return;
        }
        let len = slots.len();
        for &e in emissions {
            let entry = &mut slots[Self::index(e, len)];
            if entry.emission.time != 0
                && entry.emission.series == e.series
                && entry.emission.lane_partition == e.lane_partition
            {
                entry.emission.first = entry.emission.first.min(e.first);
                entry.emission.time = entry.emission.time.max(e.time);
                entry.emission.emitted_at = entry.emission.emitted_at.max(e.emitted_at);
            } else {
                *entry = Entry { emission: e };
            }
        }
    }
}

const _: () = assert!(std::mem::size_of::<Entry<u64>>() == 40);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshes_wall_time_event_jumps_earlier_points_and_other_lanes() {
        let cache = SeriesCache::new(1, 60);
        let e = Emission {
            series: 5,
            time: 100,
            first: 100,
            emitted_at: 200,
            lane_partition: 0,
        };
        assert!(cache.should_emit(e));
        assert!(cache.should_emit(e)); // in flight is not an acknowledgement
        cache.acknowledge(&[e]);
        assert!(!cache.should_emit(Emission {
            time: 159,
            emitted_at: 259,
            ..e
        }));
        assert!(cache.should_emit(Emission {
            time: 99,
            first: 99,
            ..e
        }));
        assert!(cache.should_emit(Emission { time: 160, ..e }));
        assert!(cache.should_emit(Emission {
            emitted_at: 260,
            ..e
        }));
        assert!(cache.should_emit(Emission {
            lane_partition: 1,
            ..e
        }));
        assert!(cache.should_emit(Emission { series: 6, ..e }));
        cache.acknowledge(&[Emission { series: 6, ..e }]);
        assert!(cache.should_emit(e)); // eviction only causes a duplicate
        assert_eq!(cache.counters(), (8, 1));
    }
}
