# Ingestion and reliability

The intended delivery model for our collectors is at least once with duplicate-safe storage. Accepted batches may be delivered again after a failure. Reprocessing an identified batch must not inflate sample counts or aggregates.

Target guarantees depend on storage durability, available capacity, retention, and recovery behavior.

## Acceptance and processing

The backend authenticates the collector and validates the batch before publication. It acknowledges acceptance only after the broker confirms the write under the configured policy. Without a broker, it acknowledges after a durable storage commit. An in-memory queue alone is insufficient for acceptance.

Acceptance means the batch entered the retained ingestion log or storage; it does not mean the measurements are already queryable. Expose processing progress and freshness separately. A stable identity supplied by our collector identifies the batch through acceptance and retries. OTLP services return the standard export response; the batch identity can travel in agreed gRPC metadata without changing that response body. [OTLP responses](https://opentelemetry.io/docs/specs/otlp/)

A timeout can occur after a successful write. The collector therefore retains the batch and retries with the same identity. Batch and sample identities must remain stable across retries, be scoped to their source and project, and avoid reuse after collector restarts.

Standard third-party OTLP exporters may not supply stable batch or sample identities. Their retries can create separate accepted records. A backend-assigned record identity prevents duplicates during internal replay, but does not prove that a later export request is the same client submission. Deduplication for these inputs depends on signal-specific identities and semantics; the collector guarantee does not automatically extend to every exporter. [OTLP delivery scope](https://opentelemetry.io/docs/specs/otlp/), [retained record format](serialization.md#retention-replay-and-compatibility).

## Intended guarantees

| Guarantee                        | Required behavior                                                                   | Boundary                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Confirmed acceptance             | Wait for successful publication or storage commit before replying.                  | Durability follows the configured deployment and failure model.                                       |
| Processing recovery              | Resume from committed progress after a restart.                                     | Recovery must finish before unprocessed records expire; capacity must be sufficient to catch up.      |
| Safe retries                     | Store each identified sample once and avoid repeating aggregate updates.            | Broker producer deduplication does not replace application deduplication.                             |
| Replay                           | Read retained raw records using a separate consumer or controlled checkpoint reset. | Replay availability follows retention; archived captures have a separate lifetime.                    |
| Temporary disconnection recovery | Keep pending collector batches on local disk and upload them after reconnection.    | Bounded buffers cover a finite outage, and cannot protect against losing the collector disk.          |
| One-broker failure tolerance     | Retain accepted records through a broker failure and resume service after failover. | Requires replicated brokers and a healthy controller quorum; it does not follow from a single broker. |

## Storage commits and duplicates

The worker commits its broker position only after committing the corresponding measurements. In Kafka, this position is a consumer offset; in JetStream, processing is acknowledged through the consumer.

If the worker crashes after storage succeeds but before recording progress, it receives the batch again. Measurement writes and deduplication state must be atomic, and derived aggregates must also tolerate repetition. A Parquet-based sink needs a recoverable file-publication and checkpoint mechanism before it can provide equivalent behavior.

Kafka producer idempotence handles producer retries, but a collector resubmitting an OTLP batch is an application-level retry. Kafka transactions also do not automatically include writes to an external database. [Producer idempotence](https://kafka.apache.org/43/configuration/producer-configs/#enable.idempotence), [Rust consumer guidance](https://github.com/fede1024/rust-rdkafka), [external storage semantics](https://kafka.apache.org/43/design/design/#message-delivery-semantics).

## Durability and availability

A single broker with a persistent volume supports process-restart experiments while its volume remains intact. It cannot tolerate losing that broker's storage. Kafka acknowledges log replication without requiring a physical disk flush for every write, so simultaneous host or power failures need a separate durability assessment. [Kafka persistence](https://kafka.apache.org/43/design/design/).

For the replicated Kafka test environment, use three replicas, `acks=all`, and `min.insync.replicas=2`. Keep unclean leader election disabled. Insufficient healthy replicas should cause delayed or rejected acceptance rather than silently weaker durability. Controller quorum availability must also be maintained. Broker failover does not provide redundancy for the API or analytical storage. [Replication settings](https://kafka.apache.org/43/configuration/broker-configs/#min.insync.replicas), [leader election](https://kafka.apache.org/43/configuration/topic-configs/#unclean.leader.election.enable).

No uptime, maximum outage duration, or dashboard latency target is established yet. Targets need a specified workload, deployment, and measured recovery capacity.

## Retention, overload, and time

Broker retention and collector buffers are bounded. A Kafka size limit can expire records before their age limit, and applies per partition. A promised minimum replay window therefore needs storage sized for the admitted data rate and admission control that prevents early expiry. Historical storage and exports need their own retention rules. [Kafka retention](https://kafka.apache.org/43/configuration/topic-configs/).

Monitor backlog age, remaining disk capacity, collector buffer use, dropped samples, and processing failures. Near capacity, reject or delay new batches according to an explicit policy. If a record is evicted or cannot be processed, retain a visible gap or failure record instead of presenting a complete capture.

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
