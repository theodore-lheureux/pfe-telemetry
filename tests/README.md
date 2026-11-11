# Native tests and explicit runtime gates

Run ordinary Rust and Bun tests on the host. Reuse initialized PostgreSQL, Kafka
and ClickHouse processes for integration tests; allocate new logical fixtures for
each run. Tests do not initialize or repair a development stack.

## Select a suite

Compile the i18n catalogs before running web tests:

```sh
bun run i18n:compile
cargo test --locked --workspace
bun --no-env-file test apps/web/tests/unit tests/tooling
```

[Cargo selectors](https://doc.rust-lang.org/cargo/commands/cargo-test.html) select
packages, integration targets and test names directly. Live Rust tests are
ignored in ordinary runs and require explicit selection and allocation settings.
An ignored test is not evidence that its live boundary passed.

| Boundary                                                     | Command                                                                                                                                           | Required allocation                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Application database, auth and shipped ingestion grants      | `bun --no-env-file test --timeout 30000 apps/web/tests/integration`                                                                               | `TEST_DATABASE_URL`, an administrator URL permitting disposable databases and scoped roles; host `psql` for the shipped provisioning SQL |
| Ingestion authority, rotation, revocation, expiry and outage | `cargo test --locked -p recount-ingestion-api --lib tests::live::signed_node_tokens_revocation_bindings_and_outage_are_live -- --ignored --exact` | `TEST_DATABASE_URL` and locked web dependencies                                                                                          |
| Normalizer progress, bootstrap, replay, rebalance and poison | `cargo test --locked -p recount-normalizer --test kafka -- --ignored --test-threads=1`                                                            | Explicit normalizer settings below                                                                                                       |
| Real ClickHouse HTTP reader                                  | `bun --no-env-file test --timeout 30000 apps/web/tests/telemetry/clickhouse.test.ts`                                                              | ClickHouse administrator and restricted-reader credentials, plus `RECOUNT_CONTRACT_FIXTURE`                                              |
| Native Kafka-to-ClickHouse storage                           | `cargo test --locked -p recount-normalizer --test storage -- --ignored --test-threads=1 --skip unclean_restart --skip invalid_initialized`        | Explicit storage settings below; no service restart authority                                                                            |
| Browser with native Bun web                                  | `node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts`                                                           | `TEST_DATABASE_URL`; installed Playwright Chromium                                                                                       |

Build the fixture natively and discover its executable from Cargo's JSON output,
not an assumed `target/` directory:

```sh
cargo build --locked -p recount-telemetry-validation --example contract_fixture --message-format=json
```

Set `RECOUNT_CONTRACT_FIXTURE` to the resulting `contract_fixture` executable.
The HTTP suite invokes it with `--ordinary` and `--columns`; the storage suite
also verifies all generated fields and scalar Float64 bits with `--verify`.

## Backend settings and isolation

Normalizers use these explicit test settings:

- `RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH=1`
- `RECOUNT_NORMALIZER_TEST_BROKER` and `RECOUNT_NORMALIZER_TEST_NAMESPACE`
- `RECOUNT_NORMALIZER_TEST_RAW_TOPIC`, `RECOUNT_NORMALIZER_TEST_NORMALIZED_TOPIC`
  and `RECOUNT_NORMALIZER_TEST_GROUP`

The supplied topics must be empty, have three partitions, and use distinct names
under `<namespace>.normalizer.`. The progress case creates its own fresh topics.
Cargo supplies the normalizer executable; no separate binary-dispatch driver is
required.

The storage suite uses:

- `RECOUNT_STORAGE_TEST_ALLOW_CREATE=1`
- `RECOUNT_STORAGE_TEST_NAMESPACE`, beginning with `recount.`
- `RECOUNT_STORAGE_TEST_BROKER`, reachable from the host
- `RECOUNT_STORAGE_TEST_INTERNAL_BROKER`, reachable from ClickHouse
- `RECOUNT_STORAGE_TEST_OUTPUT_ROWS`, matching the prepared finite native partition guard, not a Kafka packing limit
- `RECOUNT_CLICKHOUSE_TEST_URL`, `RECOUNT_CLICKHOUSE_TEST_USER` and
  `RECOUNT_CLICKHOUSE_TEST_PASSWORD`
- `RECOUNT_CONTRACT_FIXTURE`

Storage cases send one bare point per Kafka record through `ProtobufSingle`;
the shared fixture's multirow file output uses standard delimited `Protobuf`
for HTTP/file interchange and round-trip verification. Cases create fresh topics,
groups and ClickHouse databases. They never
reset shared checkpoints or use application source tables. The retention case
sets short retention only on its new topic. Successful cases remove their own
database and topic; failures attempt to stop their own consumers and retain Kafka
evidence for explicitly scoped inspection and cleanup.

The HTTP reader also requires `RECOUNT_CLICKHOUSE_TEST_READER_PASSWORD` for the
allocated `telemetry_reader`. That reader must not have a grant on randomly named
fixture databases. The suite creates and removes another uniquely named
SELECT-only reader to verify positive reads, write denial and concurrency limits.
The [ClickHouse client](https://clickhouse.com/docs/integrations/javascript)
consumes response streams and closes owned connections before database cleanup.

PostgreSQL fixtures migrate new databases through the application migration
function. They do not cache sessions, tenant data, actors or database snapshots.
Only the targeted migration suite replays migrations to test history,
serialization and rollback.

## Browser ownership

Use `just build` (or `bun run --filter @recount/web build`) for the canonical web
build; the root package does not define a `build` script.

Build once before selecting production hosting with `RECOUNT_BROWSER_BUILT=true`.
Do not rebuild generated assets while a development browser run is active.
`RECOUNT_BROWSER_PORT` selects the first worker port; workers remain serial by
default.

Each test owns its database, auth secret, code delivery, Bun application and
browser context. Shared [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
close pages before private controls can enter failure snapshots, close contexts
before the application, drain auth work and close database pools. Timing
attachments measure fixture setup and teardown. Only immutable built RPC manifest
metadata is cached. Traces remain disabled because they can retain credentials.

The ordinary configuration includes OTP races, manual passkey serialization,
session changes and English/French behavior. It excludes only the full pipeline.

Run the isolated mutation-lifecycle regressions with the real React, Query and
Router hooks and controlled responses:

```sh
node node_modules/@playwright/test/cli.js test --config apps/web/tests/unit/mutation-lifecycle.playwright.ts
```

This suite needs Chromium but no database. It supplements the full application
suite; it does not verify server receipts or authorization by itself.

## Generated Bun runtime

After the canonical web build, run the generated Nitro output natively:

```sh
bun --no-env-file test tests/runtime/native-web.test.ts
```

The public-page/static/active-body case needs no backend. The authenticated case
requires `TEST_DATABASE_URL` and creates a disposable database. It verifies
English/French private SSR, typed Date RPC, a real telemetry HTTP client and the
same 15-second active-body drain used by the packaged test. A test-only preload
observes the actual SSR pool, queues work on the actual auth email owner and
observes closure of the generated bundle's telemetry client. It keeps the process
alive after shutdown so process exit cannot hide connection leaks. PostgreSQL
connections must disappear while that process is still alive, after pending email
work is released. No preload is included in deployment output.

## Coordinator-owned runtime and recovery gates

These gates can interrupt an allocated ClickHouse service. Do not run them on a
shared development allocation without exclusive authority.

```sh
cargo test --locked -p recount-normalizer --test storage unclean_restart -- --ignored
cargo test --locked -p recount-normalizer --test storage invalid_initialized -- --ignored
```

Use the complete test name with `--exact`, or omit `--exact` when using a substring
selector. Both cases require `RECOUNT_STORAGE_TEST_ALLOW_RESTART=1`,
`RECOUNT_STORAGE_TEST_CONTAINER_ID` and `RECOUNT_STORAGE_TEST_COMPOSE_PROJECT`.
The initialized-image case additionally needs `RECOUNT_SCHEMA_DIRECTORY`,
`RECOUNT_STORAGE_TEST_SYNTHETIC_ALLOCATION=1`, `RECOUNT_STORAGE_TEST_NETWORK` and
`RECOUNT_STORAGE_TEST_VERIFIER_PATH`. It clones the explicitly approved
container's configured entrypoint, command, synthetic environment and mounts on
that network. A traced copy of the verifier makes checksum rejection observable
without inserting a verification call into the startup chain. Bypassing that
chain's guard or starting ClickHouse before rejection fails the case.
Container ID, project, service and running state are checked before interruption.
Checkpoint rewind is limited to the newly created, inactive fixture group.

Image guards and packaged application smoke tests are separate:

```sh
bun --no-env-file test tests/runtime/schema.test.ts
bun --no-env-file test tests/runtime/images.test.ts
```

They require `RECOUNT_RUNTIME_TEST_ALLOW_CONTAINERS=1`. The schema test uses
`RECOUNT_SCHEMA_DIRECTORY` and `RECOUNT_CLICKHOUSE_IMAGE`. Image smoke tests use
`RECOUNT_RUNTIME_{COLLECTOR,INGESTION_API,NORMALIZER,WEB}_IMAGE`,
`TEST_DATABASE_URL`, and the container-visible
`RECOUNT_RUNTIME_DATABASE_{HOST,PORT,NETWORK}`. Images package prebuilt
artifacts; image builds never compile application sources.

The packaged web test signs in through the canonical fixture auth API and checks
authenticated private SSR. Only the container's database URL receives a unique
`application_name`; its real `pg_stat_activity` entries must exist before and
during shutdown, then disappear after exit. An incomplete JSON request keeps
trickling while Docker stops asynchronously. The request must survive the first
12 seconds, then be closed by the runtime's 15-second forced drain with exit code 0. Shutdown must finish before the 30-second PG idle timeout can hide missing
cleanup. The existing container caps, 35-second Docker grace and 120-second test
timeout remain unchanged.

The full two-collector path is selected explicitly:

```sh
node node_modules/@playwright/test/cli.js test --config apps/web/playwright.pipeline.config.ts
```

Supply the `RECOUNT_PIPELINE_*` allocation settings required by the test, including
three packaged Rust images and an immutable ClickHouse restart identity. The test
checks image executable hashes against the host artifacts, runs real Linux
sampling through the ingestion API and normalizer, verifies both hosts through
the authorized English/French browser, restarts ClickHouse and checks isolation.
Missing configuration or disabled restart fails this gate instead of skipping it.

On a non-Linux host, build, lint and test Linux-only crates in the reused Linux
build container defined by `infra/linux-build/compose.yaml`:

```sh
just linux cargo test --locked -p recount-collector
just linux cargo clippy --locked -p recount-collector --all-targets
```

The recipe starts the container once per checkout and runs each command in it.
The checkout is mounted at `/workspace`; named volumes keep the Cargo registry,
the toolchain and the Linux target directory `/target` between runs, so the
container is never rebuilt for a retry. Built executables, such as
`/target/debug/recount-collector`, can run in the same container against
services on the host through `host.docker.internal`.

The Linux-artifact runner remains for prebuilt Linux test executables. It
consumes a `cargo test --no-run --message-format=json` log:

```sh
bun tests/linux-artifacts.ts path/to/build.jsonl
```

It selects the platform from ELF headers and snapshots the prebuilt executables
into a content-addressed runtime image. No application sources are compiled in
Docker, and executables do not run through host filesystem bind mounts. One
isolated container runs all harnesses with bounded resources and no network;
its scratch `TMPDIR` does not hide embedded Cargo executable paths. Owned
containers and temporary staging files are cleaned up; image layers remain cached.
Live tests remain separate native commands.

## Assertion owners

| Invariant                                                                                                                                     | Owner                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Canonical identity, typed projections, input bounds and scalar serializer fidelity                                                            | Rust telemetry contract tests and `contract_fixture`                |
| Native Protobuf field/bit roundtrip, logical replay uniqueness, sparse flush, poison/no-commit, missing/expired checkpoints and finite fanout | Normalizer `storage` integration target                             |
| New-sample outage recovery, unclean restart, inactive owned-group rewind and invalid initialized-image refusal before consumption             | Normalizer `storage` recovery cases                                 |
| Coherent manifest tampering, altered proto and row-bound mismatch against image-pinned hashes                                                 | `tests/runtime/schema.test.ts`                                      |
| Explicit initialization, partial state and identity refusal                                                                                   | `tests/tooling/data-entrypoint.test.ts`                             |
| Artifact platform and executable guards                                                                                                       | `tests/tooling/linux-artifacts.test.ts` and the packaging validator |
| Real credential/grant SELECT access, privilege revocation on reprovisioning and unrelated read/write denial                                   | Web provisioning integration test                                   |
| HTTP precision, typed dimension ordering/bits, cancellation, capacity and SELECT-only reader behavior                                         | Web ClickHouse HTTP tests                                           |
| Packaged hosting, assets, private-file exclusion, non-root entrypoints and shutdown                                                           | Runtime image smoke tests                                           |
| Collector sampling through authorized browser, both hosts/locales and restart                                                                 | Explicit pipeline Playwright configuration                          |

CI separates lightweight checks from live integration. Each job owns and reuses
its backends. Checks include `infra/local` safety tests and TypeScript checks, the
test helpers' TypeScript checks, and exporter unit tests through Cargo's
`--all-targets` selection. The integration workflow has separate authority,
ordinary browser, and native-storage/runtime jobs.

The native job compiles Linux binaries and harnesses before initializing its
backends. `tests/ci/stage-artifacts.ts` selects executables from Cargo JSON and
stages only the web runtime inputs, preserving contained workspace symlinks and
running the shared artifact/privacy validator. [Buildx Bake](https://docs.docker.com/build/bake/reference/) packages those
artifacts without compiling application sources. The same initialized stack runs
storage, HTTP, packaged hosting, recovery and full-pipeline assertions. Only after
the producers stop and the native group has no pending input does the job switch
its owned ClickHouse process to a newly prepared R64 image, retaining the data and
checkpoints, and verify the smaller finite guard.

PostgreSQL health checks explicitly select TCP loopback with
[`pg_isready --host=127.0.0.1`](https://www.postgresql.org/docs/current/app-pg-isready.html),
so the temporary initialization Unix socket cannot satisfy readiness.

Broad pull-request triggers avoid leaving
[required workflows pending because of path filters](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks).
