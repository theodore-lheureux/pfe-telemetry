use crate::{
    identity::TypedHash,
    series::{ResourceAttributes, SeriesMetadata},
    wire::{AnalyticalPoint, AttributeNode, ContinuityNode},
};
use prost::Message;
use std::{
    collections::{HashMap, VecDeque},
    mem::size_of,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use xxhash_rust::xxh3::xxh3_128;

/// Process-local memoization, independent of delivery acknowledgements.
pub struct IdentityCache {
    pub(crate) resources: Table<Resource>,
    pub(crate) series: Table<Series>,
    resource_token: AtomicU64,
}

impl Default for IdentityCache {
    fn default() -> Self {
        // Budget resource entries separately: evicting one also invalidates
        // lookup of every series keyed by its token.
        Self::new(64, 1024 * 1024, 2 * 1024 * 1024)
    }
}

impl IdentityCache {
    /// Byte budgets per shard. Entries larger than a budget bypass the cache.
    pub fn new(shards: usize, resource_bytes: usize, series_bytes: usize) -> Self {
        assert!(shards.is_power_of_two());
        Self {
            resources: Table::new(shards, resource_bytes),
            series: Table::new(shards, series_bytes),
            resource_token: AtomicU64::new(0),
        }
    }

    /// Intern a resource only after a full byte comparison. Never reuse a
    /// token, even if its series outlive it in the other table.
    pub(crate) fn next_resource_token(&self) -> u64 {
        self.resource_token
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .expect("identity cache token exhausted")
    }
}

pub(crate) struct Resource {
    pub row: AnalyticalPoint,
    pub stream: TypedHash,
    pub token: u64,
    pub split: Option<Arc<ResourceAttributes>>,
}

pub(crate) struct Series {
    pub frame: AnalyticalPoint,
    pub metadata: Arc<SeriesMetadata>,
    pub bound_overhead: usize,
    pub stream: TypedHash,
    pub start: u64,
    pub full_len: usize,
    pub split_len: usize,
}

pub(crate) struct Table<V> {
    shards: Box<[Mutex<Shard<V>>]>,
    budget: usize,
}

struct Shard<V> {
    entries: HashMap<u128, Entry<V>>,
    fifo: VecDeque<u128>,
    bytes: usize,
}

struct Entry<V> {
    key: Box<[u8]>,
    value: Arc<V>,
    bytes: usize,
}

impl<V> Table<V> {
    fn new(shards: usize, budget: usize) -> Self {
        Self {
            shards: (0..shards)
                .map(|_| {
                    Mutex::new(Shard {
                        entries: HashMap::new(),
                        fifo: VecDeque::new(),
                        bytes: 0,
                    })
                })
                .collect(),
            budget,
        }
    }

    pub(crate) fn get_or_try_insert(
        &self,
        key: &[u8],
        build: impl FnOnce() -> Result<(V, usize), &'static str>,
    ) -> Result<Arc<V>, &'static str> {
        self.lookup(xxh3_128(key), key, build)
    }

    fn lookup(
        &self,
        hash: u128,
        key: &[u8],
        build: impl FnOnce() -> Result<(V, usize), &'static str>,
    ) -> Result<Arc<V>, &'static str> {
        let shard = &self.shards[hash as usize & (self.shards.len() - 1)];
        if let Some(entry) = shard.lock().unwrap().entries.get(&hash)
            && entry.key.as_ref() == key
        {
            return Ok(entry.value.clone());
        }
        // Don't hold a shard lock while projecting or hashing metadata.
        let (value, heap_bytes) = build()?;
        let value = Arc::new(value);
        let bytes = key.len() + heap_bytes + size_of::<V>() + 128;
        if bytes <= self.budget {
            let mut shard = shard.lock().unwrap();
            if let Some(existing) = shard.entries.get(&hash) {
                if existing.key.as_ref() == key {
                    // Another worker admitted it while we were building.
                    return Ok(existing.value.clone());
                }
                // A hash collision can bypass the cache, never replace an
                // unrelated key or cause retries to invalidate its series.
                return Ok(value);
            }
            while shard.bytes + bytes > self.budget {
                let oldest = shard.fifo.pop_front().unwrap();
                shard.bytes -= shard.entries.remove(&oldest).unwrap().bytes;
            }
            shard.bytes += bytes;
            shard.fifo.push_back(hash);
            shard.entries.insert(
                hash,
                Entry {
                    key: key.into(),
                    value: value.clone(),
                    bytes,
                },
            );
        }
        Ok(value)
    }
}

pub(crate) fn row_heap_bytes(row: &AnalyticalPoint) -> usize {
    // Encoded length covers strings and byte buffers, but not the storage for
    // the nodes (including nearly empty nodes) and repeated fields.
    row.encoded_len()
        + size_of::<AttributeNode>()
            * (row.resource_attributes.capacity()
                + row.scope_attributes.capacity()
                + row.point_attributes.capacity()
                + row.metric_metadata.capacity())
        + size_of::<ContinuityNode>()
            * (row.resource_continuity.capacity() + row.point_continuity.capacity())
        + size_of::<Vec<u8>>() * row.resource_entity_refs.capacity()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collisions_compare_bytes_and_full_shards_only_evict_oldest() {
        let cache = Table::new(1, 270);
        let insert = |hash, key: &[u8], n| *cache.lookup(hash, key, || Ok((n, 0))).unwrap();
        assert_eq!(insert(0, b"a", 1), 1);
        assert_eq!(insert(0, b"a", 2), 1);
        assert_eq!(insert(0, b"b", 3), 3);
        assert_eq!(insert(1, b"c", 4), 4);
        assert_eq!(insert(2, b"d", 6), 6);
        assert_eq!(insert(1, b"c", 7), 4);
        assert_eq!(insert(0, b"b", 5), 5);
    }
}
