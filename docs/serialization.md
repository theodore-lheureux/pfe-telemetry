# Serialization

The pipeline uses OTLP/gRPC with binary Protobuf for telemetry transport and Protobuf for retained ingestion records. Parquet is the proposed format for historical files and exports; the TanStack Start application API uses JSON. Rust values can pass between collection, processing, and storage modules without serialization when they share a process.

The selection favors generated types, application instrumentation in several languages, preservation of measurement context, and recoverable processing. Payload size and CPU cost need measurement with representative batches before fixing compression and batch limits.

## Formats by layer

| Layer                                        | Proposed representation                                             | Reason                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sensor or operating system to Rust collector | Native Rust values                                                  | Preserve numeric types and measurement context without a wire format inside the process.                                                           |
| Application code to instrumentation library  | Native language API                                                 | Developers record counters, gauges, histograms, and timed operations through an existing OpenTelemetry library or an optional convenience wrapper. |
| Instrumented application to local collector  | OTLP/gRPC, binary Protobuf                                          | Accept standard gRPC exporters across languages and keep application instrumentation independent of the collector implementation.                  |
| Collector disk buffer                        | Framed Protobuf records containing payload bytes and retry metadata | Keep the encoded batch and its identity stable through retries and collector restarts.                                                             |
| Collector to Rust ingestion API              | OTLP/gRPC, binary Protobuf                                          | Use the same telemetry definitions for external measurements and application signals.                                                              |
| Ingestion API to broker to storage worker    | Protobuf envelope containing the re-encoded OTLP request            | Retain the complete decoded request and trusted ingestion metadata before analytical processing.                                                   |
| Storage worker to DuckDB                     | Typed values or column batches                                      | Write through the in-process database interface. Arrow batches are an option when supported by the selected integration.                           |
| Historical files and portable recordings     | Parquet, with a JSON manifest                                       | Store typed columns for analytical queries and include collection settings, schema versions, units, and identities with an export.                 |
| TanStack Start server functions to browser   | JSON                                                                | Fit ordinary web requests and incremental updates. Return authorized query results shaped for the interface rather than raw ingestion envelopes.   |
| Export to another telemetry backend          | OTLP for supported signals                                          | Reuse the standard model where the destination accepts the same signal and transport.                                                              |

Disk framing must distinguish complete records from a partial write. It is separate from the Protobuf message definition. Historical Parquet files are also separate from the collector's pending-upload buffer and broker retention.

Execution registration and other application requests belong to the TanStack Start application API. Those requests describe executions and participants; they are separate from the Rust server's metric and trace export services.

## Alternatives considered

