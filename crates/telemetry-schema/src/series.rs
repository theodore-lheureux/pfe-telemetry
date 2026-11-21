use crate::{
    identity::TypedHash,
    wire::{AnalyticalPoint, AttributeNode, ContinuityNode},
};
use prost::Message;
use std::sync::Arc;

pub(crate) const RESOURCE_MARKERS: &[&str] =
    &["recount.host.boot_id", "recount.collection.epoch_id"];
pub(crate) const POINT_MARKERS: &[&str] = &["recount.counter.segment_id"];

fn is_marker(path: &str, markers: &[&str]) -> bool {
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    markers.iter().any(|marker| {
        path == *marker
            || path
                .strip_prefix(marker)
                .is_some_and(|p| p.starts_with('/'))
    })
}

/// Bound the extra fields in a singleton before admission. Packet elision can
/// only make the frame smaller. Protobuf record-length framing is budgeted separately.
pub fn singleton_size_bound(point: &AnalyticalPoint) -> usize {
    point.encoded_len() + singleton_overhead(point)
}

pub(crate) fn singleton_overhead(point: &AnalyticalPoint) -> usize {
    let mut count = 0;
    for (nodes, markers) in [
        (&point.resource_attributes, RESOURCE_MARKERS),
        (&point.point_attributes, POINT_MARKERS),
    ] {
        count += nodes
            .iter()
            .filter(|node| is_marker(&node.path, markers))
            .count();
    }
    singleton_overhead_for_markers(count)
}

pub(crate) fn singleton_overhead_for_markers(count: usize) -> usize {
    // A storage key, a logical key and two timestamp bounds are fixed64s.
    4 * 10 + 48 + count * 20
}

/// A split point with optional shared series metadata. Uncached preparation
/// leaves the point intact until packing.
pub struct PreparedPoint {
    pub frame: AnalyticalPoint,
    pub metadata: Option<Arc<SeriesMetadata>>,
    pub resource: Option<Arc<ResourceAttributes>>,
}

pub struct SeriesMetadata {
    row: AnalyticalPoint,
    attached_len: usize,
    resource_continuity: Vec<ContinuityNode>,
    point_continuity: Vec<ContinuityNode>,
}

impl SeriesMetadata {
    pub fn new(point: &mut AnalyticalPoint) -> Self {
        Self::from_split(point, None)
    }

    pub(crate) fn from_split(
        point: &mut AnalyticalPoint,
        resource: Option<&ResourceAttributes>,
    ) -> Self {
        let (mut row, encoded) = split_identity(point, resource);
        let mut attached_len = encoded.len();
        // The frame already owns these fields. Source is restored from series
        // on attachment if the frame did not carry delivery evidence.
        attached_len -= (AnalyticalPoint {
            project_id: row.project_id.clone(),
            metric_name: row.metric_name.clone(),
            ..Default::default()
        })
        .encoded_len();
        attached_len += 10 * usize::from(row.logical_series_id != 0);
        if resource.is_some() {
            row.resource_attributes = Vec::new();
            row.resource_entity_refs = Vec::new();
        }
        let mut resource_continuity = std::mem::take(&mut point.resource_continuity);
        if resource.is_some() {
            resource_continuity = Vec::new();
        }
        Self {
            row,
            attached_len,
            resource_continuity,
            point_continuity: std::mem::take(&mut point.point_continuity),
        }
    }

    pub(crate) fn heap_bytes(&self) -> usize {
        crate::identity_cache::row_heap_bytes(&self.row)
            + continuity_heap_bytes(&self.resource_continuity)
            + continuity_heap_bytes(&self.point_continuity)
    }

    pub fn restore_continuity(
        &self,
        point: &mut AnalyticalPoint,
        resource: Option<&ResourceAttributes>,
    ) {
        point
            .resource_continuity
            .clone_from(resource.map_or(&self.resource_continuity, |r| &r.continuity));
        point.point_continuity.clone_from(&self.point_continuity);
    }

    pub fn attached_len(&self, source_in_frame: bool, first: u64, last: u64) -> usize {
        self.attached_len
            - if source_in_frame {
                self.source_len()
            } else {
                0
            }
            + 10 * (usize::from(first != 0) + usize::from(last != 0))
    }

    pub(crate) fn source_len(&self) -> usize {
        let len = self.row.source_id.len();
        if len == 0 {
            0
        } else {
            1 + prost::length_delimiter_len(len) + len
        }
    }

    pub(crate) fn restore_source(&self, point: &mut AnalyticalPoint) {
        point.source_id.clone_from(&self.row.source_id);
    }

    pub fn attach(
        &self,
        point: AnalyticalPoint,
        resource: Option<&ResourceAttributes>,
        first: u64,
        last: u64,
    ) -> AnalyticalPoint {
        let mut point = with_series(point, &self.row);
        if let Some(resource) = resource {
            point.resource_attributes.clone_from(&resource.dimensions);
            point.resource_entity_refs.clone_from(&resource.entity_refs);
        }
        point.first_seen_unix_nano = first;
        point.last_seen_unix_nano = last;
        point
    }
}

