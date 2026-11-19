# OTLP load test

Run one k6 virtual user per synthetic collector. Each owns an Ed25519 key and a persistent OTLP/gRPC connection, and attempts one export per second. The runner creates a dedicated project and expiring Linux enrollment key through the existing application services. Enrollment and token renewal go through the same HTTP endpoints used by the collector. No API changes or token signing credentials are needed.

## Run

Use Bun, Rust/Cargo, and k6 **2.4.0** (gRPC, Ed25519 WebCrypto and `BigInt`). From the repository root, run `bun install --frozen-lockfile`. Use a dedicated organization or a test organization with an existing administrator. The runner needs the application's database credentials on a loopback endpoint (or an authorized loopback SSH forward) and checks project administration through the application services. Load the connection string from private local configuration, not shell history. Do not expose Postgres to the network.

For a local regression run, use an isolated stack allocation: dedicated Postgres and ClickHouse databases, Kafka raw/recent/late/live/participant topics and consumer groups, and web and ingestion processes configured for that allocation. The web application and ingestion API must use the same test signing authority. Adapt the ports below to the allocation:

```sh
export RECOUNT_LOAD_ORGANIZATION_ID='<test-organization-id>'
export RECOUNT_LOAD_OPERATOR_EMAIL='<organization-admin-email>'
export RECOUNT_LOAD_WEB_ORIGIN=http://127.0.0.1:23001
export RECOUNT_LOAD_OTLP_ORIGIN=http://127.0.0.1:24318
# Export RECOUNT_LOAD_DATABASE_URL for the isolated application database.
RECOUNT_LOAD_NODES=2 bun --no-env-file tooling/load/run.ts
```

| Setting                        | Default      | Effect                                                                    |
| ------------------------------ | ------------ | ------------------------------------------------------------------------- |
| `RECOUNT_LOAD_MODE`            | `regression` | One plateau; `saturation` steps through 1×, 1.5×, 2× and 3×, rounding up. |
| `RECOUNT_LOAD_NODES`           | `2`          | Baseline virtual nodes, 1–500. Use the current fleet size for saturation. |
| `RECOUNT_LOAD_RAMP_SECONDS`    | `10`         | Ramp duration before each plateau.                                        |
| `RECOUNT_LOAD_HOLD_SECONDS`    | `60`         | Duration at each plateau. Use at least a few minutes for capacity tests.  |
| `RECOUNT_LOAD_FIXTURE`         | `processes`  | `idle` (56), `processes` (184), or `collector` (1,158 points per export). |
| `RECOUNT_LOAD_P95_MS`          | `1000`       | Regression export p95 threshold in milliseconds.                          |
| `RECOUNT_LOAD_REFRESH_SECONDS` | `3300`       | Maximum time between renewals; lower to verify renewal in a short run.    |
| `RECOUNT_LOAD_K6`              | `k6`         | k6 executable or local wrapper.                                           |
| `RECOUNT_LOAD_DESCRIPTOR`      | Cargo build  | Optional path to the current `otlp.pb` descriptor set.                    |

For saturation, set `RECOUNT_LOAD_MODE=saturation`, `RECOUNT_LOAD_NODES` to the baseline, and hold each stage long enough to distinguish transient lag from sustained growth. Allow lag to drain afterward. Regression mode requires at least one export, no export failures, missed cycles or renewal errors, and p95 below the configured threshold.

Never run the generator on the Oracle VM. From a laptop, use wired networking if possible; Wi-Fi, VPNs, proxies, bandwidth limits and sleep can reduce offered load or inflate latency. A small cloud VM near the ingestion endpoint gives steadier RTT; watch generator CPU, sockets, memory and egress, especially at 3×. Remote traffic requires HTTPS on both endpoints and `RECOUNT_LOAD_ALLOW_REMOTE=1`. Verify DNS, TLS and HTTP/2 gRPC through the ingress before increasing node count. The database tunnel is used for setup and cleanup only; OTLP traffic should go directly to the intended ingress.

## Cleanup

The runner revokes the enrollment key and all nodes enrolled with it after k6 exits, including after a failed setup or an interrupted run that can shut down cleanly. It retains the project and telemetry for analysis. If the generator was killed or cleanup could not reach Postgres, retry with the printed manifest and the same database configuration:

```sh
bun --no-env-file tooling/load/run.ts cleanup .state/load/<run-id>/run.json
```

Keep `.state/load` private. It holds the metrics and cleanup manifests. The enrollment secret is written to a private transient file, and each node's signing key and token stay in k6 memory. Do not enable HTTP/gRPC debug logging on a run with live credentials.

## Read the results

- k6 prints gRPC latency and export errors. `.state/load/<run-id>/metrics.json.gz` contains timestamped samples. Compare `otlp_exports` and `otlp_accepted_points` per second at each plateau rather than the average over the whole ramp. `otlp_missed_cycles` shows where VUs could not keep pace. A successful export confirms raw acceptance, not ClickHouse storage.
- In Grafana's **Recount ingestion health** dashboard, align the absolute time range with the run. Compare normalizer and ClickHouse committed throughput, net backlog bars and per-partition lag. Growing lag with flat throughput identifies the stage that is no longer keeping up; lag on just one partition suggests skew. Compare container CPU with the ClickHouse CPU limit and merge activity. Use points written and sampled write-delay p95 to confirm storage keeps up; an absent p95 sample is not zero delay.
- The replay preserves each capture's series shape and uses distinct host, boot, epoch and process namespace identities per node. It does not reproduce process churn, queue retries, gzip upload, connection diagnostics or host-to-host network diversity. Calibrate by accepted points/s and observed payload size, not node count alone. Use a real fleet for those behaviors.

## Fixtures

The fixtures were captured over OTLP/gRPC from a Linux collector in a disposable container, first with only the collector and then with 16 `sleep` processes. The scrubber reads only the protobuf request body, never headers. It keeps reviewed metric and dimension values, replaces host, boot, epoch, PID, process tick, device and counter-segment identifiers, and stores only relative timestamps. Replay shifts observations to the current clock and advances cumulative counters without changing series identity.

The `collector` fixture uses a scrubbed export from a dedicated AWS calibration lab. It keeps the larger process mix and replays it once per second. It does not reproduce process churn or guarantee identical protobuf or compressed wire sizes. To refresh it from an authorized disposable lab export without writing a raw capture, pipe the decoded OTLP request body into `scrub.ts` and pass `-` in place of the input file.

To refresh from a controlled Linux collector capture, export an OTLP descriptor set and scrub the captured, decoded protobuf request body. Review the output before committing; never store raw captures:

```sh
cargo run --locked -p recount-telemetry-schema --example recount-web-schema-export -- .state/load-schema
bun tooling/load/scrub.ts .state/load-schema/otlp.pb .state/capture.pb tooling/load/fixtures/processes.json
bunx biome format --write tooling/load/fixtures
bun test tooling/load
```
