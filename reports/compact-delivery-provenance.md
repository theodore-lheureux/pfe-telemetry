# Compact delivery provenance trial

The compact layout emits one evidence frame per raw export and replaces the 16-byte `delivery_id` on points with a 32-bit receipt tag. Compressed bytes depend on how many different receipts a merged part spans and how far apart it stores points from the same receipt.

## Short replay

The compact layout used 16% less disk for points plus deliveries in the short replay. Normalizer preparation CPU fell; this run did not establish a ClickHouse CPU improvement.

| Measurement                                                | Before (`b2e05f3`) |       Compact |
| ---------------------------------------------------------- | -----------------: | ------------: |
| Raw exports / points                                       |      480 / 555,840 | 480 / 555,840 |
| Normalized frames carrying delivery evidence               |              5,080 |           480 |
| Encoded delivery evidence, excluding framing and keys      |          456,038 B |     593,170 B |
| Active delivery rows before merges                         |                511 |           480 |
| Active delivery rows after merges                          |                480 |           480 |
| Merged point disk bytes per point                          |              10.85 |          9.05 |
| Merged delivery disk bytes per point                       |              0.060 |         0.064 |
| Merged points + deliveries disk bytes per point            |          **10.91** |      **9.12** |
| Normalizer preparation CPU-s per 1,000 points              |        **0.00560** |   **0.00480** |
| ClickHouse insert CPU-s                                    |               3.86 |          3.97 |
| ClickHouse merge CPU-s, all three tables, part log         |               2.50 |          1.83 |
| ClickHouse merge CPU-s, points + deliveries only, part log |               0.83 |          0.85 |

Both runs used the 1,158-point [collector fixture](../tooling/load/fixtures/collector.json) with 24 source IDs, 20 exports per source, adjusted timestamps, and synthetic trusted raw envelopes. Each request bound 142 resources. Release-build normalizer validation and packing ran offline over identical raw Protobuf bytes. CPU is the median of three runs (user plus system), including file I/O but excluding Kafka. The wire evidence counts are counted before ClickHouse can collapse identical deliveries inside each block. The fixture uses short common request evidence and simple bound resource contexts; total encoded evidence grew because the new bundle records the per-resource scopes explicitly instead of collapsing identical contexts into one key. It does not reproduce Oracle's provenance mix.

ClickHouse 26.8.34.13 consumed the packed frames in 16,000-row blocks through the real insert views with a `Null` input table in place of Kafka. Insert CPU is the container CPU delta; merge CPU uses `system.part_log` after re-enabling merges and optimizing all three tables. The apparent aggregate merge improvement came from `metric_series`, not from the changed tables. Final point counts and a checksum over identities and values matched. The receipt tag measured 0.31 compressed B/point versus 2.10 for the old digest in this fixture; the Oracle baseline digest was 15.9 B/point, so the local disk delta should not be extrapolated directly.

## Long replay

Three simulated collector sources each sent 4,600 exports at one-second event-time cadence. Every export had a distinct server receipt ID, timestamp and client batch ID. Each contained the same 1,158-point collector fixture (142 resources), with source-specific identities and synthetic socket evidence. Both release builds processed the same 13,800 raw records, or 15,980,400 points. The replay ran at full speed rather than waiting one second between exports.

| Measurement                                      |    Before |   Compact |
| ------------------------------------------------ | --------: | --------: |
| Normalizer preparation, user + system CPU-s      |    100.40 |     82.06 |
| Normalizer preparation CPU-s per 1,000 points    |   0.00628 |   0.00514 |
| ClickHouse insert CPU-s                          |     73.30 |     66.10 |
| ClickHouse merge CPU-s, points + deliveries only |     22.51 |     19.25 |
| Merged `metric_points` disk B/point              |     30.65 |     17.17 |
| Merged `deliveries` disk B/point                 |     0.079 |     0.074 |
| **Merged points + deliveries disk B/point**      | **30.73** | **17.24** |
| Active delivery rows before background merges    |    14,128 |    13,800 |
| Merged delivery rows                             |    13,800 |    13,800 |

