# Native gzip load generator

Use the native generator when uncompressed k6 uploads saturate the laptop’s uplink before ingestion reaches capacity. It uses the collector’s Ed25519 enrollment and token renewal and its tonic gzip transport: one connection per synthetic node, one export per second, with a random starting phase. Both generators replay the same scrubbed 1,158-point collector fixture with the same seeded value walks.

## Run from a laptop

Run from the repository root with Rust/Cargo and Bun installed. Run `bun install --frozen-lockfile` first. Use a working Web origin for enrollment and a separate OTLP/gRPC origin for exports. HTTPS must support HTTP/2 through the ingress; plaintext is allowed only on loopback. Never run the generator on the host being measured.

Set these in private local configuration:

| Variable                       | Purpose                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `RECOUNT_LOAD_WEB_ORIGIN`      | Web origin for collector enrollment and token renewal.                                                                        |
| `RECOUNT_LOAD_OTLP_ORIGIN`     | OTLP/gRPC origin.                                                                                                             |
| `RECOUNT_LOAD_DATABASE_URL`    | Application database URL on loopback or through an approved loopback tunnel. Used only to create/revoke the test credentials. |
| `RECOUNT_LOAD_ORGANIZATION_ID` | Organization that owns the target project.                                                                                    |
| `RECOUNT_LOAD_OPERATOR_EMAIL`  | Existing project administrator; the runner uses the normal application authorization checks.                                  |
| `RECOUNT_LOAD_PROJECT_ID`      | Defaults to Collectors (`9c708f11-695b-4a15-959e-15a916eeefaf`). Override for the disposable local project.                   |
| `RECOUNT_LOAD_ALLOW_REMOTE`    | Set to `1` for an explicitly authorized remote test.                                                                          |

Start small against an isolated dev allocation as described in the [k6 guide](README.md). The runner builds the release binary, creates a dedicated expiring enrollment key, and enrolls synthetic nodes in the selected project. A single stage is a fixed-load run; a list adds nodes at each stage boundary while existing connections remain open.

```sh
RECOUNT_LOADGEN_STAGES=5 RECOUNT_LOADGEN_SECONDS=30 \
  bun --no-env-file tooling/load/native.ts > .state/native-5.jsonl

RECOUNT_LOADGEN_STAGES=20,30,40,60,80 RECOUNT_LOADGEN_SECONDS=120 \
  bun --no-env-file tooling/load/native.ts > .state/native-stages.jsonl
```

`RECOUNT_LOADGEN_STAGES` defaults to `20`; `RECOUNT_LOADGEN_SECONDS` defaults to 60 seconds at each stage. The largest stage determines how many nodes enroll before load begins. The runner revokes only that run’s key and nodes, including after Ctrl-C. If it was killed before cleanup, use its printed manifest with `bun --no-env-file tooling/load/run.ts cleanup <manifest>`. Telemetry stays in the target project.

## Read the run alongside Grafana

Stdout contains one JSON object per interval and a run total. Use `unix_ms` to align intervals with Grafana, and `nodes` to identify each stage. Compare attempted exports/s with the number of active nodes, then compare accepted points/s with Grafana’s write throughput and lag. Acceptance confirms Kafka publication, not ClickHouse visibility. Use lag, write-delay p95 and per-container CPU to identify which stage stopped keeping up.

The output includes failed exports by gRPC code and message, deadlines, transport failures, missed cycles and p50/p95 request latency. An overloaded node skips missed cycles instead of bursting to catch up; unlike the collector, the generator does not spool or retry those batches. `bytes_sent` counts bytes written to OTLP sockets, including HTTP/2 and TLS when enabled, but excludes network headers, retransmissions and enrollment traffic. Multiply bytes per second by eight for bits per second. Keep an eye on laptop CPU and uplink separately; Grafana shows the ingestion host, not the generator.
