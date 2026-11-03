# Telemetry ingestion and storage

`pfe-server` accepts OTLP/gRPC metrics after authenticating a source, validating the whole request and receiving Kafka's publication confirmation. `pfe-storage` consumes retained envelopes into ClickHouse. Traces still return `UNIMPLEMENTED`. TanStack Start handles the web application and authorizes execution queries.

From the repository root:

```sh
TELEMETRY_INGESTION_DATABASE_URL='postgresql://pfe_ingestion:LOCAL_PASSWORD@localhost:15432/pfe?sslmode=disable' cargo run --locked -p pfe-server
cargo run --locked -p pfe-server --bin pfe-storage
cargo test --locked -p pfe-server
# With disposable TEST_DATABASE_URL, Bun dependencies and application migrations:
cargo test --locked -p pfe-server --test credentials --test ingestion -- --ignored
# With the same database prerequisites, Kafka and provisioned ClickHouse:
TELEMETRY_KAFKA_BOOTSTRAP=localhost:9092 cargo test --locked -p pfe-server --test pipeline -- --ignored
```

Building requires Make and a C/C++ compiler for librdkafka. librdkafka uses its configure/Make build; its bundled release has a [CMake atomic-detection defect](https://github.com/confluentinc/librdkafka/blob/master/CHANGELOG.md). The Protobuf compiler is supplied by `protoc-bin-vendored`. The [local pipeline](../../infra/telemetry/README.md) runs the services in containers.

## Configuration

`pfe-server --help` and `pfe-storage --help` list command-line equivalents. Command-line arguments override environment variables.

| Setting                            | Default            | Meaning                                                                                                                             |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TELEMETRY_INGESTION_ADDR`         | `127.0.0.1:4317`   | gRPC listen address.                                                                                                                |
| `TELEMETRY_INGESTION_DATABASE_URL` | Unset              | Read-only access to the web application's authoritative PostgreSQL database. Without it, metrics ingestion returns `UNIMPLEMENTED`. |
| `TELEMETRY_KAFKA_BOOTSTRAP`        | `127.0.0.1:9092`   | Kafka bootstrap addresses for ingestion and storage.                                                                                |
| `TELEMETRY_KAFKA_TOPIC`            | `pfe.metrics.v1`   | Retained metrics envelopes. Provision the topic before accepting telemetry.                                                         |
| `TELEMETRY_STORAGE_KAFKA_GROUP`    | `pfe-storage`      | Storage worker consumer group.                                                                                                      |
| `TELEMETRY_CLICKHOUSE_URL`         | Required           | ClickHouse HTTP(S) endpoint; database is `telemetry`.                                                                               |
| `TELEMETRY_CLICKHOUSE_USER`        | `telemetry_writer` | Restricted SELECT/INSERT login.                                                                                                     |
| `TELEMETRY_CLICKHOUSE_PASSWORD`    | Required           | Server-only writer password.                                                                                                        |
| `RUST_LOG`                         | `info`             | Log filter.                                                                                                                         |

Project administrators create collector credentials through the web application. Each credential binds a canonical project UUID and source ID to an exact host allowlist, host requirement, submission age and clock skew. `require_host_id: false` permits resources without `host.id`; any supplied host must still be enrolled. Multiple credentials for the same source retain independent policies. Telemetry payloads and request metadata cannot override enrollment identity.

Tokens have format `pfe_<lowercase UUID>_<43 base64url characters>`. Ingestion selects `ingestion.collector_credential` by the public UUID and compares the SHA-256 digest of the complete token in constant time. Every submission reads current committed state from the authoritative database, without a credential-decision cache. Rotation replaces the digest on the same ID; the old token fails the next lookup. Revocation, deletion and expiry likewise reject subsequent lookups, including on existing gRPC connections. Expiry uses PostgreSQL statement time. A request already authenticated may finish publishing after a concurrent lifecycle change; accepted Kafka records are not revoked.

The dedicated database login needs only database `CONNECT`, `USAGE` on the `ingestion` schema and `SELECT` on `ingestion.collector_credential`; it has no access to the `app` schema and must not own either schema or its tables. [Local provisioning](../../infra/telemetry/README.md#configure-project-credentials) runs after Drizzle migrations. Rust does not create or migrate application tables. Pool size is four; acquisition and query phases each have a one-second deadline. Pool-slot waiting is limited to 500 ms, connection creation to one second, recycling to 500 ms, and PostgreSQL statements to one second. Database, timeout and policy-decoding failures return generic `UNAVAILABLE` without publication; invalid, expired and revoked tokens return generic `UNAUTHENTICATED`. No raw token, digest, connection URL or database error is logged.

PostgreSQL transport defaults to required TLS with Mozilla-root certificate and hostname verification. Set `sslmode=disable` explicitly only for the isolated local setup; plaintext fallback is never attempted. Custom CA stores and mutual TLS are not configured by this service. The collector's OTLP connection remains HTTP-only, so nonlocal deployment still requires a private authenticated transport boundary.

Requests support gzip, with a 4 MiB decoded-message limit, at most 100,000 points and 128 attributes per attribute list. Attribute nesting is limited to 16 levels; strings and byte attributes to 4 KiB. There are at most 16 admitted exports across connections, with a 10-second handler timeout and a five-second Kafka delivery deadline. Saturation and unconfirmed publication return `UNAVAILABLE`. Kafka uses producer idempotence and `acks=all`; deployment replication determines failure tolerance.

Standard OTLP input supports numeric gauges, sums, histograms, exponential histograms and summaries. Storage retains aggregation, timestamps, native numeric types and flags in typed point arrays, plus the complete supported OTLP payload in `payload_hex`. Histogram, summary, attribute and exemplar internals remain in that payload; non-scalar points have null scalar projections. The `external/1.0` validator additionally checks node/process identity fields and the baseline metric mapping. It cannot verify that a source actually attempted every read or that an execution claim is true.

Identified requests supply both `pfe-batch-id` and `pfe-batch-created-unix-nano`. The ID is a lowercase UUIDv7. Default source policy permits a one-hour submission age and 60 seconds of clock skew. Requests without a profile use standard OTLP input (`standard`); they can still use stable batch metadata. Requests without batch identity get server record IDs, so separate client resubmissions can produce duplicates.

## Publication and recovery

The retained [Protobuf envelope](proto/ingestion.proto) contains trusted identity, a server UUIDv7 record ID, receipt time, profile, client identity/time and the supported re-encoded OTLP request. Re-encoding does not preserve unknown future fields or original transport bytes.

The worker writes one complete batch row using the [ClickHouse schema](../../infra/telemetry/clickhouse/schema.sql), then queues its Kafka offset commit asynchronously. The logical key hashes `(project, source, payload kind, client batch ID)`, or the server record ID for unidentified submissions. Point array positions retain observation identity. Single-row synchronous insertion prevents partial point-array visibility; insert and directory fsync are enabled on the local MergeTree table. Delayed or failed acknowledgements and offset commits can replay already stored batches.

Kafka polling continues during idle periods, and temporary connection errors leave the consumer running for reconnection. Offset commits do not block the async runtime while the broker is unavailable.

Reprocessing checks the content digest and skips known identical batches. A conflicting batch or invalid envelope stops the worker without committing progress or overwriting the first content. Unconfirmed ClickHouse operations retry with bounded backoff while retaining the offset. Kafka retention still limits recovery. Queries deduplicate complete batches by their earliest log offset even if ambiguous inserts create physical duplicates. Keep Kafka topic/partition provenance stable and retain deduplication history. See [storage and replay](../../docs/execution-telemetry.md#storage-and-replay) for consistency and capacity limits.

## Health and access

The named `grpc.health.v1.Health` service reports process connectivity. Overall and metrics readiness follow periodic Kafka topic metadata and credential-table access checks; an empty credential table is healthy. These are not proof that a later request will succeed. Trace readiness remains `NOT_SERVING`. Exports authenticate and wait for publication confirmation independently of health status. Ctrl-C and SIGTERM trigger shutdown; interrupted storage work can replay safely.

Database integration tests create isolated databases and least-privilege logins under disposable `TEST_DATABASE_URL`, then call the existing Bun/Drizzle migrator. They never use application database state. The test login needs database and role creation privileges. Install JavaScript dependencies with `bun install --frozen-lockfile` first. Database-dependent ingestion and credential tests are explicitly ignored in the default Rust suite; run the commands above to exercise them.

The local pipeline uses plaintext transport on an isolated container network and loopback host ports. Other deployments require TLS and broker access controls. Do not log telemetry bodies, tokens or ClickHouse credentials. Direct operator SQL can read all telemetry; only application server functions enforce human tenant access.
