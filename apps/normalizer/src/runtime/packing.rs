use prost::{encode_length_delimiter, length_delimiter_len};
use recount_telemetry_schema::{
    PACKED_BYTES as BYTES, PACKED_POINTS as POINTS, point::RoutedRecord, recent,
};
use recount_telemetry_validation::transport::{FRAMING_RESERVE, body_fits};
use std::collections::BTreeMap;

pub(super) fn pack_recent(
    records: Vec<RoutedRecord>,
    now: u64,
    broker_bytes: usize,
) -> Result<Vec<RoutedRecord>, &'static str> {
    let batch_bytes = BYTES.min(broker_bytes.saturating_sub(FRAMING_RESERVE));
    let mut pending = BTreeMap::<u32, (RoutedRecord, usize)>::new();
    let mut output = Vec::new();
    let empty = |partition, time_unix_nano| RoutedRecord {
        partition,
        time_unix_nano,
        payload: Vec::new(),
    };
    for record in records {
        if !recent(record.time_unix_nano, now) {
            output.push(record);
            continue;
        }
        let bytes = length_delimiter_len(record.payload.len()) + record.payload.len();
        body_fits(bytes, broker_bytes)?;
        // A valid wide point that cannot fit the packing target travels alone.
        if bytes > batch_bytes {
            if let Some((packet, _)) = pending.remove(&record.partition) {
                output.push(packet);
            }
            let mut packet = empty(record.partition, record.time_unix_nano);
            encode_length_delimiter(record.payload.len(), &mut packet.payload)
                .map_err(|_| "could not encode the point length")?;
            packet.payload.extend_from_slice(&record.payload);
            output.push(packet);
            continue;
        }
        let (packet, count) = pending
            .entry(record.partition)
            .or_insert_with(|| (empty(record.partition, record.time_unix_nano), 0));
        if *count == POINTS || packet.payload.len() + bytes > batch_bytes {
            output.push(std::mem::replace(
                packet,
                empty(record.partition, record.time_unix_nano),
            ));
            *count = 0;
        }
        encode_length_delimiter(record.payload.len(), &mut packet.payload)
            .map_err(|_| "could not encode the point length")?;
        packet.payload.extend_from_slice(&record.payload);
        *count += 1;
    }
    output.extend(pending.into_values().map(|(packet, _)| packet));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::decode_length_delimiter;

    fn packet(partition: u32, time_unix_nano: u64, payload: Vec<u8>) -> RoutedRecord {
        RoutedRecord {
            partition,
            time_unix_nano,
            payload,
        }
    }

    fn frames(mut data: &[u8]) -> Vec<&[u8]> {
        let mut rows = Vec::new();
        while !data.is_empty() {
            let size = decode_length_delimiter(&mut data).unwrap();
            let (point, rest) = data.split_at(size);
            rows.push(point);
            data = rest;
        }
        rows
    }

    #[test]
    fn pack_flushes_partials_preserves_order_and_never_mixes_lanes_or_partitions() {
        let now = 1_800_000_000_000_000_000;
        let records = (0..129)
            .flat_map(|i| [packet(0, now, vec![i]), packet(1, now, vec![i, 255])])
            .chain([packet(0, 1, vec![73])])
            .collect();
        let result = pack_recent(records, now, 2 * BYTES).unwrap();
        assert_eq!(result.len(), 5);
        let late: Vec<_> = result
            .iter()
            .filter(|p| !recent(p.time_unix_nano, now))
            .collect();
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].payload, [73]);
        for partition in [0, 1] {
            let packets: Vec<_> = result
                .iter()
                .filter(|p| p.partition == partition && recent(p.time_unix_nano, now))
                .map(|p| frames(&p.payload))
                .collect();
            assert_eq!([packets[0].len(), packets[1].len()], [128, 1]);
            for (i, bytes) in packets.into_iter().flatten().enumerate() {
                let expected = if partition == 0 {
                    vec![i as u8]
                } else {
                    vec![i as u8, 255]
                };
                assert_eq!(bytes, expected);
            }
        }
    }

    #[test]
    fn encoded_size_includes_framing_and_an_indivisible_point_fails_closed() {
        let now = 1_800_000_000_000_000_000;
        let result = pack_recent(
            (0..2).map(|_| packet(0, now, vec![0; BYTES / 2])).collect(),
            now,
            2 * BYTES,
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|p| p.payload.len() <= BYTES));
        let wide = pack_recent(vec![packet(0, now, vec![0; BYTES])], now, 2 * BYTES).unwrap();
        assert_eq!(frames(&wide[0].payload)[0].len(), BYTES);
        assert!(pack_recent(vec![packet(0, now, vec![0; BYTES])], now, BYTES).is_err());
    }
}
