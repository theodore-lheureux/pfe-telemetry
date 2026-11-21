# Ingestion API

`recount-ingestion-api` accepts authenticated OTLP metrics over gRPC, authorizes enrolled roots and explicitly bound resources, checks a conservative normalized-size bound, and acknowledges only confirmed raw Kafka publication. It does not store telemetry in PostgreSQL or write ClickHouse. Traces return `UNIMPLEMENTED`; no partial OTLP success is returned.

The [telemetry point contract](../../docs/telemetry-point-contract.md) defines current messages, identities, retry behavior and semantic limits. Standard OTLP can omit Linux metadata and optional batch headers. The Linux collector sends `recount-collection-profile: linux` and immutable batch identity; its root/local adapter does not grant from payload topology.

The separate `recount.telemetry.ExecutionParticipants/Claim` RPC accepts one participant fact, using the same node token and admission semaphore. It enforces exact project/node/root scope, Linux local-kind grants and the [participant contract](../../docs/execution-participants.md), then publishes the final `AnalyticalParticipant` directly to `RECOUNT_PARTICIPANT_TOPIC` for native ClickHouse consumption. It acknowledges only confirmed Kafka publication. There is no participant normalizer or PostgreSQL execution write, and no execution attributes are added to points. Claims are uncompressed and capped at 64 KiB.

Participants use `ENVIRONMENT` provenance with the matched variable name. Lifecycle facts have no process subject; membership facts require a process incarnation and forbid metadata. Neither cgroup evidence nor exit status is accepted. A process grant is required for both kinds; no container grant is needed. Ingestion never receives or reads the process environment.

## Configuration

`recount-ingestion-api --help` generates CLI flags, environment names and defaults from their owning types. Command-line values override environment settings and defaults. `RUST_LOG` uses the standard tracing filter. Service operation requires `RECOUNT_INGESTION_DATABASE_URL`; help hides its value.

```sh
cargo run --locked -p recount-ingestion-api -- --help
cargo run --locked -p recount-ingestion-api -- --max-points 8192 validate
```

Put options before `validate`. This offline command uses startup's declaration validator without requiring database credentials, contacting backends, constructing Kafka clients or binding a socket. It does not establish backend readiness, permissions or effective broker state. Invalid declarations exit with status 2. With no subcommand, the service starts normally.

Shared limits must match the normalizer. Raw envelope capacity includes trusted metadata and can therefore reject an OTLP body below the transport limit. Raw body capacity plus a conservative 65536-byte broker-framing reserve must fit declared topic capacity. Kafka Admin checks effective `max.message.bytes` and metadata checks the exact fixed partition count before startup and during readiness checks. Producer settings derive from that declared capacity; topic auto-creation is disabled. These development defaults are not a measured fleet-capacity promise.

