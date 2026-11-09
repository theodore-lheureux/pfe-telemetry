# Recount normalizer

`recount-normalizer` consumes retained raw metrics, revalidates accepted context and publishes one bare `AnalyticalPoint` Protobuf message per Kafka record. RustStream owns consumption, worker dispatch and tracked periodic commits. The normalizer needs Kafka only: it does not read PostgreSQL credentials or write ClickHouse directly. The native ClickHouse reader uses `ProtobufSingle` with the same descriptor. See the [point contract](../../docs/telemetry-point-contract.md) for identities and resource lineage.

## Configuration

With no subcommand, the normalizer runs normally. `recount-normalizer --help` generates configuration flags, environment names and defaults from their owning types; command-line values override environment variables and defaults. Put options before the optional `bootstrap` or `validate` subcommand. Invalid configuration exits with status 2 through Clap before the runtime starts. `just normalizer` forwards arguments unchanged.

```sh
cargo run --locked -p recount-normalizer -- --help
cargo run --locked -p recount-normalizer -- --max-points 8192 validate
```

`validate` checks the same typed declarations as startup, without Kafka clients, a runtime or network access. It neither verifies effective broker settings/checkpoints nor seeds offsets. The seven structural defaults belong to `telemetry-validation::validate::Limits`, exposed by the shared flattened `LimitArgs`; topic budgets and client allowances use `telemetry-validation::transport`. The schema exporter's finite native insertion-partition ceiling is separate from the fixed one-point Kafka shape. There is no normalizer packing/`--output-rows` option. See [deployment configuration ownership](../../infra/README.md#configuration-ownership).

Match structural limits to the ingestion API. Body limits need at least 64 KiB of spare space within their respective broker caps. A documented `on_startup` hook verifies exact topic partition IDs/counts, effective `max.message.bytes` and all initial raw checkpoints before the framework opens its subscription or publisher. These are bounded initial snapshots, not per-assignment or periodic checks. Topics are never created automatically. Resizing partitions or lowering limits under an accepted backlog needs an explicit coordinated operational decision.

Kafka permissions must allow raw consumption, normalized production, group checkpoint operations and topic metadata/DescribeConfigs reads. The current transport is the plaintext development network; production TLS/SASL configuration is not implemented. These defaults are provisional safety settings, not fleet capacity or recovery guarantees.

## First start and recovery

For a genuinely new group with all consumers stopped, explicitly run `recount-normalizer bootstrap` in the runtime container using the same environment. It refuses any existing checkpoint, then seeds every raw partition at the broker's retained earliest offset. This accepts only available retained history; it cannot prove that an older prefix never existed. Do not put bootstrap in an entrypoint or restart loop. Inspect a failed or partially acknowledged bootstrap instead of retrying it as recovery. Group-offset deletion must not be used to disguise an expired existing group as a new one.

Startup refuses missing checkpoints and checkpoints outside broker watermarks. `auto.offset.reset=error` remains set during operation: there is no implicit earliest/latest reset. Native consumption errors after startup may be logged while the application continues running. This accepted development limitation does not establish ongoing readiness or guarantee a failure transition after retention or rebalance.

Every required output publication is awaited before the input is acknowledged. `Commit::Tracked` stores only settled prefixes; librdkafka commits them every second. The framework fences stale acknowledgements after normal revocation/seek. There is no per-input commit-confirmation slot or custom recovery loop. `RECOUNT_NORMALIZER_RETRY_MS` configures native producer backoff within the delivery deadline. A failed publication, invalid retained input or preparation failure takes the explicit handler panic `FailFast` path, stopping the process with unfinished input unsettled. This global availability policy is not partition-local poison isolation. No failed handler returns a default drop, finite skip policy or delayed retry copy. Cancellation cannot undo acknowledged output: deterministic IDs make partial replay logically duplicate-safe, not exactly-once.

Accepted replay checks stored context shape and semantics, not current credential revocation, grant policy or upload age. It never rewrites measurement times or original positions.

## Bounds and process state

Preparation has one semaphore lane per process, independently of 1–8 framework workers. Each worker has a capacity-1 inbox, and unkeyed dispatch reserves an idle worker before pulling input, so queued plus executing pool deliveries do not exceed the worker count. Each accepted raw request is fully validated under per-point/total-output bounds before publication, then emits one point per record without a batch-fill delay. Fetch/queue settings derive from shared broker budgets; complete batches and pinned native buffers can exceed soft queue targets. Decoded structures, projection temporaries, allocator overhead and peak RSS still need adversarial measurements; bounded workers and encoded output are not a memory proof.

The process emits `state=starting`, `ready`, `stopping` and `fatal`, plus framework diagnostics, on stderr. `ready` explicitly identifies initial-snapshot checks; it is not withdrawn automatically for later native stream errors. A startup retention gap has a `retention_gap` reason. There is no HTTP listener, watcher or alerting subsystem. SIGTERM/interrupt uses framework draining within the configured deadline, with unfinished work unsettled; producer flushing has a three-second budget and Tokio runtime shutdown a further 100 ms budget. Startup waits may finish with a bounded nonzero connection error rather than graceful signal cancellation. No claim covers every blocked native destructor or in-flight retention/rebalance race.

Run the normalizer and ordinary tests natively where supported, reusing Kafka with dedicated topics/groups. Compile Linux artifacts on the host for explicit Linux/runtime gates; never compile applications inside Docker. Pure recovery tests do not establish broker acknowledgement, rebalance or outage behavior; those require an allocated Kafka integration namespace.

Configuration tests cover invalid limits and incoherent transport headroom. The separately named Linux/runtime gates retain subprocess shutdown during a metadata outage and bounded packaged execution. They consume host-built artifacts; ordinary native tests do not require Docker packaging.

The ignored `tests/kafka.rs` harness needs precreated **empty**, three-partition topics with the default 6 MiB/2 MiB broker caps and an unused group, all named under `recount.test.normalizer.`. Run the native harness with `--ignored --nocapture` only against that allocated namespace, or execute the same host-built Linux artifacts in an allocated Linux environment. Supply:

- `RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH=1`
- `RECOUNT_NORMALIZER_TEST_BROKER`
- `RECOUNT_NORMALIZER_TEST_RAW_TOPIC`
- `RECOUNT_NORMALIZER_TEST_NORMALIZED_TOPIC`
- `RECOUNT_NORMALIZER_TEST_GROUP`

The recovery harness publishes synthetic fixtures and writes checkpoints only in its dedicated groups (including `.observer` and `.gap`). It checks startup configuration, explicit bootstrap, bare-point output/routing, committed prefixes, replay, two-consumer rebalance, global handler poison and an unavailable initial checkpoint. Its progress regression prefills more inputs than the worker count and verifies every expected sample and committed partition prefix. Neither case changes existing retention or resets an existing group. Publication/commit acknowledgement loss, in-flight rebalance, blocked native shutdown and retention movement after startup need separately scoped validation; they are not covered by a one-time preflight.