| Format      | Advantages                                                                                                                                                | Costs and limits                                                                                                                                                                                                                                                       | Use                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| JSON        | Readable, widely supported, and convenient for HTTP APIs and diagnostics.                                                                                 | Verbose field names before compression. Explicit validation and compatibility rules are still needed. JavaScript cannot represent every 64-bit integer exactly as a number. [Numeric interoperability](https://www.rfc-editor.org/rfc/rfc8259)                         | Web and control APIs; an alternative telemetry encoding for compatibility checks. |
| Protobuf    | Explicit field types, generated code, binary encoding, and defined evolution rules. [Language guide](https://protobuf.dev/programming-guides/proto3/)     | Requires schema and code-generation tooling. Generated types do not validate units, identities, or measurement meaning. Binary captures need decoding tools for inspection.                                                                                            | Telemetry and retained ingestion records.                                         |
| Avro        | Typed records, writer/reader schema resolution, and established streaming integrations.                                                                   | Decoding needs access to the writer schema. Adopting it would add another schema model and conversion from OTLP. A registry is useful in some deployments but is not required by Avro itself. [Avro specification](https://avro.apache.org/docs/1.12.0/specification/) | Reconsider if an Avro-based downstream integration becomes necessary.             |
| MessagePack | Binary representation of common JSON-like values, including integer types. [Format specification](https://github.com/msgpack/msgpack/blob/master/spec.md) | The format alone does not supply the shared schema, generated domain types, or evolution policy needed by the collectors. A separate contract would still be required.                                                                                                 | No initial use.                                                                   |
| Arrow IPC   | Typed column batches for bulk transfer and analytical processing. [Arrow format](https://arrow.apache.org/docs/format/Columnar.html)                      | Adds columnar conversion and browser or client integration work. It is not the standard input expected by OpenTelemetry exporters.                                                                                                                                     | Optional bulk analytical transfer after measuring JSON query responses.           |
| Parquet     | Typed columnar files with compression and efficient analytical reads. [Parquet overview](https://parquet.apache.org/docs/overview/)                       | File publication, batching, and recovery need explicit handling. It does not provide a per-request telemetry transport.                                                                                                                                                | Historical storage and portable exports.                                          |

Kafka does not impose Avro. Protobuf can be used with Kafka or another broker. A schema registry would be an additional deployment choice; registries such as Confluent's support Protobuf and JSON Schema as well as Avro. [Supported registry formats](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html)

## OTLP and transport

Protobuf defines message encoding. OTLP adds shared telemetry definitions and export behavior. HTTP and gRPC are transport choices. Reusing an OpenTelemetry `.proto` file alone does not make an endpoint OTLP-compatible.

OTLP/gRPC is the selected ingestion transport. Tonic exposes the generated service interfaces and handles gRPC framing, compression, and status codes. OTLP/HTTP with binary Protobuf remains an alternative if an integration requires HTTP. OTLP/HTTP also defines JSON encoding using the same schemas; it is an interoperability option, not a separate application metric model. HTTP transports are not implemented by the scaffold. [OTLP specification](https://opentelemetry.io/docs/specs/otlp/), [ingestion server](ingestion-server.md)

The generated `MetricsService.Export` and `TraceService.Export` methods receive their defined export messages and return their defined responses. Execution metadata or a custom receipt must not replace the OTLP request or response body. Request limits, gzip handling, retryable failures, and partial acceptance are part of receiver compatibility. The scaffold registers both services but returns `UNIMPLEMENTED` until durable ingestion is available.

Whole-batch validation and acceptance are the initial policy. Partial acceptance would require additional tracking to distinguish accepted and rejected records; OTLP exporters must not retry a response that reports partial success.

## Generated types and extensibility

The server uses the generated Prost and Tonic types from `opentelemetry-proto`. The collector can use the same package; a project-owned ingestion envelope can live in a shared Rust crate under `crates`. Sharing definitions avoids maintaining two copies of the protocol. [OpenTelemetry generated types](https://docs.rs/opentelemetry-proto/latest/opentelemetry_proto/), [Prost](https://github.com/tokio-rs/prost)

Typed telemetry does not require a generated field for every application metric. A metric has an explicit structure for its name, unit, value type, temporality, timestamps, and attributes. An application can introduce a name such as `solver.iterations` without rebuilding the collector. Application-specific generated wrappers can remain in the application's code.

Resource and execution context need a common interpretation: node identity, process or group identity, process lifetime, and an execution association when known. Platform adapters provide associations from an execution environment. Descriptive platform details use namespaced attributes. Adding a workload should not require a new wire schema.

Optional convenience libraries would configure existing OpenTelemetry SDKs, attach execution context, and provide simple metric and operation methods. They would reuse aggregation, batching, export, and transient retry behavior. Each supported language still needs initialization and lifecycle integration; generating messages does not generate that API. [Metrics SDK](https://opentelemetry.io/docs/specs/otel/metrics/sdk/), [Tracing SDK](https://opentelemetry.io/docs/specs/otel/trace/sdk/), [OTLP exporter](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)

Applications already using OpenTelemetry can send directly without a project-specific library. Convenience libraries should reuse an application's existing telemetry configuration and context where possible. Automatic machine and process collection remains independent of application instrumentation.

## Measurement fidelity and custom records

Preserve collection time, measurement window, units, scope, source, and quality information. Record whether a value is a gauge, cumulative counter, interval delta, or estimate. A missing or inaccessible measurement must not become a measured zero. An exported histogram summarizes observations; it does not preserve every original observation. Collection frequency, aggregation, and trace sampling determine what evidence remains available. [Metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/)

Ordinary scalar OTLP metric values use signed 64-bit integers or doubles. A full-range unsigned hardware counter therefore needs a deliberate representation if exact preservation is required. This limitation concerns scalar values, not every integer field in OTLP. [Metric definitions](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/metrics/v1/metrics.proto)

A grouped Linux hardware-counter read is a candidate for a specialized record. It can contain raw counter values, event definitions, a group identity, and enabled/running durations. Keeping these together allows later analysis to inspect multiplexing coverage and distinguish measured counts from scaled estimates. Interval estimates require deltas over the same window, and zero running time means unavailable data. [Linux performance counters](https://man7.org/linux/man-pages/man2/perf_event_open.2.html)

OTLP attributes or a structured log body can carry custom context, but other tools will not automatically understand its semantics. A custom Protobuf record becomes useful when explicit fields and exact source representation are needed. [Structured log bodies](https://opentelemetry.io/docs/specs/otel/logs/data-model/)

Custom records would use a separate RPC service and payload kind. They would retain a shared context model, with generated types on both collector and backend. The original record would remain authoritative; any OTLP projection would identify conversions or omissions. This adds schema evolution, validation, storage mapping, and conversion tests, but does not inherently require another server or broker. No specialized record is required for the initial CPU, memory, and I/O measurements.

Trace and execution identities remain distinct. One execution can contain several traces. Cross-process relationships require propagated trace context or explicit span links; external process measurements alone cannot reconstruct them. Trace storage must preserve parent identities and links, and tolerate spans arriving out of order. [Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/), [Spans and links](https://opentelemetry.io/docs/concepts/signals/traces/)

Standard trace export normally sends completed spans. A live view of an operation that has not finished needs separate lifecycle information; external resource measurements remain available while that operation runs. [Span export](https://opentelemetry.io/docs/specs/otel/trace/sdk/)

## Retention, replay, and compatibility

The collector buffer retains the encoded payload, payload kind, and stable batch identity. Collector-to-backend requests can carry that identity in agreed gRPC metadata. Standard third-party exporters must be accepted without that extension. Collector authentication determines the permitted source and project; values in a payload do not establish authorization.

The proposed backend envelope contains a record identity, authenticated source and project, receipt time, payload kind, format version, and a re-encoded complete OTLP request. Broker consumers decode this envelope before decoding the telemetry. Retaining the request before analytical conversion supports replay without preserving its original byte encoding.

Prost discards fields unknown to its generated schema during decoding. Metric names and attributes are known OTLP fields and remain available; future protocol fields may not survive re-encoding. Exact original-payload retention would require capture in a custom Tonic codec and an adapter to the typed handlers. That additional implementation is separate from ordinary replay. [Prost decoding](https://docs.rs/prost/latest/prost/), [Tonic codecs](https://docs.rs/tonic/latest/tonic/codec/trait.Codec.html)

Our collectors reuse batch identities on retry. Third-party exporters do not necessarily provide equivalent identities. Server-assigned record IDs make replay of an accepted record stable, but cannot identify a later client retry as the same submission. End-to-end deduplication is therefore a separate contract, described in [ingestion and reliability](ingestion-and-reliability.md).

Protobuf serialization is not canonical. Do not derive a logical batch identity from serialized-byte equality or a payload hash. Record identities, schema versions, and content checksums serve different purposes. [Serialization limits](https://protobuf.dev/programming-guides/serialization-not-canonical/)

Add compatible fields to project-owned schemas, reserve deleted field numbers and names, and distinguish absent scalar values from zero where needed. Pin the schema source and code-generation dependencies. Retain the definitions needed to decode historical recordings, and report unsupported payload kinds rather than silently dropping them. [Schema evolution](https://protobuf.dev/programming-guides/proto3/)

Parquet stores the typed analytical representation. Retained Protobuf records preserve the decoded input supported by the pinned schema for replay while the configured raw-retention window lasts. An export manifest states its schema and analysis versions, collection settings, completeness, and any omitted raw data. A Parquet export must not imply byte-for-byte preservation of every original protocol field.

Browser-facing JSON represents nanosecond timestamps and integers outside JavaScript's safe range as decimal strings, or exposes an explicitly documented lower-resolution value. Ordinary chart values can remain numbers when their range and precision permit it. Arrow IPC should only replace JSON for a measured bulk-transfer requirement.

## Validation

| Check                                                                           | Expected result                                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Send metrics and traces from standard exporters in two languages.               | The receiver accepts the declared formats without a project-specific SDK.                                            |
| Compare representative batched JSON and Protobuf, with and without compression. | Record payload size, encode/decode CPU cost, allocations, collector overhead, and ingestion delay.                   |
| Encode, retain, decode, store, and export known measurements.                   | Values, units, windows, context, missingness, and declared precision survive each boundary.                          |
| Mix compatible schema versions and replay older recordings.                     | Supported fields remain usable; unsupported records are visible and retained under the raw-retention policy.         |
| Retry an identified collector batch and replay its broker record.               | Identities remain stable and storage avoids duplicate measurements or aggregates.                                    |
| Retry third-party exports without stable batch identities.                      | Behavior matches the documented deduplication limits.                                                                |
| Truncate a disk-buffer write or restart during publication.                     | Recovery finds complete records and reports incomplete data without inventing samples.                               |
| Export large integers and timestamps to the browser.                            | JSON conversion preserves the declared precision.                                                                    |
| Inject malformed batches, oversized requests, and invalid context.              | Rejection follows the declared protocol and access rules.                                                            |
| Propagate a trace across two processes with overlapping workloads.              | The trace relationships and execution associations survive storage and align with the external measurement timeline. |

Batch size, export interval, compression threshold, and buffer capacity should follow these measurements. Persistent collector buffering protects data after durable acceptance; application-side memory buffers and export queues have their own failure and capacity limits.
