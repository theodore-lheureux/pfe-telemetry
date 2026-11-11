# Ingestion API

`recount-ingestion-api` in `apps/ingestion-api` uses Tonic on Tokio for authenticated OTLP/gRPC metrics. It uses standard generated OpenTelemetry messages and service interfaces; trace exports return `UNIMPLEMENTED`. TanStack Start handles the web application, human sessions and application operations. The [service reference](../apps/ingestion-api/README.md) owns current flags, environment variables, admission limits and validation commands.

## Responsibilities

The API checks live PostgreSQL authority, resolves enrolled root/resource grants, validates the whole request and exact normalized expansion, then publishes one bounded raw record when its point count is nonzero. The separate [normalizer](../apps/normalizer/README.md) uses RustStream to publish one bare analytical point per Kafka record, with all required outputs acknowledged before input settlement. Native ClickHouse uses `ProtobufSingle` and a non-aggregating view. The API writes neither ClickHouse nor PostgreSQL telemetry acceptance state; browser operations authorize independently.

A successful export containing validated observations confirms raw Kafka publication, not processing completion or whole-batch analytical visibility. Authenticated zero-point requests succeed after authority and validation checks without publishing; empty-export success proves neither Kafka publication nor downstream health. Temporary publication failure/timeout can be ambiguous; retry immutable input. Exact sample identity, authority and acknowledgement boundaries are in the [point contract](telemetry-point-contract.md).

## Generated types

