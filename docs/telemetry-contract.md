# Telemetry collection and ingestion contract

The Linux collector's acquisition semantics complement the [telemetry point contract](telemetry-point-contract.md), which defines current raw/analytical messages, sample identity, resource authority, fidelity, routing and admission limits. Runtime settings belong in the [collector](../apps/collector/README.md), [ingestion API](../apps/ingestion-api/README.md), [normalizer](../apps/normalizer/README.md) and [stack](../infra/README.md) references.

## Wire format and profiles

Metrics use the standard OTLP/gRPC `MetricsService/Export` request and response. The API accepts uncompressed and gzip metrics and authenticates before acceptance. Requests with validated observations return the standard empty success response only after confirmed raw Kafka publication. Authenticated zero-point requests succeed after authority and validation checks without Kafka publication; their success proves neither publication nor downstream health. Traces return `UNIMPLEMENTED`. There is no partial OTLP success or custom receipt body. [Service definition](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/collector/metrics/v1/metrics_service.proto)

`recount-collection-profile` is absent/`standard` for ordinary authorized OTLP, or `linux` for the Recount collector adapter. Linux requests require durable batch identity. The collector splits before assigning IDs, commits immutable body/metadata to its local queue and retries without reordering observations. Shared [metadata and retry rules](telemetry-point-contract.md#sample-identity-and-retry-rules) define the exact header values; standard exporters can omit that extension and have the narrower accepted-record replay guarantee.

The Linux catalogue is adapter policy, not a universal allowlist for application/IoT metric names. Standard authorized resources do not need invented Linux process or boot fields. Instrumented applications use existing OpenTelemetry SDKs rather than sending execution registration through OTLP.

## Resource fields

Linux node, process and collector resources carry `host.id`, `recount.host.boot_id`, collection source, `recount.collection.scope`, `recount.collection.epoch_id`, intended interval and `os.type=linux`. Instrumentation scope `recount.collector.procfs` reports the current collector package version. UUIDs are opaque identifiers; their embedded time does not replace explicit event, creation or receipt timestamps. [UUID considerations](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)

The configured `host.id` must match the root in the node's access token, which is the machine ID the node enrolled with. Changing the collector flag changes acquisition identity, not permission. New Linux enrollment keys grant adapter `linux` with GPU, process and container local kinds by default; explicit and existing grants remain unchanged. The API derives deterministic local process IDs from trusted project/root plus boot, namespace, PID and start ticks, without one grant per PID. See [resource grants](telemetry-point-contract.md#resource-grant-interface) and [collector enrollment](collector-enrollment.md).

Process resources retain `process.pid`, the kernel short name `process.executable.name` (`/proc/<pid>/comm`, at most 15 bytes), `recount.process.namespace_id`, incarnation `start-ticks:<decimal>` and decimal raw `recount.process.start_time_ticks`; Linux clock frequency is retained as metadata. The collector reads and rechecks PID/start ticks before emitting points. Unverified identities are discarded, not approximated from rounded creation times or array positions. Deployment must verify the boot-local namespace identity and whether visibility is `host` or `restricted`. Parent PID is descriptive, not proof of execution membership. Resource/point attributes contribute to [OTLP metric stream identity](https://opentelemetry.io/docs/specs/otel/metrics/data-model/#opentelemetry-protocol-data-model); mutable clock quality belongs in diagnostic values, not identity dimensions.

The adapter resolves node/collector resources to the enrolled root and process resources to its permitted local namespace. Independently identified VMs/devices need exact bindings rather than authority inferred from a parent/placement claim. Root reporting permission is not physical attestation. Unknown topology and execution association remain unknown.

The collector exports only allowlisted identity and metric dimensions. Process metrics include the numeric Linux real UID (`process.real_user.id`) when readable, and `recount.slurm.job.id` plus an optional numeric `recount.slurm.step.id` for recognized Slurm v1 or v2 cgroups. Step names such as `batch` and `extern` do not produce a step ID. These dimensions support filtering and grouping; they are not evidence of execution membership, and job IDs are not globally unique. GPU allocation bytes use the same verified process identity, with `gpu.uuid` on the point. Unreadable fields are omitted or reported through acquisition status, not invented as zeros.

UID and Slurm IDs describe the first verified observation of a process incarnation, not later credential changes or cgroup moves. The sampler caches up to 65,536 incarnations, including missing attribution, and drops entries not verified in a completed scan. At capacity, it samples new processes without these attributes until space is available.

Apart from the kernel short process name (`process.executable.name`, read with each sample), the metric sampler does not read arguments, environment variables, executable links, application files or process memory. It exports neither usernames nor raw cgroup paths. Separate opt-in execution discovery has its own allowlist. Standard OTLP attributes remain subject to shared structural/privacy rules rather than this collector-specific acquisition allowlist.

## Measurements

Each scan attempts baseline node and visible-process measurements. The process CPU distribution records only processes whose CPU time advanced since their previous read; idle processes are reported as the `cpu_idle` kind of `recount.collection.process.coverage`, so percentiles describe busy processes. Memory and disk distributions include every observation. Available points and coverage diagnostics are emitted together, but individual reads have their own completion times: a scan is not an atomic snapshot. Successful discovery with no disks is valid; periodic discovery can miss short-lived processes.

The [collector measurement catalogue](../apps/collector/README.md#baseline-measurements) lists names, types, units and dimensions. The shared [catalogue implementation](../crates/telemetry-validation/src/catalogue.rs) validates adapter metric semantics. Current baselines include Recount node CPU/memory, standard system disk and network I/O and process CPU/disk I/O, plus Recount RSS. Standard metric/vendor identifiers retain their external spelling. [System conventions](https://opentelemetry.io/docs/specs/semconv/system/system-metrics/), [process conventions](https://opentelemetry.io/docs/specs/semconv/system/process-metrics/)

Each scan reads cumulative `system.network.io` bytes from `/proc/net/dev`, with `network.interface.name` and `network.io.direction` (`receive` or `transmit`). It excludes `lo` but retains physical and virtual interfaces, including bonds, IPoIB and container bridges. Those interfaces increase series cardinality and can count the same traffic at multiple layers when summed. Counter decreases start a new continuity segment, like disk I/O. Malformed rows are skipped and reported as a failed read without suppressing valid interfaces.

Collector histograms use UCUM annotations to identify what the buckets count. For example, in `1{busy_process}` the bucket boundaries are ratios and the counts are busy processes. The annotation does not scale the boundaries, min, max or sum. Coverage gauges use stand-alone count units such as `{process}`, `{gpu}` and `{connection}`.

Optional `recount.analytics.*` string entries in OTLP metric metadata describe how to present a metric. They do not change its values or grant access to other projects.

| Entry suffix                       | Meaning                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `section`                          | Picker section: `node`, `processes`, `gpu` or `diagnostics`. Unrecognized sections appear under Other.            |
| `quantity`                         | Histogram quantity for a localized axis title and bucket range.                                                   |
| `breakdown`                        | Resource attribute key to select by default. A member's chosen default takes precedence.                          |
| `heartbeat`                        | `true` marks a metric emitted each collection cycle, used to distinguish missing scans from missing measurements. |
| `coverage.metric`                  | Coverage gauge in the same project. Its `coverage` point attribute names each count.                              |
| `coverage.mode`                    | `partial` for capped detail; `excluded` when a histogram intentionally omits a population.                        |
| `coverage.omitted`                 | Kind in the coverage gauge that counts omitted subjects.                                                          |
| `coverage.shown`, `coverage.total` | Optional kinds for the displayed and total subject counts.                                                        |
| `coverage.reason`                  | Optional reason for intentional exclusions; `idle` identifies idle observations.                                  |

A positive omission count means some subjects were left out. An absent reading does not prove complete coverage. The collector reports these counts per node, not per process or execution.

CPU and I/O baselines are cumulative monotonic sums, not percentages or rates. Byte counters must fit signed Int64; out-of-range values produce a status instead of wrapping or rounding. Node CPU aggregates logical CPUs, keeps guest time within user/nice and excludes decreasing iowait from monotonic counters. RSS includes shared pages and is not private memory. Disk partitions/devices can overlap; do not sum every I/O series indiscriminately.

The shared catalogue describes owned Linux GPU metrics and external DCGM fixture mappings. The collector's optional [GPU acquisition](nvidia-gpu-collection.md) exports device/MIG profiling ratios and supported core gauges with native DCGM timestamps, explicit unavailable statuses and host-local UUID identity. It does not establish process/job attribution or completed hardware validation. Standard application histograms, exponential histograms and summaries retain their native structures through the point pipeline; they are not flattened into scalar collector measurements.

## Time and continuity

OTLP event time is the nonzero UInt64 Unix nanosecond timestamp when the read completed. Gauges have zero start time; counters retain a known origin or zero when unknown. The collector initially uses verified boot time for node CPU when it does not exceed event time, and omits that cached origin after a clock discontinuity. Process counter origins and derived Unix process-start times are omitted when wall-clock resolution is not established. Timestamp encoding does not imply clock accuracy. [Metric fields](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto)

Each baseline counter point carries `recount.counter.segment_id`. Segments change after resets, failed/missed reads, skipped cycles, device disappearance/reappearance, discarded identities, known local loss or restart. Local loss feedback conservatively invalidates baseline continuity; already enqueued observations keep their original timestamps and segments.

Rates require matching resource identity, source, instrumentation version, dimensions, epoch and segment, strictly increasing event time and non-decreasing counter values. Known loss invalidates the interval:

`rate = (value2 - value1) / ((time2 - time1) / 1e9)`

CPU rate can exceed one; percentages relative to an allocation need actual allocation evidence. Never derive counter rates from gauges or bridge disconnected continuity segments. The current chart reader preserves segments but does not add a general rate/rollup product.

`recount.clock.status` is currently zero (unknown), emitted with the timestamp of `recount.collection.scan.duration`. No synchronization estimate is verified, so clock uncertainty is omitted. Clock quality is diagnostic data, not a changing stream-identity attribute. Request splitting repeats clock/scan diagnostics with unchanged timestamps so each fragment retains its scan window.

Wall/monotonic discontinuity checks abandon incomplete scans and start a new epoch. Their threshold detects discontinuities; it is not a cross-node synchronization bound. Missing or insufficient clock evidence remains unknown. Submission-age policy applies only to declared batch creation; it neither imposes a measurement-age/future cutoff nor rewrites source timestamps.

## Missing readings

Omit unavailable measurement values. For each attempted baseline category on the node or a verified process, emit `recount.collection.read.status`, an Int64 gauge with unit `{status}` and dimension `recount.metric.name`:

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

Local enqueue confirms recoverable pending upload only. Raw Kafka acknowledgement confirms backend acceptance only. Normalization may produce several records across partitions, and ClickHouse can expose a subset before the remainder. Native ingestion projects packets into `telemetry.metric_series` and `telemetry.metric_points` through separate materialized views. A read requires both rows; neither publication nor the two projections is a transactional visibility boundary.

### Analytical identity and storage

`series_id` is the first eight bytes of SHA-256 as a big-endian `UInt64`. The input is the typed hash domain `recount.series` followed by the Prost encoding of an `AnalyticalPoint` containing only the series metadata fields: project, source, resource, host, scope, metric descriptor, attributes, schema URLs, presence and dropped-attribute counts, metric metadata and resource entity references. Retain array order and optional-field presence. Hash inputs use eight-byte big-endian length prefixes for every field, including the domain. Observation fields, bounds, identity outputs and continuity markers are not encoded in the hash input.

`logical_series_id` is a separate 64-bit SHA-256 prefix under `recount.logical-series` for measure grouping. The length-prefixed fields in order are project, source, resource, resource kind, host presence and value (empty when absent), scope name and version, metric name, unit, then each resource/scope/point attribute array preceded by its count. Array nodes are sorted by path and encoded as `AttributeNode` messages. Numbers and presence flags use eight-byte big-endian values. Descriptor revisions can change the storage key without splitting measure groups. Analytical sample identity comes from the series, stream and event timestamp. See [sample replacement and delivery evidence](telemetry-point-contract.md#sample-identity-and-retry-rules).

ClickHouse stores boot, collection epoch and counter segment evidence in `metric_streams`, keyed by project and `stream_id`. Evidence uses canonical path order; inspection does not restore the collector's original attribute order. Rate windows still split on `stream_id` and do not read the evidence table. Marker filters and inspection report missing evidence as unavailable, not as an empty marker set.

A [process-local normalizer cache](../apps/normalizer/README.md#first-start-and-recovery) can omit dimensions and stream evidence previously acknowledged on the same output lane and partition. An earlier series event time forces a new row to preserve the minimum. The stored maximum can lag by up to 60 seconds of event time, so readers widen the series-side lower bound by 60 seconds while keeping the requested point window unchanged. ClickHouse aggregates duplicate series rows and bounds across replicas, restarts and retries.

The Linux profile promotes `host_id`. Other OTLP sources have no promoted host; ClickHouse stores the empty string and readers expose absence. There is no analytical `device_id` column.

Request-wide invalid/oversized data is rejected before raw publication; deterministic size failures are terminal `RESOURCE_EXHAUSTED` without `RetryInfo`. Temporary authority/broker outages are retryable. A timeout can be ambiguous, so retry unchanged. The collector removes confirmed successes and records terminal rejection/expiry losses; exact retry/status behavior is in the [collector export reference](../apps/collector/README.md#export-and-privacy) and [OTLP failure table](https://opentelemetry.io/docs/specs/otlp/#failures).

Accepted Kafka replay validates stored context without refreshing node revocation or upload age. Poison halts its affected input without skipping; expired checkpoints are explicit gaps. Fresh-group initialization and schema/mount/image guards belong to [stack operations](../infra/README.md), not automatic startup resets or old-format readers.

## Validation boundaries

Use the shared semantic/binary fixtures for exact values, distribution structures, optionality, attributes and stable identities. Run current native Kafka/MV and application authorization checks separately. A Protobuf/ClickHouse-local round trip alone cannot prove broker replay, storage/offset ambiguity, full two-collector browser behavior or hardware coverage.

Use native application/browser processes against a reused backend for daily iteration. Build Linux artifacts on the host and execute those artifacts in Linux containers for packaging and Linux-specific validation. Byte/row/expanded-work/concurrency controls are provisional configurable safety limits, not a decoded-memory or production-capacity proof. OTLP JSON remains useful for inspecting examples under its [defined mapping](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding), not an alternative normalized runtime format.
