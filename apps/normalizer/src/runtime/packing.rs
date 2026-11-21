use super::series_cache::{Emission, SeriesCache};
use prost::Message;
use recount_telemetry_schema::{
    PACKED_BYTES, PACKED_POINTS, identity,
    point::{RoutedRecord, normalized_routing_key},
    recent,
    series::{PreparedPoint, ResourceAttributes, SeriesMetadata},
    wire::AnalyticalPoint,
};
use recount_telemetry_validation::transport::{FRAMING_RESERVE, body_fits};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

#[derive(Default)]
struct Packet {
    points: Vec<AnalyticalPoint>,
    // The index of the first frame and its metadata, including the packet bounds.
    series: HashMap<u64, PacketSeries>,
    streams: HashSet<[u8; 32]>,
    bytes: usize,
}

struct PacketSeries {
    index: usize,
    metadata: Arc<SeriesMetadata>,
    resource: Option<Arc<ResourceAttributes>>,
    first: u64,
    last: u64,
}

fn frame_size(point: &AnalyticalPoint, metadata: Option<&SeriesMetadata>) -> usize {
    let len = point.encoded_len()
        + metadata.map_or(0, |row| {
            row.attached_len(
                !point.source_id.is_empty(),
                point.time_unix_nano,
                point.time_unix_nano,
            )
        });
    prost::length_delimiter_len(len) + len
}

impl Packet {
    fn push(
        &mut self,
        point: AnalyticalPoint,
        metadata: Option<Arc<SeriesMetadata>>,
        resource: Option<Arc<ResourceAttributes>>,
        bytes: usize,
    ) {
        if let Some(metadata) = metadata {
            self.series.entry(point.series_id).or_insert(PacketSeries {
                index: self.points.len(),
                metadata,
                resource,
                first: point.time_unix_nano,
                last: point.time_unix_nano,
            });
        }
        if let Some(bounds) = self.series.get_mut(&point.series_id) {
            bounds.first = bounds.first.min(point.time_unix_nano);
            bounds.last = bounds.last.max(point.time_unix_nano);
        }
        self.points.push(point);
        self.bytes += bytes;
    }

