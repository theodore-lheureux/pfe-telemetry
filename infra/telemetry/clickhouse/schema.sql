SET flatten_nested = 1;

CREATE DATABASE IF NOT EXISTS telemetry;

CREATE TABLE IF NOT EXISTS telemetry.batches
(
    project_id String,
    source_id String,
    storage_key String,
    content_digest String,
    record_id String,
    received_ns UInt64,
    created_ns UInt64,
    profile LowCardinality(String),
    client_batch_id String,
    log_topic String,
    log_partition Int32,
    log_offset UInt64,
    payload_hex String,
    points Nested(
        series_id String,
        host_id Nullable(String),
        collection_scope String,
        metric String,
        unit String,
        kind String,
        temporality Int32,
        monotonic Bool,
        time_ns UInt64,
        start_ns UInt64,
        flags UInt32,
        integer_value Nullable(Int64),
        double_value Nullable(Float64),
        cpu_mode Nullable(String)
    )
)
ENGINE = MergeTree
PARTITION BY sipHash64(project_id, source_id) % 16
ORDER BY (project_id, source_id, storage_key, log_offset)
SETTINGS index_granularity = 256, fsync_after_insert = 1, fsync_part_directory = 1;