The seven admission/normalization defaults belong to `telemetry-validation::validate::Limits`; both applications flatten the same `LimitArgs`. Topic budgets and derived client ranges use the shared transport validator. Ingestion checks only its raw-topic boundary and needs no normalized-topic privileges. See [deployment configuration ownership](../../infra/README.md#configuration-ownership) for coordinated overrides.

The standard gRPC health endpoint reports liveness for `grpc.health.v1.Health`. Empty service, `opentelemetry.proto.collector.metrics.v1.MetricsService` and `recount.telemetry.ExecutionParticipants` report readiness of the raw metric topic and the participant topic, refreshed every five seconds, and require a node revocation list loaded within the last five minutes. Trace health is not serving.

## Authority and admission

Collectors send node access tokens signed by the web application; [collector enrollment](../../docs/collector-enrollment.md) describes how nodes obtain them. `RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS` lists the trusted base64url Ed25519 public keys, comma-separated; list two during signing-key rotation. Each submission's signature, issuer, audience and expiry are verified in memory.

The database role can read `id`, `project_id`, `organization_id`, `revoked_at` and `last_seen_at` on `ingestion.collector_node`, and can update only `last_seen_at`. It has no application/auth-schema grants. A single connection per API instance defaults to read-only and loads node revocations at startup and every 30 seconds. Submissions fail as unavailable until the first list loads; later failures keep the last list. TLS is required unless the database URL explicitly chooses `sslmode=disable`.

After polling revocations, the same connection batches the latest accepted metrics export per node in one explicit read-write transaction. Failed writes retain their entries for retry, and shutdown attempts a final flush after draining requests. The update skips revoked nodes and cannot move last-seen time backward.

At 1,000 active nodes, a busy instance can update up to 1,000 rows per 30-second flush (about 33 updates per second). No index includes `last_seen_at`. A fillfactor of 75 leaves 25% page space for HOT updates on newly filled pages; PostgreSQL does not rewrite existing pages when this setting changes. The table's autovacuum trigger is about 100 dead tuples at 1,000 live rows (`50 + 0.05 × 1,000`), so a full batch can trigger cleanup at the next worker check. This is a trigger, not a hard cap; long transactions and worker availability affect cleanup.

Token upload policy is whole seconds converted with checked arithmetic to UInt64 nanoseconds. Maximum age is positive and clock skew can be zero. Measurement timestamps are not used as upload creation time and receive no new age/future cutoff. Accepted Kafka replay does not refresh node state or source upload age.

After authentication, the token grants exactly one root: the node's machine, with the adapter and local kinds of its enrollment key. Local processes require the `linux` adapter and process-kind permission, not one enrollment or query per PID. Standard resources without claims use that root. Independent VM, device and sensor claims are rejected because node tokens grant no independent resources. Permissions allow reporting in a namespace; they do not attest hardware ownership or measurement truth.

A global Tower semaphore runs before Tonic reads, decompresses or decodes request bodies and is shared across connections. Tonic bounds decompressed bytes before Prost decoding. The ten-second request deadline bounds slow input; blocking semantic validation and projection retain the admission permit even if the RPC is cancelled. One decoded request can still allocate substantially more than its encoded bytes; these controls do not establish a peak-memory proof.

Deterministic raw/expanded/normalized size failures return terminal `RESOURCE_EXHAUSTED` without `RetryInfo` before any publication. A missing revocation list and temporary broker failures return `UNAVAILABLE`; a timed-out publication can be ambiguous, so retry unchanged. The Kafka producer uses idempotence, `acks=all` and the shared raw routing key. Acknowledgement confirms raw retention, not analytical visibility.

## Live notifications

After confirmed raw publication, ingestion queues a bounded `LiveNotification` with summary counts, node timestamps and the confirmed raw partition/offset. It contains no OTLP payload. `RECOUNT_LIVE_TOPIC` defaults to `recount.metrics.live`; `RECOUNT_LIVE_PARTITIONS` defaults to 8 and must match provisioning and the gateway. Project IDs deterministically select fixed shards; project creation does not create topics.

The separate producer batches notifications with a ten-millisecond linger and a one-second delivery timeout. Both the application queue and concurrent deliveries are limited to 128 notifications; each encoded notification is at most 32 KiB. Publication continues without viewers. Queue pressure or notification failures are logged and cannot reject accepted raw telemetry, delay its acknowledgement for a Live delivery, or change pipeline checkpoints. Live is best effort, not an acceptance audit. The [Activity reference](../web/README.md#activity) covers SSE, inspection and gateway deployment.

## Validation

Host `cargo check -p recount-ingestion-api --all-targets` compiles without running a harness. Compile Linux tests with `--no-run` and execute the generated ELF harness only in Docker. The ignored live-authority test signs node tokens itself and requires an allocated disposable PostgreSQL instance, Bun, current web migrations and `TEST_DATABASE_URL`; `RECOUNT_TEST_WEB_DIRECTORY` identifies the narrowly mounted web files. It creates and deletes only its own named disposable database/role. Full Kafka acceptance and downstream native-ingestion fault checks are separate integration gates.
