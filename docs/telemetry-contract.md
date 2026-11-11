# Telemetry collection and ingestion contract

The Linux collector's acquisition semantics complement the [telemetry point contract](telemetry-point-contract.md), which defines current raw/analytical messages, sample identity, resource authority, fidelity, routing and admission limits. Runtime settings belong in the [collector](../apps/collector/README.md), [ingestion API](../apps/ingestion-api/README.md), [normalizer](../apps/normalizer/README.md) and [stack](../infra/README.md) references.

## Wire format and profiles

Metrics use the standard OTLP/gRPC `MetricsService/Export` request and response. The API accepts uncompressed and gzip metrics and authenticates before acceptance. Requests with validated observations return the standard empty success response only after confirmed raw Kafka publication. Authenticated zero-point requests succeed after authority and validation checks without Kafka publication; their success proves neither publication nor downstream health. Traces return `UNIMPLEMENTED`. There is no partial OTLP success or custom receipt body. [Service definition](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/metrics/v1/metrics_service.proto)

`recount-collection-profile` is absent/`standard` for ordinary authorized OTLP, or `linux` for the Recount collector adapter. Linux requests require durable batch identity. The collector splits before assigning IDs, commits immutable body/metadata to its local queue and retries without reordering observations. Shared [metadata and retry rules](telemetry-point-contract.md#sample-identity-and-retry-rules) define the exact header values; standard exporters can omit that extension and have the narrower accepted-record replay guarantee.

The Linux catalogue is adapter policy, not a universal allowlist for application/IoT metric names. Standard authorized resources do not need invented Linux process or boot fields. Instrumented applications use existing OpenTelemetry SDKs rather than sending execution registration through OTLP.

## Resource fields

Linux node, process and collector resources carry `host.id`, `recount.host.boot_id`, collection source, `recount.collection.scope`, `recount.collection.epoch_id`, intended interval and `os.type=linux`. Instrumentation scope `recount.collector.procfs` reports the current collector package version. UUIDs are opaque identifiers; their embedded time does not replace explicit event, creation or receipt timestamps. [UUID considerations](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)

The configured `host.id` must match the root in the node's access token, which is the machine ID the node enrolled with. Changing the collector flag changes acquisition identity, not permission. Linux enrollment keys grant adapter `linux` with process and container local kinds by default. The API derives deterministic local process IDs from trusted project/root plus boot, namespace, PID and start ticks, without one grant per PID. See [resource grants](telemetry-point-contract.md#resource-grant-interface) and [collector enrollment](collector-enrollment.md).

Process resources retain `process.pid`, `recount.process.namespace_id`, incarnation `start-ticks:<decimal>` and decimal raw `recount.process.start_time_ticks`; Linux clock frequency is retained as metadata. The collector reads and rechecks PID/start ticks before emitting points. Unverified identities are discarded, not approximated from rounded creation times or array positions. Deployment must verify the boot-local namespace identity and whether visibility is `host` or `restricted`. Parent PID is descriptive, not proof of execution membership. Resource/point attributes contribute to [OTLP metric stream identity](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#opentelemetry-protocol-data-model); mutable clock quality belongs in diagnostic values, not identity dimensions.

The adapter resolves node/collector resources to the enrolled root and process resources to its permitted local namespace. Independently identified VMs/devices need exact bindings rather than authority inferred from a parent/placement claim. Root reporting permission is not physical attestation. Unknown topology and execution association remain unknown.

The collector exports only allowlisted identity and metric dimensions. It does not read arguments, environment variables, executable links, application files or process memory. Standard OTLP attributes remain subject to shared structural/privacy rules rather than this collector-specific acquisition allowlist.

## Measurements

Each scan attempts baseline node and visible-process measurements. Available points and coverage diagnostics are emitted together, but individual reads have their own completion times: a scan is not an atomic snapshot. Successful discovery with no disks is valid; periodic discovery can miss short-lived processes.

The [collector measurement catalogue](../apps/collector/README.md#baseline-measurements) lists names, types, units and dimensions. The shared [catalogue implementation](../crates/telemetry-validation/src/catalogue.rs) validates adapter metric semantics. Current baselines include Recount node CPU/memory, standard system disk I/O and process CPU/disk I/O, plus Recount RSS. Standard metric/vendor identifiers retain their external spelling. [System conventions](https://opentelemetry.io/docs/specs/semconv/system/system-metrics/), [process conventions](https://opentelemetry.io/docs/specs/semconv/system/process-metrics/)

CPU and I/O baselines are cumulative monotonic sums, not percentages or rates. Byte counters must fit signed Int64; out-of-range values produce a status instead of wrapping or rounding. Node CPU aggregates logical CPUs, keeps guest time within user/nice and excludes decreasing iowait from monotonic counters. RSS includes shared pages and is not private memory. Disk partitions/devices can overlap; do not sum every I/O series indiscriminately.

The shared catalogue also describes known DCGM native-time gauge ratios and `By/s` rates. Those mappings do not establish GPU/MIG hardware collection or workload attribution in this Linux procfs collector. Standard application histograms, exponential histograms and summaries retain their native structures through the point pipeline; they are not flattened into scalar collector measurements.

## Time and continuity

OTLP event time is the nonzero UInt64 Unix nanosecond timestamp when the read completed. Gauges have zero start time; counters retain a known origin or zero when unknown. The collector initially uses verified boot time for node CPU when it does not exceed event time, and omits that cached origin after a clock discontinuity. Process counter origins and derived Unix process-start times are omitted when wall-clock resolution is not established. Timestamp encoding does not imply clock accuracy. [Metric fields](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto)

Each baseline counter point carries `recount.counter.segment_id`. Segments change after resets, failed/missed reads, skipped cycles, device disappearance/reappearance, discarded identities, known local loss or restart. Local loss feedback conservatively invalidates baseline continuity; already enqueued observations keep their original timestamps and segments.

Rates require matching resource identity, source, instrumentation version, dimensions, epoch and segment, strictly increasing event time and non-decreasing counter values. Known loss invalidates the interval:

`rate = (value2 - value1) / ((time2 - time1) / 1e9)`

CPU rate can exceed one; percentages relative to an allocation need actual allocation evidence. Never derive counter rates from gauges or bridge disconnected continuity segments. The current chart reader preserves segments but does not add a general rate/rollup product.

`recount.clock.status` is currently zero (unknown), emitted with the timestamp of `recount.collection.scan.duration`. No synchronization estimate is verified, so clock uncertainty is omitted. Clock quality is diagnostic data, not a changing stream-identity attribute. Request splitting repeats clock/scan diagnostics with unchanged timestamps so each fragment retains its scan window.

Wall/monotonic discontinuity checks abandon incomplete scans and start a new epoch. Their threshold detects discontinuities; it is not a cross-node synchronization bound. Missing or insufficient clock evidence remains unknown. Submission-age policy applies only to declared batch creation; it neither imposes a measurement-age/future cutoff nor rewrites source timestamps.

## Missing readings

Omit unavailable measurement values. For each attempted baseline category on the node or a verified process, emit `recount.collection.read.status`, an Int64 gauge with unit `1` and dimension `recount.metric.name`:

| Code | Meaning                 |
| ---- | ----------------------- |
| `0`  | Read successfully       |
| `1`  | Unsupported             |
| `2`  | Permission denied       |
| `3`  | Disappeared             |
| `4`  | Read failed             |
| `5`  | Out of range            |
| `6`  | Temporarily unavailable |

Partial reads retain available points and report the failure status. An unchanged counter has a measured zero delta; an inaccessible counter has no measured value. An unverified process cannot receive an invented identity or per-process status.

Collector-scope diagnostics report discovery status, visible-entry count, discarded-process counts, monotonic scan duration and cumulative local dropped-point counts by reason. Failed discovery is not proof that a host has no processes. Missing cycles expose disconnection, while a local discard after an uncertain acknowledgement may coexist with already accepted rows. Do not erase present measurements because a discard diagnostic exists.

Standard OTLP no-recorded flags remain separate from these Linux coverage diagnostics. Shared [SQL projection rules](telemetry-point-contract.md#sql-projection-and-replacement) preserve absent/present-zero values and require readers to exclude no-recorded values even when a payload value exists.

## Delivery and analytical visibility

Local enqueue confirms recoverable pending upload only. Raw Kafka acknowledgement confirms backend acceptance only. Normalization may produce several records across partitions, and ClickHouse can expose a subset before the remainder. Native ingestion uses a Kafka source and non-aggregating materialized view into `telemetry.metric_points`; it does not wait on a PostgreSQL acceptance index or a complete-batch manifest.

Sample identity uses trusted project/source, payload kind, immutable client batch identity (or accepted record identity) and original resource/scope/metric/point positions. Credential IDs, receipt times, output offsets and worker batching do not redefine samples. Reusing an identity with changed content violates the protocol; there is no permanent conflict ledger or first-writer guarantee. Current readers select logical unique samples before duplicate-sensitive calculations, independently of background replacement.

Request-wide invalid/oversized data is rejected before raw publication; deterministic size failures are terminal `RESOURCE_EXHAUSTED` without `RetryInfo`. Temporary authority/broker outages are retryable. A timeout can be ambiguous, so retry unchanged. The collector removes confirmed successes and records terminal rejection/expiry losses; exact retry/status behavior is in the [collector export reference](../apps/collector/README.md#export-and-privacy) and [OTLP failure table](https://opentelemetry.io/docs/specs/otlp/#failures).

Accepted Kafka replay validates stored context without refreshing node revocation or upload age. Poison halts its affected input without skipping; expired checkpoints are explicit gaps. Fresh-group initialization and schema/mount/image guards belong to [stack operations](../infra/README.md), not automatic startup resets or old-format readers.

## Validation boundaries

Use the shared semantic/binary fixtures for exact values, distribution structures, optionality, attributes and stable identities. Run current native Kafka/MV and application authorization checks separately. A Protobuf/ClickHouse-local round trip alone cannot prove broker replay, storage/offset ambiguity, full two-collector browser behavior or hardware coverage.

Use native application/browser processes against a reused backend for daily iteration. Build Linux artifacts on the host and execute those artifacts in Linux containers for packaging and Linux-specific validation. Byte/row/expanded-work/concurrency controls are provisional configurable safety limits, not a decoded-memory or production-capacity proof. OTLP JSON remains useful for inspecting examples under its [defined mapping](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding), not an alternative normalized runtime format.
