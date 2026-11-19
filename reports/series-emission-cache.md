# Normalizer series emission cache

A process-local cache reduced series emissions by **80%** in a replay of the collector fixture. Normalizer preparation CPU fell by **21%**. The local ClickHouse run measured a smaller insert CPU reduction and did not establish a merge CPU improvement.

| Measurement                                 | Cache off |  Cache on |
| ------------------------------------------- | --------: | --------: |
| Points                                      | 3,335,040 | 3,335,040 |
| Series rows emitted and inserted            | 3,335,040 |   678,289 |
| Series rows/s at fixture cadence            |    27,792 |     5,652 |
| Normalizer preparation CPU-s / 1,000 points |   0.00606 |   0.00478 |
| ClickHouse insert CPU-s                     |     51.70 |     49.44 |
| Observed ClickHouse series merge CPU-s      |      6.77 |      9.70 |
| Observed ClickHouse merge CPU-s, all tables |     27.19 |     45.61 |
| Series rows written by merges               |   361,296 |   142,523 |
| Final series rows                           |    27,792 |    27,792 |

The replay used 24 sources, each sending the [1,158-point collector fixture](../tooling/load/fixtures/collector.json) once per simulated second for 120 seconds, with distinct raw deliveries. Both runs used the same release-build preparation and packing code. The enabled run used 131,072 slots and a 60-second resend interval. Preparation CPU includes file I/O but excludes Kafka and the ingestion API. Rows/s is normalized to the simulated source cadence, not replay wall time or the observed Oracle workload.

ClickHouse consumed identical 4,000-point block sizes through the native projection views with a `Null` source in place of Kafka. Insert CPU is a container CPU delta. Merge CPU is the sum of successful `MergeParts` events in `system.part_log`. The forced baseline series merge hit the local memory limit; background merges completed the series collapse. The enabled run used background merges, and still had two point parts and five delivery parts when sampled, versus one each in the baseline. This makes the merge CPU totals observational, not a controlled performance comparison. Point counts and a checksum over keys and values matched.

The Kafka test started two normalizers in the same group across three raw partitions, confirmed membership, then stopped one mid-stream and confirmed reassignment. Duplicate metadata reached storage without missing series or measurements. A separate reader test verified that a short window still finds points whose cached series metadata predates the window.
