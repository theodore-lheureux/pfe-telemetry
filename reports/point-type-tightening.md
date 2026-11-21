# Narrower analytical point types

The type changes reduced compressed point data from **2.792 to 2.124 B/point (24%)** in a local collector replay. The largest savings came from the 16-byte stream ID and the point table's dictionary-encoded project and metric names. The trial did not establish a repeatable CPU improvement.

## Local comparison

Each run replayed 900 synthetic raw exports (12 sources, 75 exports each, 1,158 points per export) through a release normalizer and ClickHouse 26.8.34.13. The six runs alternated baseline (`05620f0`) and narrowed types. ClickHouse used one consumer per lane; all frames took the recent lane. The point value and stable-key checksum, dimension checksum, and distinct stream count matched. The replay used one project and fixed metric cardinality; it did not exercise high-cardinality dictionaries or late traffic.

| Pair | Compressed B/point | ClickHouse ingest CPU-s | MV CPU-s      | Merge CPU-s   | Normalizer CPU-s |
| ---- | ------------------ | ----------------------- | ------------- | ------------- | ---------------- |
| 1    | 2.793 → 2.124      | 8.229 → 10.573          | 1.481 → 1.090 | 0.619 → 0.442 | 2.750 → 3.020    |
| 2    | 2.792 → 2.123      | 5.479 → 3.611           | 1.239 → 1.078 | 0.421 → 0.429 | 3.000 → 3.040    |
| 3    | 2.791 → 2.124      | 5.538 → 4.501           | 1.289 → 1.499 | 0.397 → 0.395 | 3.050 → 2.580    |

Point bytes are compressed data bytes, not bytes on disk including indexes and marks. Ingest CPU is the ClickHouse container CPU delta with trial merges paused; it includes Kafka decoding, MV work and shared-service activity. Reader tests overlapped the first pair, so its container CPU is not an isolated ingest result. MV and merge CPU are database-scoped sums from `system.query_views_log` and `system.part_log`. Merges ran after ingest until quiet, not according to a fixed compaction schedule. Normalizer CPU is the process's user plus system time.

## Compressed bytes per point by column

Values are medians across three runs. Grouped values apply to each column.

| Column                                                                                                                                     | Baseline | Narrow types |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------: | -----------: |
| `stream_id`                                                                                                                                |  0.64549 |      0.34569 |
| `project_id`                                                                                                                               |  0.21192 |      0.00491 |
| `metric_name`                                                                                                                              |  0.13963 |      0.00529 |
| `original_position`                                                                                                                        |  0.16430 |            — |
| `original_resource`                                                                                                                        |        — |      0.07365 |
| `original_scope`                                                                                                                           |        — |      0.00134 |
| `original_metric`                                                                                                                          |        — |      0.01838 |
| `original_point`                                                                                                                           |        — |      0.04354 |
| `double_value`                                                                                                                             |  0.42047 |      0.42015 |
| `int_value`                                                                                                                                |  0.42449 |      0.42450 |
| `series_id`                                                                                                                                |  0.17940 |      0.17944 |
| `time_unix_milli`                                                                                                                          |  0.16885 |      0.16896 |
| `raw_offset`                                                                                                                               |  0.10133 |      0.10145 |
| `raw_partition`                                                                                                                            |  0.04757 |      0.04756 |
| `bucket_counts`, `exemplars`, `explicit_bounds`, `negative_counts`, `positive_counts`, `quantile_values`, `quantiles`                      |  0.03564 |      0.03567 |
| `event_day`                                                                                                                                |  0.01802 |      0.01802 |
| `value_kind`                                                                                                                               |  0.00447 |      0.00447 |
| `start_time_unix_nano`                                                                                                                     |  0.00180 |      0.00180 |
| `count`, `flags`, `max`, `min`, `negative_offset`, `positive_offset`, `scale`, `statistics_present`, `sum`, `zero_count`, `zero_threshold` |  0.00133 |      0.00134 |

Use 128 bits rather than 64 because `stream_id` is also a continuity join key and part of the point replacement key. A collision could attach another stream's evidence or collapse observations. One billion distinct streams in one project gives about 2.7% probability of any accidental 64-bit collision, versus about 1.5 × 10⁻²¹ at 128 bits. Output partition affinity still uses the first eight bytes. Keep project IDs as strings at the wire boundary; dictionary encoding changes storage, not the project ID contract. Recreate disposable normalized topics and analytical tables together. Raw input is unchanged.