Normalizer preparation was measured once per layout, including file I/O but excluding Kafka and the ingestion API. ClickHouse received 48,000-point blocks into the same materialized views as the Kafka input. Merges were paused during loading, then enabled and forced for points and deliveries. Merge CPU comes from `system.part_log`; it excludes `metric_series`, whose forced merge hit the local memory ceiling during both runs. Point counts and the checksum over point keys and values matched.

The old `delivery_id` measured **16.07 compressed B/point**, reproducing the near-incompressible column observed on Oracle (15.9 B/point). The long run still does not reproduce Oracle's delivery-table overhead. ClickHouse already collapsed many repeated delivery keys inside the 48,000-point blocks, and this comparison measures fully merged parts, not the bytes held in a live merge backlog.

### Column sizes

Compressed data bytes per retained point, excluding marks and indexes. Table totals above use `system.parts.bytes_on_disk` and include that overhead. Fields with identical rounded sizes are grouped; numbers apply to **each** field listed.

| `metric_points` column                                                                                                                     |  Before | Compact |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------: | ------: |
| `delivery_id`                                                                                                                              | 16.0691 |       — |
| `receipt_tag`                                                                                                                              |       — |  2.5948 |
| `time_unix_nano`                                                                                                                           |  6.1279 |  6.1272 |
| `received_unix_nano`                                                                                                                       |  6.0863 |  6.0830 |
| `resource_continuity`                                                                                                                      |  0.7887 |  0.7887 |
| `point_continuity`                                                                                                                         |  0.2415 |  0.2415 |
| `int_value`                                                                                                                                |  0.2122 |  0.2125 |
| `double_value`                                                                                                                             |  0.2011 |  0.2018 |
| `stream_id`                                                                                                                                |  0.1660 |  0.1660 |
| `metric_name`                                                                                                                              |  0.1393 |  0.1393 |
| `continuity`                                                                                                                               |  0.0666 |  0.0666 |
| `original_position`                                                                                                                        |  0.0591 |  0.0591 |
| `project_id`                                                                                                                               |  0.0587 |  0.0587 |
| `series_id`                                                                                                                                |  0.0389 |  0.0389 |
| `bucket_counts`, `exemplars`, `explicit_bounds`, `negative_counts`, `positive_counts`, `quantile_values`, `quantiles`                      |  0.0356 |  0.0356 |
| `event_day`                                                                                                                                |  0.0180 |  0.0180 |
| `value_kind`                                                                                                                               |  0.0045 |  0.0045 |
| `start_time_unix_nano`                                                                                                                     |  0.0033 |  0.0029 |
| `count`, `flags`, `max`, `min`, `negative_offset`, `positive_offset`, `scale`, `statistics_present`, `sum`, `zero_count`, `zero_threshold` |  0.0028 |  0.0024 |

The random receipt tag occupies 4 uncompressed B/point. It compressed to **2.59 B/point** despite the old digest remaining incompressible. Repeating 4,600 tags costs 18.4 KB, within LZ4's roughly 64 KiB match distance; the same number of 16-byte digests costs 73.6 KB, outside it. Treat 4 B/point as the more conservative planning figure for the random tag.

The merged baseline delivery part was compact, and `system.columns` did not attribute its bytes to individual columns. For the compact layout's merged delivery part, the breakdown was `delivery_evidence` 0.0628 B/point, `received_unix_nano` 0.0069, `receipt_tag` 0.0035, `source_id` 0.000053 and `project_id` 0.000049.

## Receipt tag choice

The tag remains a 32-bit hash, not a counter. It is derived from the trusted raw record ID and is stable on replay. The receipt timestamp alone is not a uniqueness guarantee: concurrent exports can read the same clock value. A normalizer-local per-source counter would not be stable on replay, and batches from a source can span raw Kafka partitions. Kafka offsets do persist, but they are monotonic only within a partition and can reset when the topic is recreated. A counter worth substituting would need a stable sequencer and a defined restart, partition and topic-reset policy; no such counter is used in this trial.
