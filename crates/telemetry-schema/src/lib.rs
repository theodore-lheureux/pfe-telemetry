pub mod ddl;
pub mod execution;
pub mod identity;
pub mod point;
pub mod projection;
pub mod series;
pub const ANALYTICAL_COLUMNS: &str =
    include_str!(concat!(env!("OUT_DIR"), "/analytical-columns.sql"));
pub const PARTICIPANT_COLUMNS: &str =
    include_str!(concat!(env!("OUT_DIR"), "/participant-columns.sql"));
pub const POINT_COLUMNS: &str = include_str!(concat!(env!("OUT_DIR"), "/point-columns.sql"));
pub const POINT_NAMES: &str = include_str!(concat!(env!("OUT_DIR"), "/point-names.sql"));
pub const POINT_SELECT: &str = include_str!(concat!(env!("OUT_DIR"), "/point-select.sql"));
pub const SERIES_SELECT: &str = include_str!(concat!(env!("OUT_DIR"), "/series-select.sql"));
pub const KAFKA_COLUMNS: &str = include_str!(concat!(env!("OUT_DIR"), "/kafka-columns.sql"));
pub const DELIVERY_COLUMNS: &str = include_str!(concat!(env!("OUT_DIR"), "/delivery-columns.sql"));
pub const SERIES_COLUMNS: &str = include_str!(concat!(env!("OUT_DIR"), "/series-columns.sql"));
pub const SERIES_NAMES: &str = include_str!(concat!(env!("OUT_DIR"), "/series-names.sql"));
pub mod wire {
    include!(concat!(env!("OUT_DIR"), "/recount.telemetry.rs"));
}

pub use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest, common::v1 as common,
    metrics::v1 as metrics, resource::v1 as resource,
};
pub const RAW_TOPIC: &str = "recount.metrics.raw";
pub const NORMALIZED_TOPIC: &str = "recount.metrics.normalized-packed";
pub const RAW_RECEIVED_MS_HEADER: &str = "recount-raw-received-ms";
pub const PACKED_POINTS: usize = 128;
pub const PACKED_BYTES: usize = 128 * 1024;
pub const NORMALIZER_GROUP: &str = "recount-normalizer";
pub const CLICKHOUSE_GROUP: &str = "recount-clickhouse";
/// Points outside the recent window, kept apart so they cannot spread one ClickHouse insert
/// across many day partitions.
pub const LATE_TOPIC: &str = "recount.metrics.late";
pub const CLICKHOUSE_LATE_GROUP: &str = "recount-clickhouse-late";
/// How far a point's time may be from the normalizer's clock, either way, and still take
/// the recent topic. A recent insert block then spans at most three day partitions.
pub const RECENT_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

/// Whether a point at `time` belongs on the recent topic when normalized at `now`.
pub fn recent(time: u64, now: u64) -> bool {
    time.abs_diff(now) <= RECENT_WINDOW_NS
}

#[cfg(test)]
mod recent_tests {
    use super::*;

    #[test]
    fn the_recent_window_reaches_one_day_either_way() {
        let now = 1_800_000_000_000_000_000;
        assert!(recent(now, now));
        assert!(recent(now - RECENT_WINDOW_NS, now));
        assert!(recent(now + RECENT_WINDOW_NS, now));
        assert!(!recent(now - RECENT_WINDOW_NS - 1, now));
        assert!(!recent(now + RECENT_WINDOW_NS + 1, now));
        assert!(!recent(1, now));
    }
}
