#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
use prost::Message;
use recount_telemetry_schema::{ANALYTICAL_COLUMNS, projection, wire::AnalyticalPoint};
use std::io::Write;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--columns") {
        print!("{ANALYTICAL_COLUMNS}");
        return;
    }
    let ordinary = matches!(
        args.get(1).map(String::as_str),
        Some("--ordinary" | "--ordinary-new" | "--ordinary-new-2")
    );
    let mut raw = if ordinary {
        cases::ordinary_cpu_process()
    } else {
        cases::reader_raw()
    };
    match args.get(1).map(String::as_str) {
        Some("--ordinary-new") => raw.batch.as_mut().unwrap().client_id = "native-outage-a".into(),
        Some("--ordinary-new-2") => {
            raw.batch.as_mut().unwrap().client_id = "native-outage-b".into()
        }
        _ => {}
    }
    if args.get(1).map(String::as_str) == Some("--raw") {
        std::io::stdout().write_all(&raw.encode_to_vec()).unwrap();
        return;
    }
    let mut rows = recount_telemetry_validation::validate::raw(&raw, Default::default()).unwrap();
    if args.get(1).map(String::as_str) == Some("--stats") {
        let sizes: Vec<_> = rows
            .iter()
            .map(|r| projection::serialize(r).len())
            .collect();
        println!(
            "{}",
            serde_json::json!({"point_rows":rows.len(),"protobuf_bytes":sizes.iter().sum::<usize>(),"maximum_record_bytes":sizes.iter().max().unwrap()})
        );
        return;
    }
    if args.get(1).map(String::as_str) == Some("--verify") {
        let bytes = std::fs::read(&args[2]).unwrap();
        let mut remaining = bytes.as_slice();
        let mut actual = Vec::new();
        while !remaining.is_empty() {
            actual.push(AnalyticalPoint::decode_length_delimited(&mut remaining).unwrap());
        }
        rows.sort_by(|a, b| a.sample_id.cmp(&b.sample_id));
        actual.sort_by(|a, b| a.sample_id.cmp(&b.sample_id));
        assert_eq!(actual, rows);
        assert_eq!(
            rows.iter()
                .find(|row| row.resource_id == "gpu-a")
                .unwrap()
                .double_value
                .map(f64::to_bits),
            Some((-0.0f64).to_bits())
        );
        for (actual, expected) in actual.iter().zip(&rows) {
            assert_eq!(
                actual.double_value.map(f64::to_bits),
                expected.double_value.map(f64::to_bits)
            );
        }
        println!(
            "generated-field value equality and scalar Float64 bit equality round-trip through pinned ClickHouse"
        );
        return;
    }
    // Multirow file/HTTP interchange uses Protobuf's delimited stream format;
    // Kafka producers send each individual row through ProtobufSingle instead.
    for row in rows {
        std::io::stdout()
            .write_all(&row.encode_length_delimited_to_vec())
            .unwrap();
    }
}
