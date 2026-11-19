use crate::{
    identity::TypedHash,
    wire::{AnalyticalPoint, AttributeNode, ContinuityNode, PointLineage},
};
use prost::Message;

const RESOURCE_MARKERS: &[&str] = &["/recount.host.boot_id", "/recount.collection.epoch_id"];
const POINT_MARKERS: &[&str] = &["/recount.counter.segment_id"];

fn is_marker(path: &str, markers: &[&str]) -> bool {
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
    // A storage key, a logical key and two timestamp bounds are fixed64s.
    let mut overhead = 4 * 10 + 48;
    for (nodes, markers) in [
        (&point.resource_attributes, RESOURCE_MARKERS),
        (&point.point_attributes, POINT_MARKERS),
    ] {
        overhead += nodes
            .iter()
            .filter(|node| is_marker(&node.path, markers))
            .count()
            * 20;
    }
    point.encoded_len() + overhead
}

fn id(hash: TypedHash) -> u64 {
    u64::from_be_bytes(hash.finish()[..8].try_into().unwrap())
}

fn without_markers(
    attributes: Vec<AttributeNode>,
    markers: &[&str],
) -> (Vec<AttributeNode>, Vec<ContinuityNode>) {
    let mut dimensions = Vec::new();
    let mut continuity = Vec::new();
    for (ordinal, node) in attributes.into_iter().enumerate() {
        if is_marker(&node.path, markers) {
            continuity.push(ContinuityNode {
                ordinal: ordinal as u32,
                node: Some(node),
            });
        } else {
            dimensions.push(node);
        }
    }
    (dimensions, continuity)
}

/// Pull out metadata without losing inspector details. A metadata revision changes
/// the storage key but doesn't split the logical series used for dashboard math.
pub fn split(point: &mut AnalyticalPoint) -> AnalyticalPoint {
    let mut series = AnalyticalPoint {
        project_id: point.project_id.clone(),
        source_id: std::mem::take(&mut point.source_id),
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
    (series.resource_attributes, point.resource_continuity) = without_markers(
        std::mem::take(&mut point.resource_attributes),
        RESOURCE_MARKERS,
    );
    (series.point_attributes, point.point_continuity) =
        without_markers(std::mem::take(&mut point.point_attributes), POINT_MARKERS);
    let mut storage = TypedHash::new("recount.series");
    storage.field(&series.encode_to_vec());
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
    series.first_seen_unix_nano = point.time_unix_nano;
    series.last_seen_unix_nano = point.time_unix_nano;
    series
}

/// Encode one message in field order, with a single copy of each shared key.
pub fn with_series(mut frame: AnalyticalPoint, series: &AnalyticalPoint) -> AnalyticalPoint {
    include!(concat!(env!("OUT_DIR"), "/attach-series.rs"));
    frame
}

/// Lower request evidence to a content-addressed delivery and a point position.
/// Receipt and resolved resource context participate in the delivery hash; a
/// later transport attempt cannot overwrite evidence referenced by other points.
pub fn split_delivery(point: &mut AnalyticalPoint) -> Result<(), &'static str> {
    let mut lineage =
        PointLineage::decode(point.lineage.as_slice()).map_err(|_| "invalid lineage")?;
    point.original_position = lineage
        .original
        .take()
        .map_or_else(Vec::new, |p| p.encode_to_vec());
    point.received_unix_nano = lineage.received_unix_nano;
    point.lineage = lineage.encode_to_vec();
    let mut hash = TypedHash::new("recount.delivery");
    hash.field(point.project_id.as_bytes());
    hash.field(point.source_id.as_bytes());
    hash.field(&point.lineage);
    point.delivery_id = hash.finish()[..16].to_vec();
    point.sample_id.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(point.resource_continuity[0].ordinal, 1);
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
