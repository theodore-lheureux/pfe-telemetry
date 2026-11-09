pub mod identity;
pub mod point;
pub mod projection;
pub const ANALYTICAL_COLUMNS: &str =
    include_str!(concat!(env!("OUT_DIR"), "/analytical-columns.sql"));
pub mod wire {
    include!(concat!(env!("OUT_DIR"), "/recount.telemetry.rs"));
}

pub use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest, common::v1 as common,
    metrics::v1 as metrics, resource::v1 as resource,
};
pub const RAW_TOPIC: &str = "recount.metrics.raw";
pub const NORMALIZED_TOPIC: &str = "recount.metrics.normalized";
pub const NORMALIZER_GROUP: &str = "recount-normalizer";
pub const CLICKHOUSE_GROUP: &str = "recount-clickhouse";
