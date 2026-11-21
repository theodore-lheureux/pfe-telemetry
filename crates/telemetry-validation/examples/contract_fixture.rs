#[allow(dead_code)]
#[path = "../../../tests/fixtures/telemetry/cases.rs"]
mod cases;
use prost::Message;
use recount_telemetry_schema::{ANALYTICAL_COLUMNS, projection, wire::AnalyticalPoint};
use std::io::Write;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--storage-layout") {
        use recount_telemetry_schema::{
            DELIVERY_COLUMNS, DELIVERY_CONTEXT_COLUMNS, KAFKA_COLUMNS, POINT_COLUMNS, POINT_NAMES,
            POINT_SELECT, SERIES_COLUMNS, SERIES_NAMES, SERIES_SELECT, STREAM_COLUMNS,
        };
        println!(
            "{}",
            serde_json::json!({ "pointColumns": POINT_COLUMNS, "pointNames": POINT_NAMES,
            "seriesColumns": SERIES_COLUMNS, "seriesNames": SERIES_NAMES,
            "deliveryColumns": DELIVERY_COLUMNS, "deliveryContextColumns": DELIVERY_CONTEXT_COLUMNS, "streamColumns": STREAM_COLUMNS, "kafkaColumns": KAFKA_COLUMNS, "pointSelect": POINT_SELECT, "seriesSelect": SERIES_SELECT })
        );
        return;
    }
    if args.get(1).map(String::as_str) == Some("--participant-columns") {
        print!("{}", recount_telemetry_schema::PARTICIPANT_COLUMNS);
        return;
    }
    if args.get(1).map(String::as_str) == Some("--columns") {
        print!("{ANALYTICAL_COLUMNS}");
        return;
    }
    let ordinary = matches!(
        args.get(1).map(String::as_str),
        Some("--ordinary" | "--ordinary-new" | "--ordinary-new-2" | "--browser")
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
    if matches!(
        args.get(1).map(String::as_str),
        Some("--browser" | "--storage" | "--ordinary-new" | "--ordinary-new-2" | "--verify")
    ) {
        let compact =
            recount_telemetry_validation::validate::retained_delivery(&raw, Default::default())
                .unwrap();
        let request = compact[0].delivery_request.clone();
        let context = compact[0].delivery_context.clone();
        let context_id = compact[0].delivery_context_id.clone();
        let (received, oldest, newest) = (
            compact[0].received_unix_nano,
            compact[0].min_event_unix_milli,
            compact[0].max_event_unix_milli,
        );
        for (row, compact) in rows.iter_mut().zip(compact) {
            row.sample_id.clear();
            row.lineage.clear();
            row.delivery_request = request.clone();
            row.delivery_context = context.clone();
            row.delivery_context_id = context_id.clone();
            row.original_resource = compact.original_resource;
            row.original_scope = compact.original_scope;
            row.original_metric = compact.original_metric;
            row.original_point = compact.original_point;
            row.received_unix_nano = received;
            row.min_event_unix_milli = oldest;
            row.max_event_unix_milli = newest;
        }
    }
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
        for row in &mut rows {
            // The raw fixture can set a device; analytical storage does not persist it.
            row.device_id = None;
            row.resource_attributes.sort_by(|a, b| a.path.cmp(&b.path));
            row.point_attributes.sort_by(|a, b| a.path.cmp(&b.path));
        }
        let key = |point: &AnalyticalPoint| (point.time_unix_milli, point.stream_id.clone());
        rows.sort_by_key(key);
        actual.sort_by_key(key);
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
    // Recent Kafka messages use the same delimiters; late messages are bare rows.
    for row in rows {
        std::io::stdout()
            .write_all(&row.encode_length_delimited_to_vec())
            .unwrap();
    }
}