`opentelemetry-proto` provides OTLP message types and Tonic service interfaces. Implementing `MetricsService::export` and `TraceService::export` connects application logic to those interfaces. Tonic handles gRPC routing, framing, Protobuf encoding and decoding, and protocol statuses. Exporters use the standard OTLP schema and do not need a project-specific SDK. [OpenTelemetry bindings](https://docs.rs/opentelemetry-proto/latest/opentelemetry_proto/), [Tonic](https://docs.rs/tonic/latest/tonic/)

OTLP exports are unary calls: one request produces one response. Streaming measurement collection does not require a streaming RPC. A global admission permit bounds concurrent body decoding across connections; blocking validation/projection retains that permit even if an RPC is cancelled. Concurrent exports do not bypass request or normalized-output limits. [OTLP/gRPC](https://opentelemetry.io/docs/specs/otlp/)

## Transport alternatives

| Transport                      | Advantages                                                                                        | Costs and limits                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OTLP/gRPC                      | Generated service interfaces, integrated message handling, and compatibility with gRPC exporters. | Requires HTTP/2 and gRPC-aware routing. Exporters must support the selected transport.                |
| OTLP/HTTP with binary Protobuf | Ordinary HTTP requests, direct body access, and the same generated message types.                 | Handlers must implement OTLP paths, content types, encoded responses, compression, and error mapping. |
| OTLP/HTTP with JSON            | Useful for interoperability and inspecting examples.                                              | OTLP JSON has specific mapping rules; ordinary Serde serialization does not guarantee compatibility.  |

Both binary transports use the same message definitions. gRPC does not establish a throughput advantage by itself. Batch size, concurrency, compression, network conditions, and durable publication need representative measurements. [OTLP transports](https://opentelemetry.io/docs/specs/otlp/)

## Framework alternatives

| Stack                | Integration                                   | Considerations                                                                                                                       |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Tonic                | Generated OTLP/gRPC services on Tokio.        | Direct integration with the available OpenTelemetry service bindings. Selected for ingestion.                                        |
| Axum with Prost      | OTLP/HTTP handlers around generated messages. | Tower middleware and direct body access make it the main HTTP alternative. [Axum](https://docs.rs/axum/latest/axum/)                 |
| Actix Web with Prost | OTLP/HTTP handlers around generated messages. | Configurable HTTP server with similar OTLP protocol work to Axum. [Actix extractors](https://actix.rs/docs/extractors/)              |
| Poem with Prost      | OTLP/HTTP handlers around generated messages. | OpenAPI generation has limited benefit for standard OTLP services. [Poem OpenAPI](https://docs.rs/poem-openapi/latest/poem_openapi/) |
| Poem gRPC            | Generated services from OTLP schemas.         | Uses Poem-specific bindings instead of existing Tonic service interfaces. [Poem gRPC](https://docs.rs/poem-grpc/latest/poem_grpc/)   |
| Rocket with Prost    | OTLP/HTTP handlers and data guards.           | Route declarations do not remove OTLP receiver implementation work. [Rocket requests](https://rocket.rs/guide/v0.5/requests/)        |

## Retention and replay

Raw Kafka retains the supported decoded OTLP request with trusted source/project, resolved resource access, unchanged original ordering and stable submission/record identity before analytical projection. Normalization preserves observation identity through retries, regrouping and partition fanout. It does not implement aggregate/minute-chunk storage, a first-writer registry or a whole-batch visibility gate. [Serialization](serialization.md#retention-and-replay)

Re-encoding does not promise identical bytes or preservation of fields absent from the bindings. Prost's generated decoder skips unknown fields. Application-defined metric names and attributes use existing OTLP fields and remain part of the decoded request. [Prost decoding](https://docs.rs/prost-derive/latest/src/prost_derive/lib.rs.html#191)

Original-byte preservation is a separate capability. A custom Tonic codec could retain original Protobuf bytes alongside decoded input, but no such capture/alternate runtime format is implemented. The current global Tower admission layer precedes body reading/decompression/decoding, and Tonic enforces decoded bytes before Prost. [Tonic decoder](https://docs.rs/tonic/latest/tonic/codec/trait.Decoder.html), [custom codecs](https://docs.rs/tonic/latest/tonic/server/struct.Grpc.html)

## Runtime and health

`RECOUNT_INGESTION_ADDR` selects the service bind address and `RUST_LOG` controls tracing. `RECOUNT_INGESTION_DATABASE_URL` is required; missing database configuration is a startup error, not a metrics-disabled connectivity scaffold. The consolidated stack publishes development access on loopback. See the [API configuration](../apps/ingestion-api/README.md#configuration) and [stack guide](../infra/README.md) for current addresses and endpoint/mount/identity guards.

Metrics accept uncompressed/gzip input. Shared structural/output limits must match the normalizer and configured broker capacity, with conservative framing headroom; deterministic excess is terminal `RESOURCE_EXHAUSTED` without `RetryInfo` before publication. The predecode semaphore defaults to one admitted request globally, and a ten-second deadline bounds slow input. These controls do not prove peak decoded memory or production throughput. Ctrl-C and SIGTERM request graceful shutdown.

| Health service name                   | Current status                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `grpc.health.v1.Health`               | `SERVING` while the gRPC server is running.                                                 |
| Empty name, meaning overall readiness | `SERVING` when current Kafka configuration matches and the node revocation list is current. |
| OTLP metrics service name             | Same readiness checks as the empty service name.                                            |
| OTLP trace service name               | `NOT_SERVING`; trace exports remain unimplemented.                                          |

Readiness refreshes every five seconds. Kafka checks include exact configured raw partition count and effective topic `max.message.bytes`; the authority check requires a node revocation list loaded within the last five minutes by the deployed read-only role. The named health service is liveness only. Neither it nor successful readiness proves downstream native consumption, freshness or end-to-end queryability. The normalizer has separate process-state logs, not a gRPC/HTTP health service.

## Security

The isolated development environment uses plaintext OTLP. Production OTLP TLS is not implemented by that isolation; other deployments require a secured transport boundary. Database connections require TLS unless their URL explicitly selects `sslmode=disable`, with no automatic plaintext fallback. Node access tokens are verified in memory on every submission against configured Ed25519 public keys; revocation comes from a node list refreshed every 30 seconds, so a revoked node is rejected within about 30 seconds.

Root grants permit reporting in an explicit namespace/adapter/local-kind set, while independent resources require exact typed bindings. Payload tenant fields or parent/placement relationships never establish authority or physical attestation. The normalizer can finish already accepted records after node revocation or upload-age expiry without refreshing admission authority. Batch creation policy is separate from event time: no measurement-age/future cutoff or timestamp rewriting is introduced. See [collector enrollment](collector-enrollment.md).

Better Auth email-code/passkey sessions and canonical memberships govern human application access, not collector authentication. Every private query independently checks project access before using the separate read-only ClickHouse credential.

Do not log telemetry bodies or credentials. Apply retention and access policies to retained batches and analytical results. Message-size limits also apply after decompression.

## Validation

Service tests target health/admission behavior, gzip/decoded-size rejection, live node-token and revocation authority and publication ordering. Pure publisher fixtures do not prove lost Kafka acknowledgements or native storage durability. The normalizer's dedicated real Kafka harness and native ClickHouse failure tests are separate from broker-independent checks; state which exact current-schema path and fault each result exercised.

Compile Linux binaries/harnesses on the host and execute them only in Docker, using an explicitly allocated disposable integration slot. Compute-host connectivity probes do not validate telemetry acceptance. Further gates include independent exporter interoperability, ambiguous output/input acknowledgements, partial publication, retention gaps, event-day replay, measured backlog recovery and authorized browser reads. Use the [native-ingestion guide](../infra/README.md#validate-native-ingestion) and [reliability scenarios](ingestion-and-reliability.md#validation-scenarios); do not restore a discarded prototype schema to make an old test pass.
