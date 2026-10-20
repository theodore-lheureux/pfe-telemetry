mod common;
use common::*;
use parquet::{
    file::reader::{FileReader, SerializedFileReader},
    record::RowAccessor,
};
use pfe_server::storage::Store;
use std::fs::{self, File};
use uuid::Uuid;

#[test]
fn publication_survives_restart_and_replay_without_precision_loss() {
    let directory = Directory::new();
    let envelope = envelope();
    let store = Store::open(&directory.0).unwrap();
    assert!(store.publish(&envelope).unwrap());
    assert!(!store.publish(&envelope).unwrap());
    assert!(Store::open(&directory.0).is_err());
    drop(store);
    let store = Store::open(&directory.0).unwrap();
    let mut replay = envelope.clone();
    replay.record_id = Uuid::now_v7().to_string();
    replay.received_unix_nano += 100;
    assert!(!store.publish(&replay).unwrap());
    assert_eq!(directory.files().len(), 1);
    let reader = SerializedFileReader::new(File::open(&directory.files()[0]).unwrap()).unwrap();
    assert_eq!(reader.metadata().file_metadata().num_rows(), 1);
    let row = reader.get_row_iter(None).unwrap().next().unwrap().unwrap();
    assert_eq!(row.get_ulong(28).unwrap(), u64::MAX - 1);
    assert_eq!(row.get_long(31).unwrap(), 9_007_199_254_740_993);
    assert!(row.get_double(32).is_err());
    assert_eq!(row.get_string(1).unwrap(), "trusted-project");
    assert_eq!(row.get_string(22).unwrap(), "pfe.node.memory.total");
    assert_eq!(row.get_string(24).unwrap(), "By");
    assert_eq!(row.get_string(3).unwrap(), &envelope.record_id);
}

#[test]
fn conflicts_and_storage_errors_preserve_first_batch() {
    let directory = Directory::new();
    let store = Store::open(&directory.0).unwrap();
    let envelope = envelope();
    store.publish(&envelope).unwrap();
    let first_path = directory.files()[0].clone();
    let original = fs::read(&first_path).unwrap();
    let mut changed = envelope.clone();
    changed.payload.push(0);
    assert!(store.publish(&changed).is_err());
    assert_eq!(fs::read(&first_path).unwrap(), original);
    changed = envelope.clone();
    changed.client_created_unix_nano += 1;
    assert!(store.publish(&changed).is_err());
    changed = envelope.clone();
    changed.source_id = "another-source".into();
    assert!(store.publish(&changed).unwrap());
    changed = envelope.clone();
    changed.client_batch_id = Uuid::now_v7().to_string();
    fs::create_dir(
        directory
            .0
            .join(format!("{}.parquet", changed.storage_key())),
    )
    .unwrap();
    assert!(store.publish(&changed).is_err());
    assert_eq!(fs::read(&first_path).unwrap(), original);
}

#[test]
fn incomplete_files_are_invisible_and_cleaned_after_restart() {
    let directory = Directory::new();
    let path = directory.0.join(".pending-interrupted.tmp");
    fs::write(&path, b"incomplete parquet").unwrap();
    assert!(directory.files().is_empty());
    let store = Store::open(&directory.0).unwrap();
    assert!(!path.exists());
    let mut envelope = envelope();
    envelope.format_version = 2;
    assert!(store.publish(&envelope).is_err());
    assert!(directory.files().is_empty());
}

#[test]
fn native_histograms_and_missing_values_survive_storage() {
    use opentelemetry_proto::tonic::metrics::v1::{Histogram, HistogramDataPoint, Metric, metric};
    use prost::Message;
    let directory = Directory::new();
    let store = Store::open(&directory.0).unwrap();
    let mut body = request();
    let Some(metric::Data::Gauge(gauge)) =
        &mut body.resource_metrics[0].scope_metrics[0].metrics[0].data
    else {
        panic!()
    };
    gauge.data_points[0].value = None;
    gauge.data_points[0].flags = 1;
    let point = HistogramDataPoint {
        time_unix_nano: 42,
        count: 5,
        sum: Some(9.0),
        bucket_counts: vec![2, 3],
        explicit_bounds: vec![1.0],
        ..Default::default()
    };
    body.resource_metrics[0].scope_metrics[0]
        .metrics
        .push(Metric {
            name: "request.duration".into(),
            unit: "ms".into(),
            data: Some(metric::Data::Histogram(Histogram {
                aggregation_temporality: 1,
                data_points: vec![point.clone()],
            })),
            ..Default::default()
        });
    let source = policy()
        .authenticate(export(body.clone(), "").metadata())
        .unwrap();
    assert_eq!(
        pfe_server::metrics::validate(&body, &source, false).unwrap(),
        2
    );
    let mut envelope = envelope();
    envelope.payload = body.encode_to_vec();
    store.publish(&envelope).unwrap();
    let reader = SerializedFileReader::new(File::open(&directory.files()[0]).unwrap()).unwrap();
    let mut rows = reader.get_row_iter(None).unwrap();
    let missing = rows.next().unwrap().unwrap();
    assert!(missing.get_long(31).is_err());
    let histogram = rows.next().unwrap().unwrap();
    assert_eq!(histogram.get_string(25).unwrap(), "histogram");
    assert_eq!(histogram.get_int(26).unwrap(), 1);
    assert_eq!(
        HistogramDataPoint::decode(histogram.get_bytes(41).unwrap().data()).unwrap(),
        point
    );
}

#[cfg(unix)]
#[test]
fn new_storage_directories_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    let path = directory.0.join("measurements").join("v1");
    let _store = Store::open(&path).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
