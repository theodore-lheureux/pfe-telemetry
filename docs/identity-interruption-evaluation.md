# Process identity, interruptions and denied access

The focused evaluation uses the current [participant contract](execution-participants.md)
and [collector queue semantics](../apps/collector/README.md#export-and-privacy).
PostgreSQL, Kafka and ClickHouse remain running. Each backend case owns disposable
databases, topics and consumer groups; no shared checkpoint is reset.

## Reproduce

Install locked dependencies and generate the web test inputs before starting
Playwright. Do not regenerate them while a development browser run is active.

```sh
bun install --frozen-lockfile
bun run i18n:compile
bun --no-env-file apps/web/scripts/compile-telemetry.ts
```

Use the explicit [backend allocation settings](../tests/README.md#backend-settings-and-isolation).
Keep credentials and machine-specific endpoints in ignored local configuration.
The participant storage case requires the current `executions.proto` mounted in
ClickHouse. The normalizer case requires three empty, three-partition topics and
a fresh group under `<namespace>.normalizer.`.

Run the collector command inside an already running Linux build container, using
this checkout's sources and the existing named Cargo volumes:

```sh
cargo test --locked -p recount-collector --lib
```

Run host-supported boundaries natively:

```sh
cargo test --locked -p recount-telemetry-validation --test participants
cargo test --locked -p recount-ingestion-api --lib tests::participants
cargo test --locked -p recount-ingestion-api --lib tests::live::signed_node_tokens_revocation_bindings_and_outage_are_live -- --ignored --exact
cargo test --locked -p recount-ingestion-api --test participants -- --ignored
cargo test --locked -p recount-normalizer --test kafka real_kafka_bootstrap_replay_rebalance_and_global_handler_poison -- --ignored --exact
bun --no-env-file test --timeout 30000 apps/web/tests/integration/executions.test.ts apps/web/tests/integration/activity.test.ts
node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts execution-ui.spec.ts
```

## Scenarios and expected results

| Scenario                               | Fixture and assertion                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PID reuse, boot and namespace changes  | Persist a membership, close its queue, change one identity field and rediscover the same PID. The new process reads its own label and gets a fresh fact ID at revision 1. The old membership ends without transferring coverage. Analytical process resource IDs differ for each changed identity.                                                                             |
| Fork and exec                          | A real Linux shell and inherited child produce independent memberships. A shell that execs with a cleared environment retains its cached incarnation decision; a fresh discovery sees it as unlabelled.                                                                                                                                                                        |
| Unknown or missed processes            | An unlabelled process, an unreadable environment and a labelled process removed before the scan produce no participant facts. Existing identity-recheck tests discard a process replaced during its environment read.                                                                                                                                                          |
| Collector restart and ingestion outage | Metric queue tests recover the same batch ID, creation time and payload. Participant export reopens SQLite after an uncertain acknowledgement, retries identical lifecycle bytes through another `UNAVAILABLE`, and sends exactly one membership only after lifecycle confirmation. Both queues drain without local loss.                                                      |
| Clock offsets and connection cuts      | Existing collector cases detect backward/large forward readings, invalidate continuity and reconnect after a dropped proxy socket without changing queued bytes. Admission rejects stale claims and future ends instead of retiming them.                                                                                                                                      |
| Normalizer restart                     | Kill the owned normalizer after a confirmed prefix, publish a new batch while it is stopped, then restart with the same group. Every expected new sample appears; immutable replay preserves original rows and IDs. Poison input stops the owned consumers without publishing a suffix or advancing its checkpoint.                                                            |
| ClickHouse consumer restart            | Detach only the disposable participant Kafka table at offset 12, publish a new lifecycle revision and an old membership replay, then attach it again. Stored facts and the checkpoint remain unchanged while stopped; the checkpoint reaches 14 after recovery. `FINAL` returns three facts, including the higher-revision retraction. Process resource identity is unchanged. |
| Denied node claims                     | Real signed expired and revoked node tokens return `UNAUTHENTICATED`. Foreign project/node/host claims return `PERMISSION_DENIED`. Malformed revisions, kinds, provenance and times return `INVALID_ARGUMENT`. Rejections do not publish.                                                                                                                                      |
| Private execution reads                | Canonical access checks reject sibling-project, foreign-organization and mismatched organization/project references before analytics reads. Identical execution keys grant no authority.                                                                                                                                                                                       |
| Browser and direct HTTP access         | Two viewers each receive one project grant; the organization owner acts as operator. Both projects use the same execution key and different private metadata. The operator reads both; each viewer reads only their own page and RPC result. Unauthorized Live requests return a failure before a gateway heartbeat can be forwarded.                                          |

## Recorded outcomes

On 16 November 2026, the reused backend allocation produced these results:

| Check                                                         | Result                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Linux collector library                                       | 81 passed; execution time 3.14 seconds, excluding compilation and shared-cache waits |
| Participant validation                                        | 4 passed                                                                             |
| Ingestion participant admission                               | 2 passed                                                                             |
| Real PostgreSQL token authority                               | 1 passed, including expired and revoked participant claims                           |
| Native participant storage                                    | 1 passed; checkpoint 12 → 14, three latest facts, retraction retained                |
| Native normalizer restart, backlog and replay                 | 1 passed; expected poison failures stopped both owned consumers                      |
| Execution and activity authorization integration              | 5 passed                                                                             |
| Browser execution reads and Live authorization                | 3 passed; English, French and the two-viewer/operator matrix, 29.2 seconds total     |
| Biome, web TypeScript, host and Linux Clippy, Rust formatting | Passed                                                                               |

The initial web integration attempt lacked generated telemetry descriptors.
Generating the documented inputs resolved that setup failure. Browser execution
fixtures also lacked the current `environmentVariables` field; the fixtures were
corrected without changing the product schema or rendering code.

One browser run exceeded the existing 20-second cold-start readiness budget while
compilers were active. With compilation finished, all three browser cases passed
without increasing readiness, assertion or test timeouts. No product defect was
confirmed in these scenarios.

## Evaluation boundary

Collector outage tests use controlled gRPC receivers and real SQLite queues.
Participant storage uses the real ingestion router, Kafka publisher and native
ClickHouse consumer. The browser fixture uses the real Bun application,
PostgreSQL sessions and authorization with controlled analytics and Live responses.
It is not a full-pipeline availability or TLS test.

Uncommitted scans and processes missed between scans or during downtime cannot be
recovered. An uncertain acknowledgement permits immutable redelivery; logical
replacement is distinct from a physical exactly-once delivery guarantee. A detached
fixture consumer tests downstream recovery without restarting the shared
ClickHouse service.
