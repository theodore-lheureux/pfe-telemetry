# Linux collector

`recount-collector` samples Linux node and visible-process resources and sends OTLP/gRPC metrics to the [ingestion API](../ingestion-api/README.md). Collection follows the [telemetry point contract](../../docs/telemetry-point-contract.md). Export uses a persistent queue with byte, batch-count and age limits, immutable batch metadata and `recount-collection-profile: linux`.

The executable requires Linux and `/proc`. Linux dependencies are target-gated; running the executable on another OS returns an unsupported-platform error. Enrolled collectors run as root and discover execution membership from environment labels, independently of metrics.

## NVIDIA GPU telemetry

The collector automatically loads an installed `libdcgm.so.4`, reuses the local host engine or owns an embedded engine, and discovers physical GPU and verified MIG UUIDs. No GPU configuration, exporter or CUDA toolkit is required. Missing NVIDIA facilities leave CPU/process collection running without invented GPU values.

DCGM profiling supplies FP16/FP32/FP64/Tensor-pipe activity, SM activity/occupancy, engine/DRAM activity and supported PCIe/NVLink rates. Core gauges cover utilization, framebuffer memory, power, temperature, SM/memory clocks and ECC/XID errors. The [GPU collection design](../../docs/nvidia-gpu-collection.md) defines fields, units, identity, licensing and capability limits.

Acquisition uses a separate bounded worker at one second or the collector interval when slower. Only owned watches/groups are removed. Native cache timestamps are retained; repeated, stale, unsupported, denied and blank values produce read statuses rather than zero. The collector does not pause profilers, enable accounting or change MIG configuration. Monitoring can still contend with developer profilers.

Each completed acquisition can also report node histograms of physical-GPU utilization, used memory and power. Each fresh board reading contributes once; MIG slices do not enter these histograms. `recount.collection.gpu.coverage` reports the contributing device count for each signal.

New Linux enrollment keys allow local GPU resources. Explicit or existing policies that omit GPU kind suppress GPU acquisition/export without rejecting CPU/process batches. A successful empty startup inventory stays CPU-only until restart.

Safe runtime-loaded NVML supplements DCGM with process allocation bytes and supported SM/memory activity on the existing process identities. With verified host PID visibility and GPU/process grants, existing environment-labelled executions receive those process points automatically. CPU identities bracket the actual GPU queries and are rechecked afterward. Unknown/reused PIDs, ambiguous windows and missing samples are omitted or unavailable; buffered utilization warms up for two acquisition intervals, while current allocation does not need that history.

DCGM's pipe/SM profiling remains on GPU/MIG resources: public PID/job reports expose no per-pipe breakdown. No accounting modes are enabled and no device power/activity is divided among processes. Owner-recorded A10 fixtures cover vendor capabilities and load-dependent device values, including unoffered FP64; collector-on-hardware and process-attribution validation remain pending. Driver-free fake-entity integration is not a hardware-support claim. The templates rework is already on the base, so no GPU-specific dashboard, page or component is added.

## Configuration

`recount-collector --help` lists command-line equivalents. Command-line arguments override environment variables; settings are read once at startup.

