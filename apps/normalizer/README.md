# Recount normalizer

`recount-normalizer` consumes retained raw metrics, revalidates accepted context and publishes `AnalyticalPoint` records. ClickHouse reads length-delimited `Protobuf` on the recent topic and bare `ProtobufSingle` on the late topic. RustStream owns consumption, worker dispatch and tracked periodic commits. The normalizer needs Kafka only: it does not read PostgreSQL credentials or write ClickHouse directly. See the [point contract](../../docs/telemetry-point-contract.md) for identities and resource lineage.

## Configuration

With no subcommand, the normalizer runs normally. `recount-normalizer --help` generates configuration flags, environment names and defaults from their owning types; command-line values override environment variables and defaults. Put options before the optional `validate` subcommand. Invalid configuration exits with status 2 through Clap before the runtime starts. `just normalizer` forwards arguments unchanged.

```sh
cargo run --locked -p recount-normalizer -- --help
cargo run --locked -p recount-normalizer -- --max-points 8192 validate
```

`validate` checks the same typed declarations as startup, without Kafka clients, a runtime or network access. It neither verifies effective broker settings/checkpoints nor seeds offsets. The seven structural defaults belong to `telemetry-validation::validate::Limits`, exposed by the shared flattened `LimitArgs`; topic budgets and client allowances use `telemetry-validation::transport`. The schema exporter's finite native insertion-partition ceiling is separate from the fixed one-point Kafka shape. There is no normalizer packing/`--output-rows` option. See [deployment configuration ownership](../../infra/README.md#configuration-ownership).

Match structural limits to the ingestion API. Body limits need at least 64 KiB of spare space within their respective broker caps. An `on_startup` hook verifies exact topic partition IDs/counts and effective `max.message.bytes` before the framework opens its subscription or publisher. These are bounded initial snapshots, not per-assignment or periodic checks. Topics are never created automatically. Incompatible disposable local topics are explicitly recreated, not migrated or reconciled in place.

Kafka permissions must allow raw consumption, normalized production, group checkpoint operations and topic metadata/DescribeConfigs reads. The current transport is the plaintext development network; production TLS/SASL configuration is not implemented. These defaults are provisional safety settings, not fleet capacity or recovery guarantees.

## First start and recovery

`RECOUNT_NORMALIZER_MAX_ACTIVE` sets the number of raw records the worker can
handle concurrently (default 8, range 1–32). The shared producer payload queue
scales with the slot count and the normalized output budget per raw record. It
has a floor of one configured Kafka record, subject to a 128 MiB cap. The
producer also limits queued messages to the slot count times the point limit,
capped at one million.

With default limits, each active slot can retain up to 4 MiB of copied raw
bytes and 16 MiB of normalized output bodies before framing. Eight slots account
for up to 160 MiB of those buffers, plus up to 128 MiB of queued producer payload.
At 32 slots the corresponding budget is up to 768 MiB. Neither total is an RSS
bound: native fetch buffers and producer batches, decoded OTLP and projected
rows, allocator overhead, thread stacks and the series cache are additional.
Encoded byte and item limits constrain input growth but do not cap decoded heap
bytes. Under the Oracle 1 GiB limit, check peak RSS on wide valid requests before
raising concurrency beyond the default; reduce slots or payload budgets if
headroom is inadequate. A raw offset is still acknowledged only after every
output delivery succeeds.

Normalizers in the same consumer group can run on multiple replicas. With
three raw partitions, at most three replicas receive work. Startup checks
topic topology and transport settings without claiming exclusive ownership.
Use a distinct `RECOUNT_NORMALIZER_METRICS_FILE` per replica if exporting
process metrics. To raise the ceiling, coordinate raw partition expansion
with the ingestion API and all replicas, then update `RECOUNT_RAW_PARTITIONS`
to the new count on both services. Keep the raw group and its offsets; new
partitions start at retained earliest. Expansion changes raw routing affinity
for subsequent requests and does not require changing normalized partitions.

Each process allocates 40 bytes per configured `RECOUNT_NORMALIZER_SERIES_CACHE_ENTRIES`
slot (131,072 by default, 5 MiB; maximum 1,048,576, 40 MiB). Set it to zero
to disable suppression. Collisions replace a slot and can cause extra writes,
not missing metadata. `RECOUNT_NORMALIZER_SERIES_RESEND_SECONDS` defaults to
60 and accepts 1–60. Only acknowledged emissions for the same output topic
and partition suppress later rows. Earlier event times, event-time jumps at
least as wide as the interval, changed series IDs and expiration force an
emission. Replicas do not share state; ClickHouse aggregates duplicate rows
and their time bounds.

Deploy readers with the widened series window before enabling the cache.
If rolling out the normalizer first, set the cache entry count to zero until
the readers are updated. This change does not require a topic or table reset.

New groups start from retained earliest without offset seeding. `auto.offset.reset=earliest` deliberately discards unavailable offsets in active development and continues from the retained suffix. Every native error-driven reset produces an explicit `event=retention_gap action=resume_earliest` warning and increments `recount_normalizer_retention_gaps_total`; a fresh group's initial start does not count as a gap. Set `RECOUNT_NORMALIZER_METRICS_FILE` or `--metrics-file` for atomic Prometheus text-file export of that process-local counter. Logs include the group and native topic/partition/offset detail. The retained suffix is not complete recovery of expired input. See [Kafka recovery](../../docs/kafka-recovery.md) for production sizing choices, lag/headroom/disk gauges and disposable outage tests.