fn continuity_heap_bytes(nodes: &Vec<ContinuityNode>) -> usize {
    nodes.capacity() * std::mem::size_of::<ContinuityNode>()
        + nodes.iter().map(Message::encoded_len).sum::<usize>()
}

fn id(hash: TypedHash) -> u64 {
    u64::from_be_bytes(hash.finish()[..8].try_into().unwrap())
}

fn without_markers(
    mut attributes: Vec<AttributeNode>,
    markers: &[&str],
) -> (Vec<AttributeNode>, Vec<ContinuityNode>) {
    let mut continuity = Vec::new();
    attributes.retain_mut(|node| {
        if is_marker(&node.path, markers) {
            continuity.push(ContinuityNode {
                ordinal: 0,
                node: Some(std::mem::take(node)),
            });
            false
        } else {
            true
        }
    });
    // The stream key ignores map order. Its evidence must not depend on
    // the order in which a collector happens to report those same keys.
    continuity.sort_unstable_by(|a, b| {
        a.node
            .as_ref()
            .unwrap()
            .path
            .cmp(&b.node.as_ref().unwrap().path)
    });
    (attributes, continuity)
}

pub struct ResourceAttributes {
    dimensions: Vec<AttributeNode>,
    pub(crate) continuity: Vec<ContinuityNode>,
    entity_refs: Vec<Vec<u8>>,
}

impl ResourceAttributes {
    pub(crate) fn new(nodes: Vec<AttributeNode>, entity_refs: Vec<Vec<u8>>) -> Self {
        let (dimensions, continuity) = without_markers(nodes, RESOURCE_MARKERS);
        Self {
            dimensions,
            continuity,
            entity_refs,
        }
    }

    pub(crate) fn heap_bytes(&self) -> usize {
        use std::mem::size_of;

        size_of::<Self>()
            + self.dimensions.capacity() * size_of::<AttributeNode>()
            + self.continuity.capacity() * size_of::<ContinuityNode>()
            + self.entity_refs.capacity() * size_of::<Vec<u8>>()
            + self
                .dimensions
                .iter()
                .map(Message::encoded_len)
                .sum::<usize>()
            + self
                .continuity
                .iter()
                .map(Message::encoded_len)
                .sum::<usize>()
            + self.entity_refs.iter().map(Vec::capacity).sum::<usize>()
    }
}

/// Pull out metadata without losing inspector details. A metadata revision changes
/// the storage key but doesn't split the logical series used for dashboard math.
pub fn split(point: &mut AnalyticalPoint) -> AnalyticalPoint {
    let (mut series, _) = split_identity(point, None);
    series.first_seen_unix_nano = point.time_unix_nano;
    series.last_seen_unix_nano = point.time_unix_nano;
    series
}

fn split_identity(
    point: &mut AnalyticalPoint,
    resource: Option<&ResourceAttributes>,
) -> (AnalyticalPoint, Vec<u8>) {
    let mut series = AnalyticalPoint {
        project_id: point.project_id.clone(),
        source_id: point.source_id.clone(),
        resource_id: std::mem::take(&mut point.resource_id),
        resource_kind: std::mem::take(&mut point.resource_kind),
        host_id: point.host_id.take(),
        metric_name: point.metric_name.clone(),
        unit: std::mem::take(&mut point.unit),
        metric_kind: std::mem::take(&mut point.metric_kind),
        resource_present: std::mem::take(&mut point.resource_present),
        scope_present: std::mem::take(&mut point.scope_present),
        scope_name: std::mem::take(&mut point.scope_name),
        scope_version: std::mem::take(&mut point.scope_version),
        resource_schema_url: std::mem::take(&mut point.resource_schema_url),
        scope_schema_url: std::mem::take(&mut point.scope_schema_url),
        scope_attributes: std::mem::take(&mut point.scope_attributes),
        metric_metadata: std::mem::take(&mut point.metric_metadata),
        temporality: std::mem::take(&mut point.temporality),
        monotonic: point.monotonic.take(),
        description: std::mem::take(&mut point.description),
        resource_dropped_attributes_count: std::mem::take(
            &mut point.resource_dropped_attributes_count,
        ),
        scope_dropped_attributes_count: std::mem::take(&mut point.scope_dropped_attributes_count),
        resource_entity_refs: std::mem::take(&mut point.resource_entity_refs),
        ..Default::default()
    };
    if point.delivery_evidence.is_empty() {
        point.source_id.clear();
    }
    let nodes = std::mem::take(&mut point.resource_attributes);
    (series.resource_attributes, point.resource_continuity) = resource.map_or_else(
        || without_markers(nodes, RESOURCE_MARKERS),
        |resource| (resource.dimensions.clone(), resource.continuity.clone()),
    );
    (series.point_attributes, point.point_continuity) =
        without_markers(std::mem::take(&mut point.point_attributes), POINT_MARKERS);
    let mut storage = TypedHash::new("recount.series");
    let encoded = series.encode_to_vec();
    storage.field(&encoded);
    series.series_id = id(storage);
    point.series_id = series.series_id;

    let mut logical = TypedHash::new("recount.logical-series");
    for value in [&series.project_id, &series.source_id, &series.resource_id] {
        logical.field(value.as_bytes());
    }
    logical.u64(series.resource_kind as u64);
    logical.u64(u64::from(series.host_id.is_some()));
    logical.field(series.host_id.as_deref().unwrap_or_default().as_bytes());
    for value in [
        &series.scope_name,
        &series.scope_version,
        &series.metric_name,
        &series.unit,
    ] {
        logical.field(value.as_bytes());
    }
    for nodes in [
        &series.resource_attributes,
        &series.scope_attributes,
        &series.point_attributes,
    ] {
        let mut sorted: Vec<_> = nodes.iter().collect();
        sorted.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        logical.u64(sorted.len() as u64);
        for node in sorted {
            logical.field(&node.encode_to_vec());
        }
    }
    series.logical_series_id = id(logical);
    (series, encoded)
}

