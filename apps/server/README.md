# Telemetry ingestion and storage

`pfe-server` accepts OTLP/gRPC metrics after authenticating a source, validating the whole request and receiving Kafka's publication confirmation. `pfe-storage` consumes retained envelopes and publishes Parquet files. Traces still return `UNIMPLEMENTED`. TanStack Start handles the web application and its application endpoints.

From the repository root:

```sh
TELEMETRY_INGESTION_DATABASE_URL='postgresql://pfe_ingestion:LOCAL_PASSWORD@localhost:15432/pfe?sslmode=disable' cargo run --locked -p pfe-server
cargo run --locked -p pfe-server --bin pfe-storage
cargo test --locked -p pfe-server
# With disposable TEST_DATABASE_URL, Bun dependencies and application migrations:
cargo test --locked -p pfe-server --test credentials --test ingestion -- --ignored
# With the same database prerequisites and a reachable Kafka broker:
TELEMETRY_KAFKA_BOOTSTRAP=localhost:9092 cargo test --locked -p pfe-server --test pipeline -- --ignored
```

Building requires Make and a C/C++ compiler for librdkafka. librdkafka uses its configure/Make build; its bundled release has a [CMake atomic-detection defect](https://github.com/confluentinc/librdkafka/blob/master/CHANGELOG.md). The Protobuf compiler is supplied by `protoc-bin-vendored`. The [local pipeline](../../infra/telemetry/README.md) runs the services and DuckDB in containers.

## Configuration

`pfe-server --help` and `pfe-storage --help` list command-line equivalents. Command-line arguments override environment variables.

| Setting                            | Default                  | Meaning                                                                                                                             |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TELEMETRY_INGESTION_ADDR`         | `127.0.0.1:4317`         | gRPC listen address.                                                                                                                |
| `TELEMETRY_INGESTION_DATABASE_URL` | Unset                    | Read-only access to the web application's authoritative PostgreSQL database. Without it, metrics ingestion returns `UNIMPLEMENTED`. |
| `TELEMETRY_KAFKA_BOOTSTRAP`        | `127.0.0.1:9092`         | Kafka bootstrap addresses for ingestion and storage.                                                                                |
| `TELEMETRY_KAFKA_TOPIC`            | `pfe.metrics.v1`         | Retained metrics envelopes. Provision the topic before accepting telemetry.                                                         |
| `TELEMETRY_STORAGE_KAFKA_GROUP`    | `pfe-storage-v1`         | Storage worker consumer group.                                                                                                      |
| `TELEMETRY_STORAGE_DIRECTORY`      | `.state/measurements/v1` | Directory owned by one storage worker.                                                                                              |
| `RUST_LOG`                         | `info`                   | Log filter.                                                                                                                         |

Project administrators create collector credentials through the web application. Each credential binds a canonical project UUID and source ID to an exact host allowlist, host requirement, submission age and clock skew. `require_host_id: false` permits resources without `host.id`; any supplied host must still be enrolled. Multiple credentials for the same source retain independent policies. Telemetry payloads and request metadata cannot override enrollment identity.

Tokens have format `pfe_<lowercase UUID>_<43 base64url characters>`. Ingestion selects `ingestion.collector_credential` by the public UUID and compares the SHA-256 digest of the complete token in constant time. Every submission reads current committed state from the authoritative database, without a credential-decision cache. Rotation replaces the digest on the same ID; the old token fails the next lookup. Revocation, deletion and expiry likewise reject subsequent lookups, including on existing gRPC connections. Expiry uses PostgreSQL statement time. A request already authenticated may finish publishing after a concurrent lifecycle change; accepted Kafka records are not revoked.

The dedicated database login needs only database `CONNECT`, `USAGE` on the `ingestion` schema and `SELECT` on `ingestion.collector_credential`; it has no access to the `app` schema and must not own either schema or its tables. [Local provisioning](../../infra/telemetry/README.md#configure-project-credentials) runs after Drizzle migrations. Rust does not create or migrate application tables. Pool size is four; acquisition and query phases each have a one-second deadline. Pool-slot waiting is limited to 500 ms, connection creation to one second, recycling to 500 ms, and PostgreSQL statements to one second. Database, timeout and policy-decoding failures return generic `UNAVAILABLE` without publication; invalid, expired and revoked tokens return generic `UNAUTHENTICATED`. No raw token, digest, connection URL or database error is logged.

PostgreSQL transport defaults to required TLS with Mozilla-root certificate and hostname verification. Set `sslmode=disable` explicitly only for the isolated local setup; plaintext fallback is never attempted. Custom CA stores and mutual TLS are not configured by this service. The collector's OTLP connection remains HTTP-only, so nonlocal deployment still requires a private authenticated transport boundary.

Requests support gzip, with a 4 MiB decoded-message limit, at most 100,000 points and 128 attributes per attribute list. Attribute nesting is limited to 16 levels; strings and byte attributes to 4 KiB. There are at most 16 admitted exports across connections, with a 10-second handler timeout and a five-second Kafka delivery deadline. Saturation and unconfirmed publication return `UNAVAILABLE`. Kafka uses producer idempotence and `acks=all`; deployment replication determines failure tolerance.

Standard OTLP input supports numeric gauges, sums, histograms, exponential histograms and summaries. Storage retains aggregation, timestamps, native numeric types, flags, attributes and encoded points. Histogram and summary internals remain available in `point_proto`; scalar SQL views target gauges and sums. The `external/1.0` validator additionally checks node/process identity fields and the baseline metric mapping. It cannot verify that a source actually attempted every read or that an execution claim is true.

Identified requests supply both `pfe-batch-id` and `pfe-batch-created-unix-nano`. The ID is a lowercase UUIDv7. Default source policy permits a one-hour submission age and 60 seconds of clock skew. Requests without a profile use standard OTLP input (`standard`); they can still use stable batch metadata. Requests without batch identity get server record IDs, so separate client resubmissions can produce duplicates.

## Publication and recovery

The retained [Protobuf envelope](proto/ingestion.proto) contains trusted identity, a server UUIDv7 record ID, receipt time, profile, client identity/time and the supported re-encoded OTLP request. Re-encoding does not preserve unknown future fields or original transport bytes.

The worker writes one Snappy-compressed Parquet file per nonempty batch using the [versioned measurement schema](schema/measurements-v1.parquet.schema). Its filename hashes `(project, source, payload kind, client batch ID)`, or the server record ID for unidentified submissions. Array positions identify points within a batch. A temporary file becomes visible only after the complete file is written and synced. The worker renames it, syncs the containing directory, then queues its Kafka offset commit asynchronously. Delayed or failed commits can replay already stored batches.

Kafka polling continues during idle periods, and temporary connection errors leave the consumer running for reconnection. Offset commits do not block the async runtime while the broker is unavailable.

The published file also stores the deduplication key and content digest. Reprocessing an identical batch checks that metadata and retains the original file. A conflicting batch ID, damaged file, unsupported envelope or storage failure stops the worker without committing progress or overwriting existing measurements. Kafka retains the pending record within its retention policy. Restart after correcting the cause.

One worker owns the output directory through a file lock. Parquet files are the query boundary; the worker and query process do not share a writable DuckDB database. Published files also retain deduplication state. Deleting them while retained Kafka records can replay permits those measurements to be published again. File compaction, historical retention, multiple storage writers and derived aggregates are not implemented.

## Health and access

The named `grpc.health.v1.Health` service reports process connectivity. Overall and metrics readiness follow periodic Kafka topic metadata and credential-table access checks; an empty credential table is healthy. These are not proof that a later request will succeed. Trace readiness remains `NOT_SERVING`. Exports authenticate and wait for publication confirmation independently of health status. Ctrl-C and SIGTERM trigger shutdown; interrupted storage work can replay safely.

Database integration tests create isolated databases and least-privilege logins under disposable `TEST_DATABASE_URL`, then call the existing Bun/Drizzle migrator. They never use application database state. The test login needs database and role creation privileges. Install JavaScript dependencies with `bun install --frozen-lockfile` first. Database-dependent ingestion and credential tests are explicitly ignored in the default Rust suite; run the commands above to exercise them.

The local pipeline uses plaintext transport on an isolated container network and a loopback ingestion port. Other deployments require TLS and broker access controls. Do not log telemetry bodies or tokens. DuckDB's local operator CLI exposes all files mounted into that process; it is not a tenant-authorized browser API.
