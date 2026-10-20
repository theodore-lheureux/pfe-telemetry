SET memory_limit = '128MB';
SET threads = 1;
SET temp_directory = '/tmp/duckdb';
SET max_temp_directory_size = '24MB';
CREATE TEMP VIEW measurements AS
SELECT * FROM read_parquet('/data/v1/*.parquet');

CREATE TEMP VIEW metric_rates AS
WITH previous AS (
    SELECT *,
        lag(time_unix_nano) OVER stream AS previous_time,
        lag(value_int) OVER stream AS previous_int,
        lag(value_double) OVER stream AS previous_double
    FROM measurements
    WHERE metric_type = 'sum' AND temporality = 2 AND is_monotonic AND (flags & 1) = 0
    WINDOW stream AS (
        PARTITION BY project_id, source_id, resource_attributes_json, resource_schema_url,
            scope_name, scope_version, scope_attributes_json, metric_schema_url,
            metric_name, unit, point_attributes_json, start_time_unix_nano
        ORDER BY time_unix_nano
    )
)
SELECT *,
    CASE
        WHEN time_unix_nano > previous_time AND value_int >= previous_int
            THEN (value_int::HUGEINT - previous_int::HUGEINT)::DOUBLE /
                ((time_unix_nano - previous_time)::DOUBLE / 1e9)
        WHEN time_unix_nano > previous_time AND value_double >= previous_double
            THEN (value_double - previous_double) /
                ((time_unix_nano - previous_time)::DOUBLE / 1e9)
    END AS rate_per_second
FROM previous;
