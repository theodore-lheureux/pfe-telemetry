# Ingestion server

The ingestion service uses Tonic on Tokio for OTLP/gRPC with binary Protobuf. Metrics and traces use generated OpenTelemetry service interfaces. TanStack Start handles the web application, browser sessions, and application endpoints.

## Responsibilities

The ingestion service authenticates sources, validates requests, applies admission limits, and publishes accepted batches to durable storage or a broker. A storage worker processes retained batches into analytical data. Browser queries and exports are authorized in the TanStack Start application.

A successful export response means the batch crossed the durable acceptance boundary. It does not mean processing or analytical queries have completed. Authentication, semantic validation, durable publication, and duplicate handling remain application responsibilities. [Acceptance and recovery](ingestion-and-reliability.md)

## Generated types

`opentelemetry-proto` provides OTLP message types and Tonic service interfaces. Implementing `MetricsService::export` and `TraceService::export` connects application logic to those interfaces. Tonic handles gRPC routing, framing, Protobuf encoding and decoding, and protocol statuses. Exporters use the standard OTLP schema and do not need a project-specific SDK. [OpenTelemetry bindings](https://docs.rs/opentelemetry-proto/latest/opentelemetry_proto/), [Tonic](https://docs.rs/tonic/latest/tonic/)

OTLP exports are unary calls: one batch produces one response. Concurrent calls can keep several batches in flight. Streaming telemetry collection does not require a streaming RPC. Blocking storage operations belong in a storage worker or a bounded blocking task. [OTLP/gRPC](https://opentelemetry.io/docs/specs/otlp/)

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

Retain complete decoded OTLP requests before storage transformations or aggregation. Re-encoding them in a Protobuf ingestion envelope supports recovery, corrected storage mappings, and new analysis of supported fields. Include authenticated source and project context, receipt time, format version, and a stable record identity. [Serialization](serialization.md#retention-replay-and-compatibility)

Re-encoding does not promise identical bytes or preservation of fields absent from the bindings. Prost's generated decoder skips unknown fields. Application-defined metric names and attributes use existing OTLP fields and remain part of the decoded request. [Prost decoding](https://docs.rs/prost-derive/latest/src/prost_derive/lib.rs.html#191)

Original-byte preservation is a separate capability. A custom Tonic codec and receiver adapter can retain original Protobuf bytes alongside the decoded request. The decoder receives a complete message buffer with gRPC framing already handled. This does not require changing OTLP or client SDKs. Original-byte capture is not implemented in the initial receiver. [Tonic decoder](https://docs.rs/tonic/latest/tonic/codec/trait.Decoder.html), [custom codecs](https://docs.rs/tonic/latest/tonic/server/struct.Grpc.html)

## Runtime and health

The server binds to `127.0.0.1:4317` by default. `PFE_INGEST_ADDR` selects another socket address; `RUST_LOG` controls logging. The container listens on port 4317. Compose publishes it on host loopback using `TEST_ENV_HOST_PORT`.

Metrics and traces support uncompressed and gzip-compressed requests with a 4 MiB decoded-message limit. Each connection allows at most 32 concurrent handlers, with a 10-second handler timeout. This is not a global admission limit. Global limits and publication deadlines belong at the durable acceptance boundary. Ctrl-C and SIGTERM trigger graceful shutdown.

| Health service name                   | Current status                                       |
| ------------------------------------- | ---------------------------------------------------- |
| `grpc.health.v1.Health`               | `SERVING` while the gRPC server is running.          |
| Empty name, meaning overall readiness | `NOT_SERVING` until durable ingestion is configured. |
| OTLP metrics and trace service names  | `NOT_SERVING` until durable ingestion is configured. |

Metrics and trace exports return `UNIMPLEMENTED`; no export is acknowledged as accepted. Compose and VM verification use `grpc_health_probe` against the named health service to check process connectivity. [Health checking](https://grpc.io/docs/guides/health-checking/), [health probe](https://github.com/grpc-ecosystem/grpc-health-probe)

## Security

The isolated local environment uses plaintext gRPC. Other deployments require encrypted transport and source authentication. Collector credentials are scoped to permitted sources and projects; request attributes alone do not establish identity. SAML SSO concerns human sessions in the web application.

Do not log telemetry bodies or credentials. Apply retention and access policies to retained batches and analytical results. Message-size limits also apply after decompression.

## Validation

Validation should exercise health checks, gzip-compressed requests, oversized-message rejection, and the absence of successful export acknowledgements before a sink is configured. The environment checks that compute hosts can reach the server and each other; these connectivity checks do not validate telemetry acceptance.

Further checks require durable publication and processing: export from two language SDKs, interrupt publication, lose a response after acceptance, retry an identified batch, replay into a corrected storage mapping, and measure backlog recovery. [Reliability scenarios](ingestion-and-reliability.md#validation-scenarios)
