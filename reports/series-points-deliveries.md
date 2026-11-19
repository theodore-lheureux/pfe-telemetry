# Series, points and delivery evidence trial

At granularity 1024, metric-first storage halved ClickHouse insert and merge CPU and cut the synthetic footprint by 87% compared with the original wide schema. It also gave the best overall query results: the two metric-first variants consistently beat time-first and series-first. The size reduction is specific to this fixture, whose baseline lineage compresses to 394 B per point, not the approximately 41 B measured on Oracle.

## Storage

| Layout                              | Insert CPU-s | Merge CPU-s | Merge rows read / written | Final bytes on disk | Files per final point part |
| ----------------------------------- | -----------: | ----------: | ------------------------: | ------------------: | -------------------------: |
| Wide                                |         4.86 |        2.07 |     1,202,706 / 1,200,156 |         269,592,706 |                        329 |
| Metric first                        |         2.36 |        1.14 |     1,913,220 / 1,332,680 |          35,722,095 |                        191 |
| Series first                        |         2.80 |        1.28 |     1,913,220 / 1,332,680 |          40,709,036 |                        191 |
| Time first                          |         2.63 |        1.08 |     1,913,220 / 1,332,680 |          36,646,602 |                        191 |
| Metric first, LowCardinality metric |         2.54 |        1.14 |     1,913,220 / 1,332,680 |          35,636,231 |                        191 |

[Per-column compressed bytes](series-points-delivery-columns.tsv) are divided by the 600,000 input measurements, including for side tables. ClickHouse does not attribute compact-part data to individual columns in `system.columns`; zero entries for the wide layout's discovery parts are not evidence that the columns consume no space.

The 32.14 B/sample digest disappeared. For metric-first, the point delivery reference cost 10.49 B/point, not the ~1 B initially expected: sorting by series separates measurements from the same delivery. Time-first brought it down to 1.35 B but read more for metric-filtered queries. The separate delivery table uses about 37.27 B/point in this fixture (46,880 distinct delivery contexts). Its event-independent key groups by project and a fixed 16-byte binary digest; project/source permit non-UUID identifiers and remain strings.

Keep metric-first with plain strings. `LowCardinality` lowered compressed metric column bytes from 0.147 to 0.007 B/point across the two tables, but saved only 0.24% of total space and raised observed insert CPU. Series IDs and nanosecond timestamps are native `UInt64`. Event days need `UInt32` for the full timestamp range; flags/dropped counts are full OTLP `UInt32`. Nullable scalar, histogram and attribute fields distinguish absence from zero, empty or false. Optional host/device, monotonicity and continuity keep their null semantics; no unmeasured sentinel conversions were applied.

## Query latency

Milliseconds, p50 / p95. All results matched, with Float64 calculations compared to 12 significant digits.

| Query                        |     Wide | Metric first | Series first | Time first | Metric first LC |
| ---------------------------- | -------: | -----------: | -----------: | ---------: | --------------: |
| Node health: processes       |  29 / 33 |      15 / 18 |      26 / 30 |    27 / 32 |         14 / 16 |
| Node health: disk read rate  |  59 / 65 |      27 / 34 |      38 / 41 |    40 / 44 |         25 / 31 |
| Node health: disk write rate |  57 / 61 |      25 / 27 |      36 / 44 |    37 / 42 |         24 / 29 |
| Disk rate by direction       | 72 / 126 |      31 / 47 |      44 / 67 |    46 / 89 |         31 / 56 |
| Execution filter and group   |  33 / 35 |      18 / 20 |      29 / 32 |    30 / 32 |         17 / 21 |

## Method

The [first trial](series-points-split.md) describes the isolated ClickHouse container and benchmark commands. Rerun them with the current fixture and harness to reproduce this comparison. The updated fixture uses pseudorandom 32-byte legacy sample IDs and groups provenance into batches of 128 measurements across 10 source identities. The benchmark uses actual views over local `Null` stand-ins for Kafka tables, merges after loading, then measures 20 queries per variant after warm-up. CPU figures exclude Kafka and the normalizer and do not represent sustained ingestion. The Kafka path was checked separately with a packed replay that joined stored points, series and delivery references.

## Codecs

Keep default LZ4. On the metric-first layout, no tested codec lowered the combined measured insert and merge CPU. Time DoubleDelta saved the most space, but increased insert CPU by 21%. Gorilla increased both CPU and final size. Every variant produced the same checksum over all 600,000 stored points.

| Variant                            | Insert CPU-s | Merge CPU-s (`part_log`) | Merge CPU-s (container) | Final point bytes | Final total bytes |
| ---------------------------------- | -----------: | -----------------------: | ----------------------: | ----------------: | ----------------: |
| Default LZ4                        |         2.31 |                     1.27 |                    1.51 |        12,335,839 |        35,745,035 |
| Event time: DoubleDelta + LZ4      |         2.80 |                     1.20 |                    1.33 |         8,780,375 |        32,189,571 |
| Start time: Delta + ZSTD(1)        |         2.82 |                     1.19 |                    1.32 |        12,317,495 |        35,726,691 |
| Double gauge: Gorilla + LZ4        |         2.80 |                     1.37 |                    1.70 |        12,703,117 |        36,112,313 |
| Integer counter: DoubleDelta + LZ4 |         2.77 |                     1.43 |                    1.69 |        12,319,550 |        35,728,746 |
| Integer counter: T64 + ZSTD(1)     |         2.57 |                     1.51 |                    1.73 |        12,319,751 |        35,728,947 |
| Server rule: ZSTD(1) from 8 MiB    |         3.90 |                     1.39 |                    1.53 |        11,485,038 |        34,894,234 |

The codec fixture uses integer counters with nonzero start times and double gauges. Each explicit treatment changes one column; IDs keep default LZ4. The [server rule](../tooling/clickhouse-compression-trial.xml) ran in a separate container: `system.parts` reported LZ4 for every fresh point part and ZSTD(1) for the final point part. Fresh point bytes were identical to control; the higher observed insert CPU on the separately started server is not evidence of extra ZSTD work on fresh point parts. The rule saved 2.4% total space and did not show a merge CPU win in this single run.

The [sparse probe](../tooling/clickhouse-sparse-trial.sql) used 600,000 rows and a 95% default-ratio threshold. `Nullable(Int64)` was `Default` (25,086 compressed bytes), while the non-nullable value and presence columns were `Sparse` (738 and 720 bytes). The presence bit preserved present zero and absent values exactly. This verifies the mechanism, not a production CPU win; no point scalar representation was changed.

Generate packets with the example's `codecs` argument and pass `codecs` as the final harness argument. Run `threshold` against a separate server with the compression XML mounted under its `config.d`. Run the sparse SQL with `clickhouse-client --multiquery` against a disposable server.
