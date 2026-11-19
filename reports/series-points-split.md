# ClickHouse metric storage trial

The split stores series dimensions and delivery provenance separately from measurements. Points replace older receipts by series, event timestamp and stream, while readers retain the newest receipt before merges finish. See the [cutover runbook](../infra/oracle-stack/README.md#cut-over-to-split-metric-storage) and [Kafka recovery guide](../docs/kafka-recovery.md#replay-metric-data-after-a-hard-vm-crash).

## Deduplication at 31.8 million points

The local ClickHouse 26.8.34.13 fixture contained 31,802,709 physical rows, including 314,709 newer receipts with changed values, across six event-day partitions and 102 unmerged parts. Queries used the web compiler and its series-to-points join. The table shows median wall-clock latency in milliseconds from six timed reads per variant after warm-up, using one thread, a 256 MiB query limit and 1,024-row read blocks.

| Query                                             | Global `FINAL` | Partition-local `FINAL` | Unordered `LIMIT 1 BY` | Receipt-ordered `LIMIT 1 BY` |
| ------------------------------------------------- | -------------: | ----------------------: | ---------------------: | ---------------------------: |
| One-day gauge, four nodes                         |            268 |                      58 |                     57 |                           58 |
| Six-day counter rate, four nodes                  |            357 |                     371 |                    299 |        Exceeded memory limit |
| Six-day attribute filter and grouping, four nodes |            236 |                     231 |                    194 |                          210 |

Both `FINAL` variants matched on the measured queries. Unordered `LIMIT 1 BY` is not equivalent: an independent full-day gauge sum returned **434,928,000** instead of **434,973,507**, keeping older receipts. The three timed queries happened to match in that run; that does not guarantee which row survives. Keep partition-local `FINAL`: it substantially reduces the daily-query cost without relying on input order or a global receipt sort. An exploratory broader query also hit the memory cap; these are not capacity guarantees for arbitrary dashboard ranges.

## Storage and insert cost

The 600,000-point fixture used 10 nodes, 139 resources per node and 14 metric slots. Packed fixture inserts into local input views isolate ClickHouse format decoding, insertion and merges; they exclude Kafka and normalizer CPU. All five dashboard queries matched the wide baseline within floating-point tolerance. The delivered metric-first 1024 layout was faster than series-first and time-first on those queries.

| Trial                                           | Insert CPU-s | Merge CPU-s |       Final disk |
| ----------------------------------------------- | -----------: | ----------: | ---------------: |
| Original split, wide 1024 reference             |         4.79 |        1.88 |         155.0 MB |
| Original split, narrow 1024 / 4096              |  3.94 / 3.70 | 1.62 / 1.38 | 192.5 / 188.0 MB |
| Delivery fixture, wide 1024 reference           |         4.86 |        2.07 |         269.6 MB |
| Delivery fixture, metric-first split 1024       |         2.36 |        1.14 |          35.7 MB |
| Tuned merge blocks, before / after strict types |  2.78 / 2.84 | 1.12 / 1.13 | 35.72 / 35.51 MB |

The fixtures differ: the delivery fixture uses pseudorandom legacy sample IDs and groups receipts into 128-point submissions. Its wide lineage costs 394 compressed B/point, versus about 41 B/point observed on Oracle, so do not extrapolate the 87% disk reduction. The delivery split removed 32.14 B/point of sample IDs. Its metric-first binary delivery reference costs 10.49 B/point versus 1.35 B with time-first ordering. The final metric-first point part has 191 files versus 329 for wide; total rows rewritten were 1.33M versus 1.20M. Strict types preserved missing values and saved 0.6% disk without a CPU win. Series LowCardinality saved 13.5 KB but did not consistently improve query p95. See the [delivery columns](series-points-delivery-columns.tsv) and [strict type comparison](series-points-strict-columns.tsv) for per-column measurements.

## Compression

Default LZ4 remains the default. Event-time DoubleDelta saved 29% of point-table bytes but raised insert CPU 21%. Delta+ZSTD on start time, Gorilla on gauges and DoubleDelta or T64+ZSTD on counters did not improve combined insert and merge CPU. An 8 MiB server rule kept fresh parts on LZ4 and used ZSTD(1) after merging; it saved 2.4% total space without a measured merge CPU win. A sparse-value probe preserved missing versus present zero with an explicit presence bit. A separate attribute `Variant` probe compressed to 1,648 B versus 7,251 B for typed value slots, but did not measure native ingestion or nested-query latency; the typed slots remain.
