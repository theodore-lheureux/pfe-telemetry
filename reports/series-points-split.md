# ClickHouse series and points trial

The split lowered ClickHouse insert CPU and most query latencies in this local run, but increased both occupied disk space and rows rewritten. This is not a sustained-ingestion or rollout result.

## Storage and CPU

| Per 600,000 points              |   Wide 1024 |  Split 1024 |  Split 4096 |
| ------------------------------- | ----------: | ----------: | ----------: |
| Insert CPU-s                    |        4.79 |        3.94 |        3.70 |
| Merge CPU-s (`system.part_log`) |        1.88 |        1.62 |        1.38 |
| Merge CPU-s (container)         |        2.07 |        1.94 |        1.49 |
| Merge rows read                 |   1,202,706 |   1,819,460 |   1,819,460 |
| Merge rows written              |   1,200,156 |   1,238,920 |   1,238,920 |
| Total bytes before merge        | 160,202,643 | 312,608,641 | 306,676,345 |
| Total bytes after merge         | 155,025,499 | 192,487,185 | 187,997,725 |
| Files per final point part      |         329 |         185 |         185 |
| Files per final series part     |           — |         233 |         233 |

Wide totals include both discovery tables (11 files per final part each). Split totals include the series table. The interleaved fixture visits 19,460 series with little locality within 128 KiB packets, so it wrote 600,000 series rows before merges reduced them to 19,460. After merging, the split's points alone still used more bytes than the wide points: changing sort order changes compression, including placement of the repeated lineage bodies.

## Query latency

Milliseconds, p50 / p95. All five queries matched the baseline for row keys, ranks, counts and values (Float64 results checked to 12 significant digits to allow different addition order).

| Query                          | Wide 1024 | Split 1024 | Split 4096 |
| ------------------------------ | --------: | ---------: | ---------: |
| Node health: processes         |   29 / 34 |    26 / 33 |    25 / 30 |
| Node health: disk read rate    |   59 / 67 |    35 / 38 |    36 / 47 |
| Node health: disk write rate   |   58 / 64 |    34 / 41 |    35 / 39 |
| Disk rate grouped by direction |   70 / 83 |    43 / 49 |    45 / 53 |
| Execution filter and group     |   32 / 35 |    28 / 37 |    28 / 32 |

## Method

ClickHouse 26.8.34.13 ran in a separate local container. The fixture follows the packed profiler's 10 nodes, 139 resources per node, 14 metric slots and 48 repeated 1,100-byte lineage bodies, with three metric slots adapted for dashboard gauges and segmented counters. The benchmark inserts 38 length-delimited Protobuf blocks into `Null` stand-ins for the Kafka source tables, with the actual target views attached. This isolates ClickHouse format decoding, insertion and fsync; it excludes broker/normalizer CPU. A separate native Kafka replay verified the normalized Rust IDs in ClickHouse using disposable topics and groups.

Background merges are stopped during insertion, then enabled before `OPTIMIZE FINAL`. CPU and rewrite counts include any merges selected after re-enabling. Query timing uses the actual old and new analytics compilers against the merged tables, one ClickHouse thread, three warm-ups and 20 measured requests per variant in rotating order.

On an isolated loopback ClickHouse container named `recount-series-trial-*` with the checkout's `recount.proto` in its format schema directory:

```sh
cargo build -p recount-telemetry-validation --example contract_fixture
cargo run -p recount-normalizer --example series-bench-packets -- "$TRIAL_DIR/packets"
bun tooling/bench-series-split.ts "$TRIAL_CONTAINER" "$TRIAL_URL" \
  "$CONTRACT_FIXTURE" "$TRIAL_DIR/packets"
```

Use a new `packets` directory under a writable `TRIAL_DIR`. Set `CONTRACT_FIXTURE` to the built example path and `TRIAL_URL` to the isolated loopback HTTP endpoint. The benchmark drops its randomly named databases on exit.
