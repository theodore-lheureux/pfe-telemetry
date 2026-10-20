# Linux collector

`pfe-collector` samples Linux node and visible-process resources and sends OTLP/gRPC metrics to the [ingestion service](../server/README.md). Collection and encoding follow the baseline in the [telemetry contract](../../docs/telemetry-contract.md). Export uses a persistent queue with byte, batch-count and age limits and uses standard OTLP input: requests do not advertise `pfe-collection-profile: external/1.0`.

The executable requires Linux and `/proc`. Linux dependencies are target-gated; running the executable on another OS returns an unsupported-platform error. It does not associate processes with distributed executions.

## Configuration

`pfe-collector --help` lists command-line equivalents. Command-line arguments override environment variables; settings are read once at startup.

| Variable                                    | Default                                         | Meaning                                                                                                 |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`               | `http://127.0.0.1:14317`                        | OTLP/gRPC ingestion endpoint.                                                                           |
| `TELEMETRY_COLLECTOR_INTERVAL_MS`           | `1000`                                          | Intended sampling period, between 100 and 60000 ms.                                                     |
| `TELEMETRY_COLLECTOR_HOST_ID`               | `/etc/machine-id`                               | Explicit enrolled host identity, 1-128 UTF-8 bytes. Cloned machine IDs require distinct enrollment IDs. |
| `TELEMETRY_COLLECTOR_VISIBILITY`            | `restricted`                                    | `host` only when deployment has verified enumeration of initial host PIDs; otherwise `restricted`.      |
| `TELEMETRY_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` with host visibility; required otherwise | Verified boot-local PID namespace identity, 1-128 UTF-8 bytes.                                          |
| `TELEMETRY_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`                        | Private persistent queue directory on a local filesystem; one collector per directory.                  |
| `TELEMETRY_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                                      | Maximum queued Protobuf payload bytes, between 1 MiB and 1 GiB.                                         |
| `TELEMETRY_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                                          | Maximum pending batches, between 1 and 65536.                                                           |
| `TELEMETRY_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                                          | Local batch lifetime, between 1 and 86400 seconds.                                                      |
| `RUST_LOG`                                  | `info`                                          | Diagnostic logging filter.                                                                              |

On an enrolled Linux host with initial-host process visibility:

```sh
TELEMETRY_COLLECTOR_VISIBILITY=host TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE=/path/to/source.token cargo run --locked -p pfe-collector
```

Setting visibility to `host` is a deployment assertion, not a permission probe. It requires process namespace ID `host`. Restricted collection requires an explicit namespace ID whose lifetime deployment has verified within the boot; use `host` for a narrower view of initial-host PIDs, or a separately assigned namespace identity for a PID namespace. A namespace inode alone can be reused and is not inferred as an incarnation-safe ID. Procfs self-PID numbering must match the collector's namespace. Neither mode guarantees readable I/O for every process. Do not declare host visibility for a PID namespace, filtered proc mount or restricted process view.

Changing configuration requires restarting the collector and starts a new epoch. `TELEMETRY_COLLECTOR_HOST_ID` changes acquisition identity only; it does not grant source permissions or establish authenticated enrollment. The configured [telemetry pipeline](../../infra/telemetry/README.md) requires enrolled source credentials.

## Baseline measurements

| Metric                      | Source                 | Scope   | OTLP value / unit                       | Dimensions                                                                      |
| --------------------------- | ---------------------- | ------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `pfe.node.cpu.time`         | `/proc/stat` aggregate | Node    | Monotonic cumulative Sum / double / `s` | `cpu.mode`: user, nice, system, idle, interrupt, softirq, steal when supported. |
| `pfe.node.memory.total`     | `/proc/meminfo`        | Node    | Gauge / int64 / `By`                    | None.                                                                           |
| `pfe.node.memory.available` | `/proc/meminfo`        | Node    | Gauge / int64 / `By`                    | None.                                                                           |
| `system.disk.io`            | `/proc/diskstats`      | Node    | Monotonic cumulative Sum / int64 / `By` | `system.device`: `block:<major>:<minor>`; `disk.io.direction`: read, write.     |
| `process.cpu.time`          | `/proc/PID/stat`       | Process | Monotonic cumulative Sum / double / `s` | `cpu.mode`: user, system.                                                       |
| `pfe.process.memory.rss`    | `/proc/PID/statm`      | Process | Gauge / int64 / `By`                    | None.                                                                           |
| `process.disk.io`           | `/proc/PID/io`         | Process | Monotonic cumulative Sum / int64 / `By` | `disk.io.direction`: read, write.                                               |

Every baseline counter point also carries `pfe.counter.segment_id`. CPU and I/O values are accumulated counters, not percentages or rates. Node CPU aggregates logical CPUs and keeps guest time within user/nice. Iowait, virtual memory, and free/buffered/cached memory measurements are not exported. No gauge is aliased to a conventional metric with different aggregation semantics.

Available memory estimates allocation without swapping. RSS includes shared pages and is not private memory. Device and partition counters can describe overlapping I/O; do not sum every disk series. Process I/O measures storage accounting, not all syscall or socket traffic. Disk sectors are converted using the kernel's fixed 512-byte accounting unit. Values outside int64 byte range are omitted with an out-of-range status.

## Identity and continuity

All resources carry host identity, boot identity, source, scope, intended interval in nanoseconds and a UUIDv4 collection epoch. Instrumentation scope `pfe.collector.procfs` reports the collector package version. UUIDs come from kernel random bytes; their values do not establish chronology.

Process resources carry PID, namespace ID and incarnation `start-ticks:<decimal>`. PID and raw start ticks are read and rechecked before any process points or continuity state are created. Unverifiable incarnations are discarded. Raw start ticks and Linux clock frequency remain available as optional metadata. Derived Unix process-start timestamps are omitted, as are process counter origins whose wall-clock resolution is not established. Parent PID is descriptive context, not execution membership.

A segment remains stable only across successful, increasing-time, non-decreasing reads of the same counter stream. Reset, failed or missed reads, skipped cycles, discarded identities, device disappearance/reappearance, restart and known local loss invalidate continuity. Missing streams are removed after every scan. Loss feedback conservatively invalidates all baseline streams because partial OTLP rejection does not identify rejected streams. Scans assembled concurrently with loss, and queued scans carrying stale continuity, are discarded rather than emitted with obsolete segments.

Counters have zero start timestamps when their origin is unknown. Node CPU initially uses the boot timestamp from `/proc/stat` when it does not exceed the reading timestamp; after a clock discontinuity that cached origin is omitted. Gauges always have zero start timestamps. Derive rates only across matching identity, source, instrumentation version, dimensions, epoch and segment, following the contract's increasing-time and non-decreasing-value rules.

## Coverage and clocks

Every completed scan reports `pfe.collection.read.status` for each baseline metric on the node and each verified process, with dimension `pfe.metric.name`. Successful reads report zero; unsupported, denied, disappeared, failed, out-of-range and temporarily unavailable reads use the [contract's status codes](../../docs/telemetry-contract.md#missing-readings). Partial categories retain readable points and a failure status. Missing values are not zero; missing processes cannot receive invented identity or per-process status.

Collector-scope diagnostics include discovery status, visible-entry count, discarded-process counts for `identity_unverified` and `disappeared`, monotonic scan duration and cumulative local dropped-point counts by reason. A failed discovery reports the failure and the entries actually observed, not proof that the host has no processes. Empty successful disk discovery reports a successful category with no disk points. Periodic sampling can miss short-lived processes.

Each read has its own completion timestamp. `pfe.clock.status` is an int64 gauge with value zero (unknown), emitted at the same timestamp as `pfe.collection.scan.duration`. No synchronization estimate is verified, so uncertainty is omitted. Clock quality is never encoded in resource or point attributes. Export splitting repeats the same clock and duration points with their original resource, instrumentation scope and timestamp in every request, so each fragment retains scan-window context.

The sampler compares bracketed wall-clock readings against a monotonic anchor. A backward wall time, drift from the anchor exceeding 50 ms, or a clock-read bracket exceeding 50 ms abandons the incomplete cycle and starts a new epoch before further source reads. The threshold is a discontinuity-detection policy, not an accuracy or synchronization bound. Smaller steps and slow drift can escape immediate detection; no cross-node clock-quality guarantee follows from these checks.

## Export and privacy

Sampling, persistence and network export run independently. A memory channel holds at most 64 completed scans while the persistence worker commits batches. When that channel is full, new scans are discarded with in-memory loss feedback; committed batches remain intact. Memory-buffered scans are not recoverable after a crash. Scans never overlap; skipped scheduled cycles are not replayed. Each buffered scan is complete; the request-size limit and scan-count limit do not impose a hard byte bound on scan memory.

Requests are split to at most 1 MiB before gzip. Each receives a UUIDv7 batch ID and an explicit creation timestamp after splitting. The encoded payload, ID, creation time, epoch and point count commit to SQLite before the first send. Retries preserve these fields and array order. Queue order follows a database sequence, not UUID or source timestamps. Changing the endpoint requires a separate queue directory, preventing pending data from being sent to another destination accidentally.

The queue holds at most the configured payload bytes and batch count. When full, it retains pending batches and discards new batches with reason `buffer_full`. SQLite uses `synchronous=FULL`, a rollback journal and a 1 MiB page cache. Its database page cap is twice the payload limit plus 512 bytes per allowed batch and 1 MiB of overhead, rounded up to a page. A temporary rollback journal requires additional disk space. Deleted pages are reused; the database does not shrink after draining. Storage errors stop collection and preserve already committed batches rather than silently clearing them. New queue directories use mode 0700. Existing directories must already have that mode; their permissions are left unchanged. The database uses mode 0600; telemetry is not encrypted at rest.

One batch is exported at a time, with a three-second request timeout. Retryable [OTLP failures](https://opentelemetry.io/docs/specs/otlp/#failures) retain the batch and use exponential backoff with jitter, capped at 30 seconds unless the server asks for longer through `RetryInfo`. Capacity rejection is retryable only with valid `RetryInfo`. A successful response removes the batch. Partial success is never retried; rejected counts are recorded without guessing which streams were rejected. Terminal rejection and local expiry remove the batch and atomically retain discarded-point counts by reason in SQLite.

The lifetime starts at original batch creation. System-time age is checked before each attempt; monotonic elapsed time also bounds retries while that batch is active. Clock changes across process restarts can affect expiry. Local lifetime is not enrollment's submission-age policy. The collector still omits the external profile header; source admission policy is configured separately at ingestion.

SIGINT/SIGTERM finishes acquisition, drains the scan buffer to disk, cancels network export and leaves pending batches on disk. A slow disk can delay graceful shutdown; forced termination can lose scans that have not committed. A restart recovers pending batches unchanged and starts a new collection epoch. A lost acknowledgement or a crash after receiver acceptance but before local deletion can cause duplicate delivery. Receiver deduplication is required to prevent duplicate measurements; stable batch IDs alone do not provide it. Successful ingestion confirms Kafka publication; it does not mean Parquet processing has finished.

Loss feedback invalidates baseline counter continuity for subsequent scans. Current-epoch cumulative loss diagnostics can appear in later captures; SQLite's persisted-batch loss totals survive restarts, while exported current-epoch counters reset. Already enqueued observations retain their original segments and timestamps. The queue cannot recover measurements that were never committed, including an interrupted scan, or survive disk loss.

Enrollment is configured through local source policies. Production TLS, automatic enrollment, execution associations and application instrumentation in this collector remain unimplemented. Application instrumentation uses standard OpenTelemetry SDKs; this collector gathers external Linux measurements.

Only allowlisted identity and metric dimensions are exported. Parsing `/proc/PID/stat` reads a process-name field and discards it. The sampler does not read command arguments, environment, executable links, application files or process memory. Host identity is read from machine/boot metadata or supplied through configuration; namespace identity is supplied by deployment. Neither process contents nor receiver-supplied free-form errors are logged.

Local connection failures wrapped by Tonic as `UNKNOWN` retain their underlying error and retry. A server-supplied `UNKNOWN` status remains terminal under the OTLP failure table.

## Authenticated ingestion

`TELEMETRY_COLLECTOR_SOURCE_TOKEN_FILE` reads a source bearer token from a private file at startup and sends it as gRPC authorization metadata. Tokens must contain 32-512 printable ASCII characters; a trailing newline is removed. The exporter can run without a token, but the configured ingestion service rejects unauthenticated requests. The [telemetry pipeline](../../infra/telemetry/README.md) requires enrolled credentials and permitted host IDs.

The queue is bound to the destination and token digest. Changing credentials refuses the existing queue, preventing pending data from silently moving to another enrolled source. Credential rotation and queue migration are not implemented. Use a new queue directory while retaining the old queue for its original identity.

## Sources

- [procfs 0.18.0](https://docs.rs/procfs/0.18.0/procfs/)
- [Linux proc accounting](https://docs.kernel.org/filesystems/proc.html)
- [Linux disk statistics](https://docs.kernel.org/admin-guide/iostats.html)
- [UUIDv4](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.4)
