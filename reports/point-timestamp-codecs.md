# Point timestamp codecs

Use `CODEC(DoubleDelta, LZ4)` for both timestamp columns. On the local collector replay, the two codecs reduced merged point storage from **9.70 to 2.90 B/point** (70%). A separate ZSTD treatment was not warranted: the two timestamp columns together already use less than 0.10 compressed B/point.

| Measurement                             | Default LZ4 | Event time DoubleDelta | Both DoubleDelta |
| --------------------------------------- | ----------: | ---------------------: | ---------------: |
| Event time compressed B/point           |       5.812 |                  0.049 |            0.049 |
| Receipt time compressed B/point         |       1.082 |                  1.082 |            0.044 |
| Merged point disk B/point               |       9.698 |                  3.936 |            2.898 |
| Insert CPU-s, container delta           |       17.07 |                  17.75 |            10.91 |
| Merge CPU-s, successful part log events |        4.72 |                   4.44 |             4.59 |
| Processes tile SQL p95 (ms)             |        3.22 |                   3.49 |             3.10 |
| Disk rate tile SQL p95 (ms)             |       13.70 |                  25.80 |            13.21 |
| CPU rate tile SQL p95 (ms)              |        3.23 |                   3.24 |             2.92 |

The isolated ClickHouse 26.8.34.13 test replayed the same 1.92M packed collector points from the [long replay](compact-delivery-provenance.md#long-replay) in 120 blocks of 16,000 rows. It used the real point projection against a `Null` input in place of Kafka and excluded the unchanged series and delivery views. Merges were paused during insertion and completed with `OPTIMIZE FINAL`. The final row counts and checksums matched. Insert CPU is a single container-level observation per variant; the apparent improvement with both codecs is not evidence of a repeatable CPU saving.

The three representative SQL queries exercised bucket aggregation and cumulative counter rates with partition-local `FINAL`; they did not include the web layer or the unchanged series join. Each p95 uses 20 server-side timings after three warm-ups, rotating variant order. Results matched for every tile. The fixture's receipt times have simulated one-second cadence; live ingest jitter may compress less well.

Apply the generated ALTER using the [Oracle maintenance procedure](../infra/oracle-stack/README.md#change-point-timestamp-codecs-in-place). It preserves existing telemetry and checkpoints.