/// Encode one message in field order, with a single copy of each shared key.
pub fn with_series(mut frame: AnalyticalPoint, series: &AnalyticalPoint) -> AnalyticalPoint {
    include!(concat!(env!("OUT_DIR"), "/attach-series.rs"));
    frame
}

/// Disambiguate deliveries from the same source at the same receipt time.
pub fn receipt_tag(record_id: &str) -> u32 {
    let mut hash = TypedHash::new("recount.receipt");
    hash.field(record_id.as_bytes());
    u32::from_be_bytes(hash.finish()[..4].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracting_continuity_sorts_markers_without_reordering_dimensions() {
        let (dimensions, continuity) = without_markers(
            vec![
                attr("/plain-a", "a"),
                attr("/recount.host.boot_id", "boot"),
                attr("/plain-b", "b"),
                attr("/recount.collection.epoch_id", "epoch"),
            ],
            RESOURCE_MARKERS,
        );
        assert_eq!(
            dimensions,
            vec![attr("/plain-a", "a"), attr("/plain-b", "b")]
        );
        assert_eq!(
            continuity,
            vec![
                ContinuityNode {
                    ordinal: 0,
                    node: Some(attr("/recount.collection.epoch_id", "epoch"))
                },
                ContinuityNode {
                    ordinal: 0,
                    node: Some(attr("/recount.host.boot_id", "boot"))
                },
            ],
        );
    }

    fn attr(path: &str, value: &str) -> AttributeNode {
        AttributeNode {
            path: path.into(),
            kind: 2,
            string_value: Some(value.into()),
            ..Default::default()
        }
    }

    #[test]
    fn storage_and_logical_keys_separate_metadata_revisions_from_resets() {
        let fixture = AnalyticalPoint {
            project_id: "p".into(),
            metric_name: "counter".into(),
            time_unix_nano: 100,
            resource_attributes: vec![
                attr("/hostname", "host"),
                attr("/recount.host.boot_id", "1"),
            ],
            point_attributes: vec![
                attr("/recount.counter.segment_id", "1"),
                attr("/mode", "user"),
            ],
            ..Default::default()
        };
        let mut point = fixture.clone();
        let series = split(&mut point);
        assert_eq!(series.series_id, point.series_id);
        assert_eq!(point.resource_continuity[0].ordinal, 0);
        assert_eq!(point.point_continuity[0].ordinal, 0);
        assert_eq!(series.resource_attributes.len(), 1);
        assert_eq!(series.point_attributes.len(), 1);
        let decoded = AnalyticalPoint::decode(
            with_series(point.clone(), &series)
                .encode_to_vec()
                .as_slice(),
        )
        .unwrap();
        assert_eq!(decoded.series_id, series.series_id);
        assert_eq!(decoded.logical_series_id, series.logical_series_id);
        assert_eq!(decoded.first_seen_unix_nano, point.time_unix_nano);
        assert_eq!(decoded.project_id, point.project_id);
        assert_eq!(decoded.resource_continuity, point.resource_continuity);

        let mut next = fixture.clone();
        next.time_unix_nano = 200;
        next.point_attributes[0] = attr("/recount.counter.segment_id", "2");
        next.resource_attributes[1] = attr("/recount.host.boot_id", "2");
        assert_eq!(split(&mut next).series_id, series.series_id);
        let mut revision = fixture.clone();
        revision.description = "revised".into();
        let revision = split(&mut revision);
        assert_ne!(revision.series_id, series.series_id);
        assert_eq!(revision.logical_series_id, series.logical_series_id);
        let mut different = fixture;
        different.point_attributes[1] = attr("/mode", "idle");
        assert_ne!(
            split(&mut different).logical_series_id,
            series.logical_series_id
        );
    }
}
