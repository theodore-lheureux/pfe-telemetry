use prost::Message;
use recount_telemetry_schema::{
    PACKED_BYTES, PACKED_POINTS, identity,
    point::{RoutedRecord, normalized_routing_key},
    recent, series,
    wire::AnalyticalPoint,
};
use recount_telemetry_validation::transport::{FRAMING_RESERVE, body_fits};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Default)]
struct Packet {
    points: Vec<AnalyticalPoint>,
    // The index of the first frame and its metadata, including the packet bounds.
    series: HashMap<u64, (usize, AnalyticalPoint)>,
    deliveries: HashSet<Vec<u8>>,
    bytes: usize,
}

fn frame_size(point: &AnalyticalPoint, metadata: Option<&AnalyticalPoint>) -> usize {
    let len = point.encoded_len()
        + metadata.map_or(0, |row| {
            row.encoded_len()
                - AnalyticalPoint {
                    project_id: row.project_id.clone(),
                    series_id: row.series_id,
                    metric_name: row.metric_name.clone(),
                    ..Default::default()
                }
                .encoded_len()
        });
    prost::length_delimiter_len(len) + len
}

impl Packet {
    fn push(&mut self, point: AnalyticalPoint, metadata: AnalyticalPoint, bytes: usize) {
        let (_, bounds) = self
            .series
            .entry(point.series_id)
            .or_insert((self.points.len(), metadata));
        bounds.first_seen_unix_nano = bounds.first_seen_unix_nano.min(point.time_unix_nano);
        bounds.last_seen_unix_nano = bounds.last_seen_unix_nano.max(point.time_unix_nano);
        self.points.push(point);
        self.bytes += bytes;
    }

    fn finish(self, partition: u32) -> RoutedRecord {
        let time_unix_nano = self.points[0].time_unix_nano;
        let mut payload = Vec::with_capacity(self.bytes);
        for (index, point) in self.points.into_iter().enumerate() {
            if let Some((first, metadata)) = self.series.get(&point.series_id)
                && *first == index
            {
                series::with_series(point, metadata)
                    .encode_length_delimited(&mut payload)
                    .unwrap();
            } else {
                point.encode_length_delimited(&mut payload).unwrap();
            }
        }
        debug_assert_eq!(self.bytes, payload.len());
        RoutedRecord {
            partition,
            time_unix_nano,
            payload,
        }
    }
}

