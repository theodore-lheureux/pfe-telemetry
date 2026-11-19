#[path = "../src/runtime/packing.rs"]
mod packing;

use prost::Message;
use recount_telemetry_schema::{
    identity::TypedHash,
    wire::{AnalyticalPoint, AttributeNode, PointLineage, Position},
};
use std::{
    fs,
    io::{BufWriter, Write},
    path::PathBuf,
};

const ROWS: u64 = 600_000;
const BATCH: u64 = 16_000;
const START: u64 = 1_797_600_000_000_000_000;

fn attribute(path: &str, value: &str) -> AttributeNode {
    AttributeNode {
        path: path.into(),
        kind: 2,
        string_value: Some(value.into()),
        ..Default::default()
    }
}

fn lineage() -> Vec<Vec<u8>> {
    // Match the profile's 48 shared, incompressible 1,100-byte lineage bodies.
    let mut state = 7u64;
    (0..48)
        .map(|_| {
            let body: Vec<_> = (0..1100)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state as u8
                })
                .collect();
            body
        })
        .collect()
}

fn main() -> std::io::Result<()> {
    let dir = PathBuf::from(std::env::args_os().nth(1).expect("new output directory"));
    fs::create_dir(&dir)?;
    let codec_fixture = std::env::args().nth(2).as_deref() == Some("codecs");
    let lineage = lineage();
    let attributes = [
        ("/host.arch", "arm64"),
        ("/process.executable.name", "synthetic-worker"),
        ("/process.command", "synthetic-worker"),
        ("/os.type", "linux"),
    ]
    .map(|(key, value)| attribute(key, value))
    .to_vec();
    for offset in (0..ROWS).step_by(BATCH as usize) {
        let mut wide = BufWriter::new(fs::File::create(dir.join(format!("{offset:06}-wide.pb")))?);
        let mut split =
            BufWriter::new(fs::File::create(dir.join(format!("{offset:06}-split.pb")))?);
        let mut rows = Vec::new();
        for i in offset..(offset + BATCH).min(ROWS) {
            let node = format!("node-{}", i % 10);
            let resource = (i / 10) % 139;
            let metric = (i / 1390) % 14;
            let (name, counter, process) = match metric {
                0 => (
                    "recount.collection.discovered.processes".into(),
                    false,
                    false,
                ),
                1 | 2 => ("system.disk.io".into(), true, false),
                _ => (format!("bench.process.metric.{metric}"), false, true),
            };
            // Preserve the profile's resource cardinality; for disk tiles the two
            // metric slots represent the same metric with different directions.
            let direction = if metric == 1 { "read" } else { "write" };
            let mut sample = TypedHash::new("bench.sample");
            sample.u64(i);
            let mut point = AnalyticalPoint {
                project_id: "synthetic-wire".into(),
                source_id: node.clone(),
                host_id: Some(node),
                resource_id: format!("proc-{resource}"),
                resource_kind: if process { 4 } else { 1 },
                metric_name: name,
                unit: if metric == 0 { "1" } else { "By" }.into(),
                metric_kind: if counter { 2 } else { 1 },
                temporality: if counter { 2 } else { 0 },
                monotonic: counter.then_some(true),
                scope_name: "recount.collector".into(),
                resource_present: true,
                scope_present: true,
                time_unix_nano: START + i * 1_000_000,
                event_day: ((START + i * 1_000_000) / 86_400_000_000_000) as u32,
                sample_id: sample.finish().to_vec(),
                stream_id: [
                    vec![0; 24],
                    (i % 19_460 + 19_460 * u64::from(counter && i >= ROWS / 2))
                        .to_be_bytes()
                        .to_vec(),
                ]
                .concat(),
                double_value: Some(if counter {
                    (i / 19_460 % 16) as f64 * 50.0
                } else {
                    (i % 501) as f64
                }),
                resource_attributes: attributes.clone(),
                point_attributes: if counter {
                    vec![
                        attribute("/disk.io.direction", direction),
                        attribute(
                            "/recount.counter.segment_id",
                            if i < ROWS / 2 { "before" } else { "after" },
                        ),
                    ]
                } else {
                    vec![attribute("/cpu.mode", "user")]
                },
                lineage: PointLineage {
                    original: Some(Position {
                        point: (i % 128) as u32,
                        ..Default::default()
                    }),
                    record_id: format!("bench-{}", i / 128),
                    received_unix_nano: START + (i / 128) * 128_000_000,
                    // Hex preserves valid protobuf UTF-8; take half to keep a ~1.1 KiB body.
                    batch: Some(recount_telemetry_schema::wire::BatchIdentity {
                        client_id: recount_telemetry_schema::identity::hex(
                            &lineage[(i / 128 % 48) as usize][..550],
                        ),
                        ..Default::default()
                    }),
                    ..Default::default()
                }
                .encode_to_vec(),
                ..Default::default()
            };
            if codec_fixture && counter {
                point.int_value = point.double_value.take().map(|value| value as i64);
                point.start_time_unix_nano =
                    START - 1_000_000_000 + 300_000_000_000 * u64::from(i >= ROWS / 2);
            }
            wide.write_all(&point.encode_length_delimited_to_vec())?;
            rows.push(point);
        }
        for packet in packing::pack(rows, 3, START, 2 * 1024 * 1024, true).expect("packed fixture")
        {
            split.write_all(&packet.payload)?;
        }
        wide.flush()?;
        split.flush()?;
    }
    Ok(())
}
