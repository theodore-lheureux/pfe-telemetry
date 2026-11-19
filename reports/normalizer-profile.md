# Normalizer CPU profile

Projection and packing dominated the normalizer on the Mac: together they accounted for about 75% of non-wait stack samples. Kafka consume and produce paths accounted for about 8%. This replay did not reproduce the Oracle CPU cost or sustained lag.

## Workload

The normalizer ran natively on an Apple M5 Pro (`arm64`, macOS 27.2.1) from `8c764f6`, built with `CARGO_PROFILE_RELEASE_DEBUG=1 cargo build --locked --release -p recount-normalizer`. The local Kafka broker used disposable raw, packed and late topics with three partitions each and a dedicated consumer group. Producer settings were unchanged: ZSTD, `acks=all`, idempotence and 30 ms linger.

The [collector fixture](../tooling/load/fixtures/collector.json) supplied 1,158 points per request. The feeder paced 24 sources at one export per second per source, with distinct receipt and batch IDs and recent measurement times. It published 2,880 ZSTD-compressed raw records, or 3,335,040 points over 120 seconds (27,792 points/s). Local Kafka acknowledged normalized output; no downstream ClickHouse consumer was needed for the measurement. The raw group reached 2,880 committed records with zero final lag. The sampled process used 23.93 CPU-s including startup and drain, or **0.00718 CPU-s per 1,000 points**. The reported Oracle cost was 0.025.

## Where CPU went

`xctrace` could not attach to the live PID. Three consecutive 30-second `/usr/bin/sample` captures at 1 ms intervals covered approximately seconds 19–110 of the paced feed. The percentages below estimate CPU share from 15,359 exclusive stack samples after filtering blocked leaves such as `poll`, `kevent` and condition-variable waits. They are not hardware CPU counters: runnable threads can be sampled while descheduled, and optimized/inlined frames limit attribution. Each sample is assigned to one stage.

| Stage                                                                                  | Estimated CPU share |
| -------------------------------------------------------------------------------------- | ------------------: |
| Projection, including attribute flattening, copying, series/stream hashing and sorting |               59.8% |
| Packing and size calculation, excluding identifiable final encoding                    |               14.8% |
| Tokio, framework, cleanup and unattributed work                                        |                8.4% |
| Kafka produce, compression and delivery tracking                                       |                4.9% |
| RawRecord / OTLP Protobuf decoding                                                     |                3.9% |
| Kafka consume and raw decompression                                                    |                3.2% |
| Validation                                                                             |                3.1% |
| Final AnalyticalPoint encoding                                                         |                1.9% |

The encoding row counts identifiable final wire encoding. Protobuf encoding used to build hash inputs counts as projection; length checks used to budget packets count as packing. Inlined encoding and framework calls without a recognized frame are not separable. All three captures showed the same ordering of the two largest stages.

### Top exclusive leaves

| Function                                            | Estimated share |
| --------------------------------------------------- | --------------: |
| `_platform_memmove`                                 |          14.65% |
| `_xzm_free_tc`                                      |           5.75% |
| `_xzm_malloc_tc`                                    |           5.25% |
| `prost::encoding::varint::encode_varint`            |           5.14% |
| `sha2::sha256::compress256`                         |           5.06% |
| `__xzm_xzone_free_to_freelist_chunk`                |           4.05% |
| `recount_telemetry_schema::series::without_markers` |           3.33% |
| `mach_absolute_time`                                |           3.23% |
| `_xzm_xzone_malloc_tiny`                            |           2.99% |
| `ZSTD_compressBlock_doubleFast`                     |           2.68% |

The allocator and clock names are Darwin-specific. Their ranks do not carry over to Linux, though copying, allocation and clock reads can still cost CPU there. ZSTD and the Rust projection code are common to both builds; relative cost can change with CPU generation, native libraries, Kafka batch shape and VM scheduling. In particular, the Mac was not CPU-quota constrained. Neither these samples nor the absence of local lag explain Oracle's backlog at 0.75 average cores under a one-core cap.

## Optimization priorities

1. **Avoid copying point attributes during projection — largest candidate, medium complexity.** Reuse flattened resource and scope dimensions within an export instead of cloning them for each observation, while preserving owned wire rows and exact hash bytes. The small prototype extracts continuity markers in place and preserves their original ordinals. It removes one vector rebuild but not the larger per-observation clone.
2. **Reuse hash inputs and packet sizing work — medium-to-large candidate, medium complexity.** Cache serialized invariant prefixes and relevant canonical attribute work within a raw delivery; reuse encoded length when writing a frame. SHA-256 alone was about 5% and the surrounding Protobuf, sorting and allocation cost is attributed to projection. Require exact identity and wire parity tests.
3. **Test cheaper output compression before changing producer concurrency — smaller local candidate, low complexity.** ZSTD's hottest leaf was 2.7% and the entire produce path about 5% on the Mac. Test a cheaper ZSTD level against broker disk, network and ClickHouse input CPU on the target. More preparation lanes might improve utilization across cores, but are not a CPU-per-point optimization and can increase contention under a one-core cap.

### In-place continuity extraction

In two unprofiled pairs at 24 exports/s and two active slots, process user plus system CPU averaged **0.00735 before and 0.00667 after per 1,000 points** (24.52 to 22.25 CPU-s, **9% lower**). The baseline runs used 25.42 and 23.62 CPU-s; the prototype used 22.56 and 21.94 CPU-s. Each run consumed and committed all 2,880 raw records and produced 30,360 packed records and no late records. This is not a Linux or VM speedup claim. The regression test checks dimension order and original marker positions.

### Two versus eight active records

The same release prototype, replay and producer settings ran once per slot count, with a 30-second `sample` capture in each run. The shared payload queue was 32 MiB at two slots and 128 MiB at eight. Both runs drained all 2,880 raw records with zero final lag and wrote 30,360 packed records. The feed was paced, so this compares CPU at equal throughput, not maximum sustainable throughput under Oracle's quota.

| Measurement                                            | Two active | Eight active |
| ------------------------------------------------------ | ---------: | -----------: |
| Process CPU-s                                          |      25.74 |        21.28 |
| CPU-s per 1,000 points                                 |    0.00772 |      0.00638 |
| Produce/compression/delivery share of non-wait samples |      6.53% |        5.70% |
| Estimated produce-path CPU per packed Kafka record     |      55 µs |        40 µs |

The last row multiplies total process CPU by the sampled produce-stage share and divides by packed records. It includes compression and delivery tracking; it does not isolate fixed per-message overhead. The observed CPU difference is from one pair, not a throughput or Linux speedup guarantee. The [normalizer configuration](../apps/normalizer/README.md#first-start-and-recovery) gives the queue and per-slot memory budgets.

### Larger packed records

The replay produced about 91 packed Kafka records per 10,000 points (110 points per record on average). Raising the 128-point or 128 KiB limits could reduce the fixed work per output record: publication futures, headers, produce queue entries and delivery callbacks. It would not remove Protobuf encoding, projection or compression work that scales with bytes. Kafka already compresses producer batches; fewer application messages are not the same as fewer broker batches. A larger message also makes retry and buffering units larger.

Keep the recent reader on delimited `Protobuf`; it does not depend on a fixed point count. Before raising limits, verify that producer and topic caps admit the largest framed record and that ClickHouse's native consumer fetch, receive and queue budgets can hold it. Re-evaluate `kafka_poll_max_batch_size` and `kafka_max_block_size` together: the poll can overshoot a row target by processing a fetched batch, so more rows per message can increase decoded memory and insert spikes. Keep late `ProtobufSingle` unchanged. No pack or reader settings changed in this trial.