pub(crate) fn pack(
    points: Vec<AnalyticalPoint>,
    partitions: u32,
    now: u64,
    broker_bytes: usize,
    packed_recent: bool,
) -> Result<Vec<RoutedRecord>, &'static str> {
    let batch_bytes = PACKED_BYTES.min(broker_bytes.saturating_sub(FRAMING_RESERVE));
    let mut pending = BTreeMap::<u32, Packet>::new();
    let mut output = Vec::new();
    for mut point in points {
        let partition = identity::partition(&normalized_routing_key(&point)?, partitions)
            .ok_or("positive partition count required")?;
        series::split_delivery(&mut point)?;
        let metadata = series::split(&mut point);
        if !packed_recent || !recent(point.time_unix_nano, now) {
            let time_unix_nano = point.time_unix_nano;
            let payload = series::with_series(point, &metadata).encode_to_vec();
            body_fits(payload.len(), broker_bytes)?;
            output.push(RoutedRecord {
                partition,
                time_unix_nano,
                payload,
            });
            continue;
        }
        let packet = pending.entry(partition).or_default();
        let mut elided = Vec::new();
        if packet.deliveries.contains(&point.delivery_id) {
            elided = std::mem::take(&mut point.lineage);
        }
        let mut bytes = frame_size(
            &point,
            (!packet.series.contains_key(&point.series_id)).then_some(&metadata),
        );
        if !packet.points.is_empty()
            && (packet.points.len() == PACKED_POINTS || packet.bytes + bytes > batch_bytes)
        {
            output.push(std::mem::take(packet).finish(partition));
            if !elided.is_empty() {
                point.lineage = elided;
            }
            bytes = frame_size(&point, Some(&metadata));
        }
        body_fits(packet.bytes + bytes, broker_bytes)?;
        packet.deliveries.insert(point.delivery_id.clone());
        packet.push(point, metadata, bytes);
        // A valid indivisible point larger than the packing target travels alone.
        if packet.bytes >= batch_bytes {
            output.push(std::mem::take(packet).finish(partition));
        }
    }
    output.extend(
        pending
            .into_iter()
            .filter(|(_, p)| !p.points.is_empty())
            .map(|(partition, p)| p.finish(partition)),
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(t: u64, stream: u8, sample: u8) -> AnalyticalPoint {
        AnalyticalPoint {
            project_id: "project".into(),
            metric_name: "metric".into(),
            stream_id: [vec![0; 7], vec![stream], vec![0; 24]].concat(),
            int_value: Some(sample.into()),
            time_unix_nano: t,
            ..Default::default()
        }
    }

    #[test]
    fn packets_repeat_dimensions_only_across_packet_boundaries_and_track_event_bounds() {
        let now = 1_800_000_000_000_000_000;
        let records = (0..129)
            .rev()
            .flat_map(|i| [point(now + i as u64, 0, i), point(now + i as u64, 1, i)])
            .chain([point(1, 0, 7)])
            .collect();
        let result = pack(records, 2, now, 2 * PACKED_BYTES, true).unwrap();
        assert_eq!(result.len(), 5);
        let late = result.iter().find(|p| p.time_unix_nano == 1).unwrap();
        let late = AnalyticalPoint::decode(late.payload.as_slice()).unwrap();
        assert_eq!(late.last_seen_unix_nano, 1);
        for partition in [0, 1] {
            let packets: Vec<Vec<_>> = result
                .iter()
                .filter(|p| p.partition == partition && recent(p.time_unix_nano, now))
                .map(|p| {
                    let mut buf = p.payload.as_slice();
                    std::iter::from_fn(|| {
                        (!buf.is_empty())
                            .then(|| AnalyticalPoint::decode_length_delimited(&mut buf).unwrap())
                    })
                    .collect()
                })
                .collect();
            assert_eq!([packets[0].len(), packets[1].len()], [128, 1]);
            assert_eq!(packets[0][0].first_seen_unix_nano, now + 1);
            assert_eq!(packets[0][0].last_seen_unix_nano, now + 128);
            assert_eq!(packets[0][1].last_seen_unix_nano, 0);
            assert_eq!(packets[0][1].series_id, packets[0][0].series_id);
            assert_eq!(packets[1][0].last_seen_unix_nano, now);
            for (i, point) in packets.into_iter().flatten().enumerate() {
                assert_eq!(point.int_value, Some(128 - i as i64));
            }
        }
    }

    #[test]
    fn framing_is_bounded_and_an_indivisible_point_fails_closed() {
        let now = 1_800_000_000_000_000_000;
        let wide = |size| AnalyticalPoint {
            lineage: recount_telemetry_schema::wire::PointLineage {
                record_id: "a".repeat(size),
                ..Default::default()
            }
            .encode_to_vec(),
            ..point(now, 0, 0)
        };
        let packets = pack(
            vec![wide(PACKED_BYTES / 2), wide(PACKED_BYTES / 2 + 1)],
            1,
            now,
            2 * PACKED_BYTES,
            true,
        )
        .unwrap();
        assert_eq!(packets.len(), 2);
        assert!(packets.iter().all(|p| p.payload.len() <= PACKED_BYTES));
        assert!(pack(vec![wide(PACKED_BYTES)], 1, now, 2 * PACKED_BYTES, true).is_ok());
        assert!(pack(vec![wide(PACKED_BYTES)], 1, now, PACKED_BYTES, true).is_err());
    }
}