    fn finish(self, partition: u32, now: u64, emissions: &mut Vec<Emission>) -> RoutedRecord {
        let time_unix_nano = self.points[0].time_unix_nano;
        let mut payload = Vec::with_capacity(self.bytes);
        for (index, point) in self.points.into_iter().enumerate() {
            if let Some(series) = self.series.get(&point.series_id)
                && series.index == index
            {
                emissions.push(Emission {
                    series: point.series_id,
                    first: series.first,
                    time: series.last,
                    emitted_at: now,
                    lane_partition: partition * 2,
                });
                series
                    .metadata
                    .attach(point, series.resource.as_deref(), series.first, series.last)
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
    let points = points.into_iter().map(|frame| PreparedPoint {
        frame,
        metadata: None,
        resource: None,
    });
    Ok(pack_prepared(
        points,
        partitions,
        now,
        broker_bytes,
        packed_recent,
        None,
        None,
    )
    .map_err(|error| error.reason())?
    .0)
}

#[derive(Default)]
pub(super) struct Emissions {
    pub series: Vec<Emission>,
    pub streams: Vec<Emission<[u8; 32]>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PackError {
    RecordTooLarge,
    Invariant(&'static str),
}

impl PackError {
    fn reason(&self) -> &'static str {
        match self {
            Self::RecordTooLarge => "normalized record exceeds broker budget",
            Self::Invariant(reason) => reason,
        }
    }
}

pub(super) fn pack_prepared(
    points: impl IntoIterator<Item = PreparedPoint>,
    partitions: u32,
    now: u64,
    broker_bytes: usize,
    packed_recent: bool,
    cache: Option<&SeriesCache>,
    stream_cache: Option<&SeriesCache<[u8; 32]>>,
) -> Result<(Vec<RoutedRecord>, Emissions), PackError> {
    let batch_bytes = PACKED_BYTES.min(broker_bytes.saturating_sub(FRAMING_RESERVE));
    let mut pending = BTreeMap::<u32, Packet>::new();
    let mut output = Vec::new();
    let mut emissions = Emissions::default();
    for PreparedPoint {
        frame: mut point,
        metadata,
        resource,
    } in points
    {
        let stream = normalized_routing_key(&point).map_err(PackError::Invariant)?;
        let partition = identity::partition(&stream, partitions)
            .ok_or(PackError::Invariant("positive partition count required"))?;
        let metadata = metadata.unwrap_or_else(|| Arc::new(SeriesMetadata::new(&mut point)));
        let late = !recent(point.time_unix_nano, now);
        let emission = Emission {
            series: point.series_id,
            first: point.time_unix_nano,
            time: point.time_unix_nano,
            emitted_at: now,
            lane_partition: partition * 2 + u32::from(late),
        };
        let emit = cache.is_none_or(|c| c.should_emit(emission));
        let stream_emission = Emission {
            series: stream,
            first: point.time_unix_nano,
            time: point.time_unix_nano,
            emitted_at: now,
            lane_partition: emission.lane_partition,
        };
        let due = stream_cache.is_none_or(|c| c.should_emit(stream_emission));
        let attach = |point: &mut AnalyticalPoint| {
            metadata.restore_continuity(point, resource.as_deref());
            point.stream_evidence = true;
        };
        if !packed_recent || late {
            if due {
                attach(&mut point);
                emissions.streams.push(stream_emission);
            }
            let time_unix_nano = point.time_unix_nano;
            let payload = if emit {
                emissions.series.push(emission);
                metadata
                    .attach(point, resource.as_deref(), time_unix_nano, time_unix_nano)
                    .encode_to_vec()
            } else {
                point.encode_to_vec()
            };
            body_fits(payload.len(), broker_bytes).map_err(|_| PackError::RecordTooLarge)?;
            output.push(RoutedRecord {
                partition,
                time_unix_nano,
                payload,
            });
            continue;
        }
        let packet = pending.entry(partition).or_default();
        if due && !packet.streams.contains(&stream) {
            attach(&mut point);
        }
        let mut bytes = frame_size(
            &point,
            (emit && !packet.series.contains_key(&point.series_id)).then_some(metadata.as_ref()),
        );
        if !packet.points.is_empty()
            && (packet.points.len() == PACKED_POINTS || packet.bytes + bytes > batch_bytes)
        {
            output.push(std::mem::take(packet).finish(partition, now, &mut emissions.series));
            if !point.stream_evidence && due {
                attach(&mut point);
            }
            bytes = frame_size(&point, emit.then_some(metadata.as_ref()));
        }
        body_fits(packet.bytes + bytes, broker_bytes).map_err(|_| PackError::RecordTooLarge)?;
        if point.stream_evidence {
            packet.streams.insert(stream);
            emissions.streams.push(stream_emission);
        }
        packet.push(point, emit.then_some(metadata), resource, bytes);
        // A valid indivisible point larger than the packing target travels alone.
        if packet.bytes >= batch_bytes {
            output.push(std::mem::take(packet).finish(partition, now, &mut emissions.series));
        }
    }
    output.extend(
        pending
            .into_iter()
            .filter(|(_, p)| !p.points.is_empty())
            .map(|(partition, p)| p.finish(partition, now, &mut emissions.series)),
    );
    Ok((output, emissions))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(t: u64, stream: u8, sample: u8) -> AnalyticalPoint {
        AnalyticalPoint {
            project_id: "project".into(),
            source_id: "source".into(),
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
        let mut records: Vec<_> = (0..129)
            .rev()
            .flat_map(|i| [point(now + i as u64, 0, i), point(now + i as u64, 1, i)])
            .chain([point(1, 0, 7)])
            .collect();
        records[0].delivery_request = vec![1, 2, 3];
        let result = pack(records, 2, now, 2 * PACKED_BYTES, true).unwrap();
        assert_eq!(result.len(), 5);
        let late = result.iter().find(|p| p.time_unix_nano == 1).unwrap();
        let late = AnalyticalPoint::decode(late.payload.as_slice()).unwrap();
        assert_eq!(late.last_seen_unix_nano, 1);
        assert!(late.delivery_request.is_empty());
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
            assert_eq!(
                packets
                    .iter()
                    .flatten()
                    .filter(|p| !p.delivery_request.is_empty())
                    .count(),
                usize::from(partition == 0),
            );
            if partition == 0 {
                assert_eq!(packets[0][0].source_id, "source");
            }
            for (i, point) in packets.into_iter().flatten().enumerate() {
                assert_eq!(point.int_value, Some(128 - i as i64));
            }
        }
    }

    #[test]
    fn framing_is_bounded_and_an_indivisible_point_fails_closed() {
        let now = 1_800_000_000_000_000_000;
        let wide = |size| AnalyticalPoint {
            delivery_request: vec![1; size],
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
        let rows = [PreparedPoint {
            frame: wide(PACKED_BYTES),
            metadata: None,
            resource: None,
        }];
        assert!(matches!(
            pack_prepared(rows, 1, now, PACKED_BYTES, true, None, None),
            Err(PackError::RecordTooLarge)
        ));
    }

    #[test]
    fn stream_evidence_is_packet_local_and_only_acknowledged_output_suppresses_it() {
        let now = 1_800_000_000_000_000_000;
        let cache = SeriesCache::new(16, 60);
        let pack = |at| {
            let points = [point(now, 0, 1), point(now + 1, 0, 2), point(now + 2, 2, 3)]
                .into_iter()
                .map(|frame| PreparedPoint {
                    frame,
                    metadata: None,
                    resource: None,
                });
            pack_prepared(points, 1, at, 2 * PACKED_BYTES, true, None, Some(&cache)).unwrap()
        };
        let (records, emissions) = pack(now);
        let mut payload = records[0].payload.as_slice();
        let mut evidence = Vec::new();
        while !payload.is_empty() {
            evidence.push(
                AnalyticalPoint::decode_length_delimited(&mut payload)
                    .unwrap()
                    .stream_evidence,
            );
        }
        // Even streams with no marker arrays need an explicit evidence row.
        assert_eq!(evidence, [true, false, true]);
        assert_eq!(pack(now).1.streams.len(), 2);
        cache.acknowledge(&emissions.streams);
        assert!(pack(now + 1).1.streams.is_empty());
        assert_eq!(pack(now + 60).1.streams.len(), 2);
    }
}
