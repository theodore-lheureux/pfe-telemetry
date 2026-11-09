# Ingestion and reliability

Recount uses at-least-once delivery with stable sample identities and duplicate-safe queries. Accepted submissions may be delivered again after a failure. Physical rows can contain retries; calculations must deduplicate before counting or aggregating samples.

Target guarantees depend on storage durability, available capacity, retention, and recovery behavior.

## Acceptance and processing

The ingestion API authenticates the source, resolves bounded root/resource grants and validates the whole submission, including exact normalized-output limits, before raw Kafka publication. It acknowledges acceptance only after Kafka confirms the write under the configured policy. There is no direct-storage acceptance path. Deterministic limit failures reject the whole submission before publication.

Acceptance means the submission entered the retained raw log; it does not mean the measurements are already queryable. Different parts of a submission can become visible at different times. An empty chart is not proof of completeness or ingestion health. A stable identity supplied by the collector identifies the batch through acceptance and retries. OTLP returns the standard export response; batch identity travels in [current gRPC metadata](telemetry-point-contract.md#sample-identity-and-retry-rules), not a custom response body. [OTLP responses](https://opentelemetry.io/docs/specs/otlp/)

A timeout can occur after a successful write. The collector therefore retains the batch and retries with the same identity. Batch and sample identities must remain stable across retries, be scoped to their source and project, and avoid reuse after collector restarts.

Standard third-party OTLP exporters may not supply stable batch or sample identities. Their retries can create separate accepted records. A backend-assigned record identity prevents duplicates during internal replay, but does not prove that a later export request is the same client submission. Deduplication for these inputs depends on signal-specific identities and semantics; the collector guarantee does not automatically extend to every exporter. [OTLP delivery scope](https://opentelemetry.io/docs/specs/otlp/), [retained record format](serialization.md#retention-and-replay).

## Intended guarantees

| Guarantee                        | Required behavior                                                                   | Boundary                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Confirmed acceptance             | Wait for confirmed raw Kafka publication before replying.                           | Durability follows the configured deployment and failure model.                                       |
| Processing recovery              | Resume from committed progress after a restart.                                     | Recovery must finish before unprocessed records expire; capacity must be sufficient to catch up.      |
| Safe retries                     | Preserve sample IDs and deduplicate before duplicate-sensitive calculations.        | Physical rows can repeat; broker producer deduplication does not replace query deduplication.         |
| Replay                           | Read retained raw records using a separate consumer or controlled checkpoint reset. | Replay availability follows retention; archived captures have a separate lifetime.                    |
| Temporary disconnection recovery | Keep pending collector batches on local disk and upload them after reconnection.    | Bounded buffers cover a finite outage, and cannot protect against losing the collector disk.          |
| One-broker failure tolerance     | Retain accepted records through a broker failure and resume service after failover. | Requires replicated brokers and a healthy controller quorum; it does not follow from a single broker. |

## Storage commits and duplicates

The normalizer awaits every required bare point-record acknowledgement before acknowledging input to RustStream. Tracked prefixes are stored and periodically committed by the framework/native client; there is no manual per-input confirmation slot. ClickHouse's `ProtobufSingle` Kafka source and non-aggregating view store rows before advancing downstream offsets. PostgreSQL participates in neither boundary.

Crashing after output/storage but before confirmed progress can replay samples. Stable original sample IDs and event-day partitions let `ReplacingMergeTree` and calculation-appropriate query deduplication collapse immutable retries. The current scalar reader uses bounded `FINAL` before bucket selection. There is no PostgreSQL telemetry claim, whole-batch visibility gate or permanent first-content-wins registry. Reusing an immutable producer ID with changed content violates the protocol and has undefined competing-row results. Malformed retained records fail visibly without skipping their checkpoint. See [execution analytics](execution-telemetry.md#storage-and-visibility) for publication and visibility boundaries; Kafka offsets and external storage are not transactional.

Kafka producer idempotence handles producer retries, but a collector resubmitting an OTLP batch is an application-level retry. Kafka transactions also do not automatically include writes to an external database. [Producer idempotence](https://kafka.apache.org/43/configuration/producer-configs/#enable.idempotence), [Rust consumer guidance](https://github.com/fede1024/rust-rdkafka), [external storage semantics](https://kafka.apache.org/43/design/design/#message-delivery-semantics).

## Durability and availability

A single broker with a persistent volume supports process-restart experiments while its volume remains intact. It cannot tolerate losing that broker's storage. Kafka acknowledges log replication without requiring a physical disk flush for every write, so simultaneous host or power failures need a separate durability assessment. [Kafka persistence](https://kafka.apache.org/43/design/design/).

The local stack has one broker and one replica, uses `acks=all`, and disables unclean leader election. It does not provide broker disk-loss tolerance. A future replicated deployment would need a healthy controller quorum and an explicit replication/minimum-in-sync policy, such as three replicas with `min.insync.replicas=2`. Insufficient replicas must not silently weaken acceptance. Broker failover alone does not provide API or analytical-storage redundancy. [Replication settings](https://kafka.apache.org/43/configuration/broker-configs/#min.insync.replicas), [leader election](https://kafka.apache.org/43/configuration/topic-configs/#unclean.leader.election.enable).

No uptime, maximum outage duration, or dashboard latency target is established yet. Targets need a specified workload, deployment, and measured recovery capacity.

## Retention, overload, and time

Broker retention and collector buffers are bounded. A Kafka size limit can expire records before their age limit, and applies per partition. A promised minimum replay window therefore needs storage sized for the admitted data rate and admission control that prevents early expiry. Historical storage and exports need their own retention rules. [Kafka retention](https://kafka.apache.org/43/configuration/topic-configs/).

Inspect backlog age, disk capacity, collector buffers and errors separately from charts. Normalizer startup rejects missing/out-of-range checkpoints and never selects an implicit earliest/latest suffix. These are initial snapshots: later native errors remain logged while the process may continue, without an automatic non-ready transition. Handler validation/publication failures globally stop unfinished processing rather than skip it. Fresh groups require explicit initialization. A gap can be unrecoverable; bounded retention is not an outage guarantee.

Kafka orders records within each partition. This order does not establish measurement chronology across nodes. Preserve source timestamps, receipt timestamps, and source sequence information so analysis can handle late data, restarts, and clock differences. [Kafka consumer positions](https://kafka.apache.org/43/design/design/#consumer-position).

## Validation scenarios

Use deterministic sample identities and compare the accepted set with stored results. Counts alone can hide a missing sample replaced by a duplicate.

| Scenario                                                               | Expected result                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pause the storage task while keeping ingestion active, then resume it. | Accepted batches remain retained and are stored after recovery, before expiry.                   |
| Crash after a storage commit but before recording consumer progress.   | The batch is redelivered without duplicate measurements or aggregate changes.                    |
| Lose an export response after publication, then resend the batch.      | Retrying with the same identity produces the same stored measurements.                           |
| Disconnect a collector or stop the backend, then restore connectivity. | Batches within the local buffer survive and upload after recovery; any overflow is reported.     |
| Replay retained records into a new analysis version.                   | Raw identities and measurements are preserved; results identify the analysis version.            |
| Stop one broker in the replicated test environment.                    | Accepted records remain recoverable; ingestion resumes with sufficient replicas and controllers. |
| Remove enough replicas to fall below the write requirement.            | New acceptance stops rather than weakening the acknowledgement policy.                           |
| Reach buffer, disk, or retention limits.                               | Rejection, expiry, and gaps are visible; resource use stays bounded.                             |
| Inject late samples and clock differences across nodes.                | Analysis distinguishes collection time from arrival order and shows uncertainty.                 |

Record collector overhead, accepted data rate, backlog age, recovery time, and sample-to-query delay for baseline and competing-workload runs. Failure tests establish behavior under their stated conditions; performance targets need separate measurements.
