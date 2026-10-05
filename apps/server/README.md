# Telemetry ingestion server

Tonic server for OTLP/gRPC metrics and traces, with the standard gRPC health service. The web application and its application endpoints run in TanStack Start.

From the repository root:

```sh
just server
PFE_INGEST_ADDR=127.0.0.1:4317 RUST_LOG=debug just server
cargo test --locked -p pfe-server
```

`PFE_INGEST_ADDR` defaults to `127.0.0.1:4317`. Requests support gzip and have a 4 MiB decoded-message limit. Ctrl-C and SIGTERM trigger graceful shutdown.

The `grpc.health.v1.Health` service reports `SERVING` for its own service name. Overall health and the OTLP service names report `NOT_SERVING`. Metrics and trace exports return `UNIMPLEMENTED` until a durable sink is connected; the server does not accept or retain telemetry yet.

The [test environment](../../infra/test-environment/README.md) runs this executable in Docker Compose. Container and guest checks use `grpc_health_probe` with `-service=grpc.health.v1.Health`.

See [ingestion server](../../docs/ingestion-server.md) for transport and framework alternatives, retention, and the acceptance boundary.