| Variable                                  | Default                                         | Meaning                                                                                             |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | `http://127.0.0.1:14317`                        | OTLP/gRPC ingestion endpoint.                                                                       |
| `RECOUNT_COLLECTOR_ENROLLMENT_URL`        | Unset                                           | Web application URL that enrolls the node and renews its access tokens.                             |
| `RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE`   | Unset                                           | Private file containing the project enrollment key; needed only until the node has enrolled.        |
| `RECOUNT_COLLECTOR_STATE_DIRECTORY`       | `.state/collector`                              | Private directory for the node identity, `node.json` and `node.key`.                                |
| `RECOUNT_COLLECTOR_PARTICIPANTS_CONFIG`   | Unset                                           | Optional root-owned JSON execution-discovery settings; enrollment enables the defaults below.       |
| `RECOUNT_COLLECTOR_INTERVAL_MS`           | `1000`                                          | Intended sampling period, between 100 and 60000 ms.                                                 |
| `RECOUNT_COLLECTOR_TCP_RTT`               | `false`                                         | Sample smoothed RTT of established TCP sockets in the collector's network namespace.                |
| `RECOUNT_COLLECTOR_HOST_ID`               | `/etc/machine-id`                               | Host resource and enrolled machine ID, 1–128 UTF-8 bytes. Cloned machines need distinct values.     |
| `RECOUNT_COLLECTOR_VISIBILITY`            | `restricted`                                    | `host` only when deployment has verified enumeration of initial host PIDs; otherwise `restricted`.  |
| `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` with host visibility; required otherwise | Verified boot-local PID namespace identity, 1–128 UTF-8 bytes.                                      |
| `RECOUNT_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`                        | Private persistent queue directory on a local filesystem; one collector per directory.              |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                                      | Maximum queued Protobuf payload bytes, between 1 MiB and 1 GiB.                                     |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                                          | Maximum pending batches, between 1 and 65536.                                                       |
| `RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                                          | Local batch lifetime, 1–18446744073 seconds; choose no greater than the enrolled source upload age. |
| `RUST_LOG`                                | `info`                                          | Diagnostic logging filter.                                                                          |

On an enrolled Linux host with initial-host process visibility:

```sh
RECOUNT_COLLECTOR_VISIBILITY=host \
  RECOUNT_COLLECTOR_ENROLLMENT_URL=https://recount.example \
  RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE=/etc/recount-collector/enrollment.key \
  RECOUNT_COLLECTOR_STATE_DIRECTORY=/var/lib/recount-collector/node \
  recount-collector