Raw consumers use a six-second Kafka session. The [startup assignment wait](https://docs.rs/ruststream-rdkafka/0.7.1/ruststream_rdkafka/struct.KafkaBroker.html#method.assignment_timeout) allows eighteen seconds: a full session expiry after an abrupt member exit, plus twelve seconds of startup headroom. This is not a per-stage timing guarantee; RustStream's initial committed-offset lookup has its own ten-second timeout within the overall assignment wait. The assignment deadline still fails startup if the subscription cannot open. Metadata RPCs and the broker connectivity probe retain their separate three-second deadlines; this longer assignment budget does not delay metadata-outage failure.

Every required output publication is awaited before the input is acknowledged. `Commit::Tracked` stores only settled prefixes; librdkafka commits them every second. The framework fences stale acknowledgements after normal revocation/seek. There is no per-input commit-confirmation slot or custom recovery loop. `RECOUNT_NORMALIZER_RETRY_MS` configures native producer backoff within the delivery deadline. A failed publication, invalid retained input or preparation failure takes the explicit handler panic `FailFast` path, stopping the process with unfinished input unsettled. This global availability policy is not partition-local poison isolation. No failed handler returns a default drop, finite skip policy or delayed retry copy. Cancellation cannot undo acknowledged output: deterministic IDs make partial replay logically duplicate-safe, not exactly-once.

Accepted replay checks stored context shape and semantics, not current credential revocation, grant policy or upload age. It never rewrites measurement times or original positions.

## Bounds and process state

Preparation has one semaphore lane per process, independently of 1–8 framework workers. Each worker has a capacity-1 inbox, and unkeyed dispatch reserves an idle worker before pulling input, so queued plus executing pool deliveries do not exceed the worker count. The entire raw request is validated before publication. A point within 24 hours of the process clock, either way, goes to `RECOUNT_NORMALIZED_TOPIC` (default `recount.metrics.normalized-packed`); any other point goes to `RECOUNT_LATE_TOPIC` at the same partition index. Recent messages pack up to 128 points from one submission and partition with a 128 KiB target including delimiters. A wider valid point travels alone; partial messages do not wait for another submission. Records are sent in groups that fit the producer queue, and each group's deliveries are awaited before acknowledging the input. The encoded output and native fetch/queue limits are not a peak-memory bound.

ClickHouse batches those individual Kafka records into multirow source blocks; this does not change the normalizer's message shape or acknowledgements. The normalized table targets 4,096 rows per block, since its points span only a few days. The late table targets 64 rows with at most 32 messages per poll, reduced by the schema renderer to respect the finite event-day partition guard, including end-of-poll overshoot. Both flush every two seconds. See [native consumer settings](../../infra/README.md#broker-and-native-consumer-settings) for bounds and latency caveats.

The process emits `state=starting`, `ready`, `stopping` and `fatal`, plus framework diagnostics, on stderr. `ready` identifies initial-snapshot checks, not an exhaustive-delivery guarantee. A retention gap warns and continues rather than stopping the process. There is no HTTP listener or alert-delivery subsystem. SIGTERM/interrupt uses framework draining within the configured deadline, with unfinished work unsettled; producer flushing has a three-second budget and Tokio runtime shutdown a further 100 ms budget. Startup waits may finish with a bounded nonzero connection error rather than graceful signal cancellation. No claim covers every blocked native destructor or in-flight retention/rebalance race.

Run the normalizer and ordinary tests natively where supported, reusing Kafka with dedicated topics/groups. Compile Linux artifacts on the host for explicit Linux/runtime gates; never compile applications inside Docker. Pure recovery tests do not establish broker acknowledgement, rebalance or outage behavior; those require an allocated Kafka integration namespace.

Configuration tests cover invalid limits and incoherent transport headroom. The separately named Linux/runtime gates retain subprocess shutdown during a metadata outage and bounded packaged execution. They consume host-built artifacts; ordinary native tests do not require Docker packaging.

The ignored `tests/kafka.rs` harness needs precreated **empty**, three-partition raw, normalized and late topics with the default 6 MiB/2 MiB broker caps and an unused group, all named under `recount.test.normalizer.`. Run the native harness with `--ignored --nocapture` only against that allocated namespace, or execute the same host-built Linux artifacts in an allocated Linux environment. Supply:

- `RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH=1`
- `RECOUNT_NORMALIZER_TEST_BROKER`
- `RECOUNT_NORMALIZER_TEST_RAW_TOPIC`
- `RECOUNT_NORMALIZER_TEST_NORMALIZED_TOPIC`
- `RECOUNT_NORMALIZER_TEST_LATE_TOPIC`, which receives the fixtures' points because they are older than the recent window
- `RECOUNT_NORMALIZER_TEST_GROUP`

The recovery harness publishes synthetic fixtures and writes checkpoints only in its dedicated groups. It checks startup configuration, new-group initialization, bare-point output/routing, committed prefixes, replay, two-consumer rebalance and global handler poison. Its progress regression queues 120 inputs while the worker is absent and verifies every expected sample and committed partition prefix. A separate expiry case creates short-retention topics, checks natural time/byte eviction, and verifies warning, metric export and retained-suffix consumption both after restart and after resuming its own paused worker. No case changes shared retention or resets a shared group. Publication/commit acknowledgement loss, in-flight rebalance and blocked native shutdown still need separately scoped validation.