```

Setting visibility to `host` is a deployment assertion, not a permission probe. It requires process namespace ID `host`. Restricted collection requires an explicit namespace ID whose lifetime deployment has verified within the boot; use `host` for a narrower view of initial-host PIDs, or a separately assigned namespace identity for a PID namespace. A namespace inode alone can be reused and is not inferred as an incarnation-safe ID. Procfs self-PID numbering must match the collector's namespace. Neither mode guarantees readable I/O for every process. Do not declare host visibility for a PID namespace, filtered proc mount or restricted process view.

Changing configuration requires restarting the collector and starts a new epoch. The node enrolls with its host ID as the machine ID, and its access token grants that host as its only root, with the adapter and local process kinds of the enrollment key. One root grant covers its local processes without per-PID enrollment. Neither root permission nor reported placement attests physical ownership.

## TCP round-trip time

Enable `--tcp-rtt` only where policy permits local socket diagnostics. The worker takes a read-only IPv4 and IPv6 snapshot in the collector's current network namespace, at most once per 10 seconds. It does not send probes or require a host network namespace. Each initialized smoothed RTT contributes one observation in seconds to `recount.node.tcp.rtt.distribution`. This is a socket snapshot, not per-packet latency. No addresses, ports, socket IDs or owners are exported.

The worker discards the snapshot if either dump fails, is interrupted or exceeds 4,096 socket records, 2 MiB received or 50 ms. On failure it reports `recount.collection.tcp.rtt.status` and waits at least 30 seconds to retry. A successful snapshot reports `recount.collection.tcp.rtt.coverage`, including zero if nothing contributed.

## Baseline measurements

Process histograms cover all verified visible observations, whether or not the collector exports individual detail. CPU and disk observations require a valid adjacent read; RSS is a snapshot and may count shared pages more than once. Missing measurements are not zero.

The collector exports details for at most 64 processes per scan by default. Tracked executions take priority; other candidates are the top 16 by CPU or RSS and processes that cross a detail threshold. Set `RECOUNT_COLLECTOR_PROCESS_DETAIL_CAP` to change the cap, or to `0` to profile all verified visible processes on a node. The threshold defaults are `50` for `RECOUNT_COLLECTOR_PROCESS_DETAIL_CPU_PERCENT` (percentage of one logical CPU), `1073741824` for `RECOUNT_COLLECTOR_PROCESS_DETAIL_RSS_BYTES`, and `10485760` for `RECOUNT_COLLECTOR_PROCESS_DETAIL_IO_BYTES_PER_SECOND` (read plus write).

To profile only while a selected execution is observed on a node, set `"profile_executions": ["slurm:123"]` in that node's root-owned participant configuration. A fresh, admitted membership that still matches a visible process incarnation enables full node detail for the scan. This is a collection setting, not an access grant. On shared nodes, account for the fact that users who can set an execution label can claim a configured key. Full detail raises queue and ingestion volume and does not guarantee that otherwise unreadable process metrics become available.

| Metric                          | Source                 | Scope   | OTLP value / unit                       | Dimensions                                                                      |
| ------------------------------- | ---------------------- | ------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `recount.node.cpu.time`         | `/proc/stat` aggregate | Node    | Monotonic cumulative Sum / double / `s` | `cpu.mode`: user, nice, system, idle, interrupt, softirq, steal when supported. |
| `recount.node.memory.total`     | `/proc/meminfo`        | Node    | Gauge / int64 / `By`                    | None.                                                                           |
| `recount.node.memory.available` | `/proc/meminfo`        | Node    | Gauge / int64 / `By`                    | None.                                                                           |
| `system.disk.io`                | `/proc/diskstats`      | Node    | Monotonic cumulative Sum / int64 / `By` | `system.device`: `block:<major>:<minor>`; `disk.io.direction`: read, write.     |
| `process.cpu.time`              | `/proc/PID/stat`       | Process | Monotonic cumulative Sum / double / `s` | `cpu.mode`: user, system.                                                       |
| `recount.process.memory.rss`    | `/proc/PID/statm`      | Process | Gauge / int64 / `By`                    | None.                                                                           |
| `process.disk.io`               | `/proc/PID/io`         | Process | Monotonic cumulative Sum / int64 / `By` | `disk.io.direction`: read, write.                                               |

Every baseline counter point also carries `recount.counter.segment_id`. CPU and I/O values are accumulated counters, not percentages or rates. Node CPU aggregates logical CPUs and keeps guest time within user/nice. Iowait, virtual memory, and free/buffered/cached memory measurements are not exported. No gauge is aliased to a conventional metric with different aggregation semantics.

Available memory estimates allocation without swapping. RSS includes shared pages and is not private memory. Device and partition counters can describe overlapping I/O; do not sum every disk series. Process I/O measures storage accounting, not all syscall or socket traffic. Disk sectors are converted using the kernel's fixed 512-byte accounting unit. Values outside int64 byte range are omitted with an out-of-range status.

## Identity and continuity

All resources carry `host.id`, `recount.host.boot_id`, collection source, `recount.collection.scope`, intended interval in nanoseconds and UUIDv4 `recount.collection.epoch_id`. Instrumentation scope `recount.collector.procfs` reports the collector package version. UUIDs come from kernel random bytes; their values do not establish chronology. Ingestion resolves node/collector resources to the enrolled root and process resources to deterministic root-local identities using boot, namespace, PID and start ticks. Token renewal preserves these identities.

Process resources carry PID, namespace ID and incarnation `start-ticks:<decimal>`. PID and raw start ticks are read and rechecked before any process points or continuity state are created. Unverifiable incarnations are discarded. Raw start ticks and Linux clock frequency remain available as optional metadata. Derived Unix process-start timestamps are omitted, as are process counter origins whose wall-clock resolution is not established. Parent PID alone does not establish execution membership.

A segment remains stable only across successful, increasing-time, non-decreasing reads of the same counter stream. Reset, failed or missed reads, skipped cycles, discarded identities, device disappearance/reappearance, restart and known local loss invalidate continuity. Missing streams are removed after every scan. Loss feedback conservatively invalidates all baseline streams because partial OTLP rejection does not identify rejected streams. Scans assembled concurrently with loss, and queued scans carrying stale continuity, are discarded rather than emitted with obsolete segments.

Counters have zero start timestamps when their origin is unknown. Node CPU initially uses the boot timestamp from `/proc/stat` when it does not exceed the reading timestamp; after a clock discontinuity that cached origin is omitted. Gauges always have zero start timestamps. Derive rates only across matching identity, source, instrumentation version, dimensions, epoch and segment, following the contract's increasing-time and non-decreasing-value rules.

## Coverage and clocks

Every completed scan reports `recount.collection.read.status` for each baseline metric on the node and each verified process, with dimension `recount.metric.name`. Successful reads report zero; unsupported, denied, disappeared, failed, out-of-range and temporarily unavailable reads use the [contract's status codes](../../docs/telemetry-contract.md#missing-readings). Partial categories retain readable points and a failure status. Missing values are not zero; missing processes cannot receive invented identity or per-process status.

Collector-scope diagnostics include discovery status, visible-entry count, discarded-process counts for `identity_unverified` and `disappeared`, monotonic scan duration and cumulative local dropped-point counts by reason. A failed discovery reports the failure and the entries actually observed, not proof that the host has no processes. Empty successful disk discovery reports a successful category with no disk points. Periodic sampling can miss short-lived processes.

Each read has its own completion timestamp. `recount.clock.status` is an int64 gauge with value zero (unknown), emitted at the same timestamp as `recount.collection.scan.duration`. No synchronization estimate is verified, so uncertainty is omitted. Clock quality is never encoded in resource or point attributes. Export splitting repeats the same clock and duration points with their original resource, instrumentation scope and timestamp in every request, so each fragment retains scan-window context.

The sampler compares bracketed wall-clock readings against a monotonic anchor. A backward wall time, drift from the anchor exceeding 50 ms, or a clock-read bracket exceeding 50 ms abandons the incomplete cycle and starts a new epoch before further source reads. The threshold is a discontinuity-detection policy, not an accuracy or synchronization bound. Smaller steps and slow drift can escape immediate detection; no cross-node clock-quality guarantee follows from these checks.

## Export and privacy

Each upload carries bounded `recount-delivery-bin` metadata for the TCP connection used by that attempt. It includes a connection ID, connection timestamp, local and peer socket addresses, hostname, kernel release, collector architecture and a timestamped network-interface inventory. Interfaces report names, assigned IPv4/IPv6 addresses, up/loopback flags and six-byte MAC addresses when available. Loopback and unavailable MACs are omitted. Inventory refreshes on connection establishment and after 60 seconds on the next upload using that connection, independently of metric sampling.

`local_interface_names` lists interfaces whose assigned address matches the socket's local IP at inventory time. These are assignment matches, not proof of physical egress. Multiple matches remain visible; no default-route guess resolves them. Containers expose their own network namespace, and VPNs, routing policy or tunnels can hide the underlying physical interface. No external public-IP service is contacted.

Connection metadata is limited to 4096 encoded bytes, at most 32 interfaces and 32 addresses per interface. Missing inventory reports `unavailable`; invalid entries report `partial`. Count or byte truncation is explicit. Collection uses a blocking worker, not the sampling loop. Diagnostics can differ between delivery attempts while the queued OTLP payload, batch identity and sampled points remain unchanged. A failed gRPC call discards its connection; a later attempt establishes a new observed connection rather than silently reconnecting with old socket metadata.

Ingestion separately records its socket peer address and ignores forwarded-address headers. That observation can differ from the collector's local address because of NAT or proxies; neither address is necessarily public. Reported hostname, IPs and MACs are sensitive diagnostic context, not enrolled identity or authorization evidence. Accepted raw packets retain the full bounded observation until Kafka retention expires. Point lineage retains connection/observation timestamps, socket addresses, hostname and only the matching interfaces' names, MACs, flags and local IP, not the full inventory. These fields do not add metric dimensions or change sample/stream identity. Inspect them only through project-authorized readers.

Sampling, persistence and network export run independently. A memory channel holds at most 64 completed scans while the persistence worker commits batches. When that channel is full, new scans are discarded with in-memory loss feedback; committed batches remain intact. Memory-buffered scans are not recoverable after a crash. Scans never overlap; skipped scheduled cycles are not replayed. Each buffered scan is complete; the request-size limit and scan-count limit do not impose a hard byte bound on scan memory.

Requests are split to at most 1 MiB before gzip. Each receives a UUIDv7 batch ID and an explicit creation timestamp after splitting. The encoded payload, ID, creation time, epoch and point count commit to SQLite before the first send. Retries preserve these fields and array order. Queue order follows a database sequence, not UUID or source timestamps. The queue is bound to the endpoint and node ID; changing either requires a separate queue directory, preventing pending data from being sent to another destination or source accidentally.

The queue holds at most the configured payload bytes and batch count. When full, it retains pending batches and discards new batches with reason `buffer_full`. SQLite uses `synchronous=FULL`, a rollback journal and a 1 MiB page cache. Its database page cap is twice the payload limit plus 512 bytes per allowed batch and 1 MiB of overhead, rounded up to a page. A temporary rollback journal requires additional disk space. Deleted pages are reused; the database does not shrink after draining. Storage errors stop collection and preserve already committed batches rather than silently clearing them. New queue directories use mode 0700. Existing directories must already have that mode; their permissions are left unchanged. The database uses mode 0600; telemetry is not encrypted at rest.

SQLx provides one asynchronous SQLite connection, shared by persistence and export. Shutdown waits for the database worker to close before releasing the queue lock. The bundled SQLite runtime is 3.51.3, replacing rusqlite's bundled 3.53.2 without changing the queue schema. The collector directly initializes the `settings`, `batches` and `losses` tables and guards them with `PRAGMA user_version=1`; version 0 permits initialization and other versions are rejected. There is no queue migration history or conversion step. PostgreSQL application migrations remain separate and Drizzle-owned.

One batch is exported at a time, with a three-second request timeout. Retryable [OTLP failures](https://opentelemetry.io/docs/specs/otlp/#failures) retain the batch and use exponential backoff with jitter, capped at 30 seconds unless the server asks for longer through `RetryInfo`. Capacity rejection is retryable only with valid `RetryInfo`. A successful response removes the batch. Partial success is never retried; rejected counts are recorded without guessing which streams were rejected. Terminal rejection and local expiry remove the batch and atomically retain discarded-point counts by reason in SQLite.

The lifetime starts at original batch creation. System-time age is checked before each attempt; monotonic elapsed time also bounds retries while that batch is active. Clock changes across process restarts can affect expiry. Local lifetime is separate from enrollment's upload-age policy; configure the queue lifetime no greater than the source upload age. Neither policy limits individual measurement age or rewrites timestamps.

SIGINT/SIGTERM finishes acquisition, drains the scan buffer to disk, cancels network export and leaves pending batches on disk. A slow disk can delay graceful shutdown; forced termination can lose scans that have not committed. A restart recovers pending batches unchanged and starts a new collection epoch. A lost acknowledgement or a crash after receiver acceptance but before local deletion can cause duplicate delivery. Receiver deduplication is required to prevent duplicate measurements; stable batch IDs alone do not provide it. Successful ingestion confirms Kafka publication; it does not mean ClickHouse processing has finished.

Loss feedback invalidates baseline counter continuity for subsequent scans. Current-epoch cumulative loss diagnostics can appear in later captures; SQLite's persisted-batch loss totals survive restarts, while exported current-epoch counters reset. Already enqueued observations retain their original segments and timestamps. The queue cannot recover measurements that were never committed, including an interrupted scan, or survive disk loss.

OTLP export supports verified HTTPS endpoints and plaintext HTTP for local lab use; see [collector setup](../../docs/collector-setup.md#run-the-collector). Application instrumentation uses standard OpenTelemetry SDKs; this collector gathers external Linux measurements.

Only allowlisted identity and metric dimensions are exported, alongside the connection diagnostics above. The sampler collects the numeric real UID from `/proc/PID/status` and, for recognized Slurm scopes, the numeric job and optional step IDs from `/proc/PID/cgroup`. It does not resolve usernames or export cgroup paths. Parsing `/proc/PID/stat` reads a process-name field and discards it. The metric sampler does not read command arguments, environment, executable links, application files or process memory. Separate execution discovery reads only the bounded environment described below. Host identity is read from machine/boot metadata or supplied through configuration; namespace identity is supplied by deployment. Neither discarded process contents nor receiver-supplied free-form errors are logged.

Local connection failures wrapped by Tonic as `UNKNOWN` retain their underlying error and retry. A server-supplied `UNKNOWN` status remains terminal under the OTLP failure table.

## Execution labels

Enrollment enables execution discovery with the same node token, endpoint, sampling period, boot and process namespace as metrics. Run the enrolled collector as root. Facts follow the [execution participant contract](../../docs/execution-participants.md); OTLP measurements and process resource identities do not gain execution attributes.

For each new PID plus start-ticks incarnation, discovery reads `/proc/PID/environ` at most once, up to 65,536 bytes plus one overflow-detection byte, and verifies identity around the read. Unreadable, malformed, truncated or oversized environments supply no direct label; verified-parent inheritance below may still associate the process. Otherwise they are unknown and produce no membership. The final decision remains cached while the incarnation is alive, including unknown and fact-cap-skipped processes.

Only a validated `RECOUNT_EXECUTION` key, optional `RECOUNT_EXECUTION_NAME`, `RECOUNT_EXECUTION_VERSION`, `RECOUNT_EXECUTION_PARAMETERS` and the matched variable name are retained. Parameters must be a JSON object of unique string keys and string values. Without an explicit key, configured scheduler variables map to prefixes, defaulting to `SLURM_JOB_ID` → `slurm:<value>`. Multiple scheduler matches use bytewise variable-name order. Invalid explicit labels never fall back to scheduler discovery or a parent, including duplicate keys, invalid metadata and malformed input containing an explicit key; values are not trimmed or rewritten. Explicit metadata is ignored for scheduler keys.

Every other environment variable is discarded immediately. Raw environment bytes, discarded variable names and values are never stored, logged or sent, including in parser errors and queues. The read buffer is temporary. Process UID comes from the kernel, not the environment. Labels are attribution within the enrolled node's project, not evidence of web identity or execution ownership.

Children normally inherit labels at exec, but process-title renaming can overwrite the memory backing `/proc/PID/environ`. If no valid direct label is readable and no invalid explicit label forbids fallback, discovery inherits the label and metadata of an already-labelled, verified parent in the decision cache. The parent's current PID and start ticks must match its cached incarnation, its start ticks must be no later than the child's, and the child, current parent and cached parent must have the same known kernel UID. Equal ticks are accepted because start-time resolution is finite. The child's incarnation and parent PID are rechecked after the lookup. No label is inferred from a PID alone or across UIDs.

Inherited provenance keeps origin `ENVIRONMENT` and the parent's matched variable name; it does not add a separate wire inheritance marker. New incarnations collected within a scan are decided in ascending start-tick order, independently of proc-directory enumeration order. The lookup happens only at the child's first decision, without an ancestry walk or later retry if the parent is not yet labelled. Cached incarnations are not reread after exec or environment changes. Processes that disappear between scans or during downtime cannot be recovered. There is no launcher handoff or cgroup association.

Each labelled incarnation gets a membership fact. One rootless lifecycle spans the first to last labelled process for a key on this node and boot, retaining metadata, provenance and optional UID from the first process. Reappearance after closure creates a fresh participant. Disappearance closes coverage without inventing exit status. Unreadable identity checks preserve existing coverage without extending its last-seen time.

The optional configuration file and every ancestor must be root-owned, not writable by group/other, and not symlinks. The file must be regular and at most 65,536 bytes. Unknown settings are rejected. For example, `/etc/recount-collector/participants.json`:

```json
{
  "scheduler_variables": {
    "SLURM_JOB_ID": "slurm",
    "PBS_JOBID": "pbs",
    "LSB_JOBID": "lsf"
  },
  "max_processes": 65536,
  "max_facts": 262144,
  "max_queue_bytes": 67108864,
  "max_exports": 16,
  "heartbeat_interval_seconds": 60
}
```

An empty scheduler mapping disables scheduler discovery. Names follow the contract's environment-variable grammar and cannot use the reserved `RECOUNT_EXECUTION` prefix. Each mapping must produce a valid execution key. Limits are 1–1,000,000 cached processes, 2–1,000,000 retained facts, 65,536–1,073,741,824 queued/rejected payload bytes, and 1–64 exports before yielding.

`heartbeat_interval_seconds` defaults to 60 and accepts 1–18446744073 seconds. Scans keep `last_seen` accurate in durable local state without changing published snapshots. Open facts get a new revision only when their last published `last_seen` is at least one heartbeat interval old, or another permitted field changes. Starts, ends, retractions and coverage corrections publish immediately; a final revision includes the latest local `last_seen` even between heartbeats. Lifecycle metadata remains immutable after its initial publication. Retries and acknowledgements use immutable snapshots, not newer local observations.

Each scan checks at most `max_processes` cached identities and consumes at most `max_processes` proc-directory entries, resuming directory enumeration on subsequent scans. Cache saturation skips new reads rather than evicting live decisions. The global fact cap skips new associations without evicting live facts or retrying skipped incarnations later. Existing lifecycles still observe cap-skipped labelled processes. Bounded warnings report skipped counts; debug diagnostics report entries, environment-read attempts, unknown identity checks, cache size, discovery duration and reconciliation duration, never environment contents.

Participant state uses a separately locked private SQLite queue under `QUEUE_DIRECTORY/participants`. Revision allocation, full fact snapshots and immutable retry bytes commit together. Initial lifecycle publication must be acknowledged before memberships can upload. Retryable Claim failures retain identical bytes with backoff; token rejection triggers renewal. Deterministic rejection retains the rejected snapshot for diagnosis, without retiming it. Queue or disk exhaustion stops collection without evicting retained facts. `--drain` also drains participant facts; rejected lifecycles leave dependent memberships blocked and return an error.

Ended facts are pruned only after their final replacement is acknowledged and no queued retry depends on them. Retraction tombstones remain retained. Confirmed live membership evidence can restore IDs and revision sequences after restart without rereading its environment. Unknown decisions and cap-skipped labels have only an in-memory cache; uncertain rediscovery after restart uses fresh IDs. Old-boot coverage ends immediately after its last observation rather than extending through downtime. Losing the queue requires fresh identities, not restarting old revision sequences. No prototype claim files, schemas or queues are converted.

The participant queue schema includes separate local observation state. Earlier disposable participant queues are incompatible and must be explicitly recreated after draining with the earlier collector. Startup rejects them without deleting data; the metric queue and enrollment state are separate and must be preserved.

## Enrollment and access tokens

With `RECOUNT_COLLECTOR_ENROLLMENT_URL` set, the collector authenticates as a node of one project. [Collector enrollment](../../docs/collector-enrollment.md) describes the server side.

1. On first start the collector creates an Ed25519 private key in `node.key` and sends `POST /api/collectors/enroll` with the enrollment key, machine ID, hostname, collector version and public key. Transient failures are retried with backoff before sampling starts; a refused key stops the collector.
2. The response's node ID and project ID are written to `node.json`. Both files use mode 0600 in a 0700 directory. The enrollment key file can then be removed.
3. Later starts reuse `node.json` without the enrollment key. The collector requests one-hour access tokens from `POST /api/collectors/token`, signing `recount-collector-token`, the node ID and the current Unix time with its private key, and renews ten minutes before expiry.

Uploads send the current token as sensitive gRPC authorization metadata. When ingestion rejects a token as unauthenticated, the collector renews it and retries the unchanged batch; without a valid token, batches wait in the queue until renewal succeeds or they reach the queue lifetime. Project and source identity come from the token; submitted tenant and parent/placement attributes grant no access. Without an enrollment URL the exporter sends no authorization, which the ingestion API rejects.

A revoked node cannot renew and logs that its token was refused. To enroll the machine again as a new node, stop the collector, remove `node.json` and `node.key`, select a new queue directory and start it with an active enrollment key. Use `recount-collector --drain` with the old state and queue first to export pending batches while the old node is still active.

## Sources

- [procfs 0.18.0](https://docs.rs/procfs/0.18.0/procfs/)
- [Linux proc accounting](https://docs.kernel.org/filesystems/proc.html)
- [Linux disk statistics](https://docs.kernel.org/admin-guide/iostats.html)
- [UUIDv4](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.4)
