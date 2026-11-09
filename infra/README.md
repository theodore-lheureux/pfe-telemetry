# Recount local stack

The [backend Compose file](local/compose.yaml) runs reusable PostgreSQL, Kafka and ClickHouse. The optional [application overlay](local/compose.apps.yaml) adds packaged ingestion, normalizer and web processes. Collectors submit authenticated OTLP; the API acknowledges raw Kafka publication, the normalizer publishes analytical Protobuf rows, and ClickHouse consumes them through its native Kafka engine and a non-aggregating materialized view. PostgreSQL holds application and credential authority, not telemetry acceptance state.

Each acknowledgement is a separate at-least-once boundary. Analytical visibility can be partial and delayed. Read [the point contract](../docs/telemetry-point-contract.md) for identity, fidelity, authorization and replay rules.

## Native development loop

Keep one initialized PostgreSQL/Kafka/ClickHouse Compose instance running across development and browser-test runs. Use host Node for Playwright, native Bun for the web application, and native ingestion API/normalizer processes where supported. The collector's Linux sampling paths run in a reused Linux container or an existing VM. Isolate test data with disposable databases, projects and topic/group namespaces; do not rebuild infrastructure for every test.

The backend file includes both the internal `kafka:9092` listener and loopback `127.0.0.1:${RECOUNT_KAFKA_HOST_PORT:-19092}` for native clients; the controller remains private. Set native `RECOUNT_KAFKA_BOOTSTRAP` to that loopback address. Keep the selected instance's expected database identities and optional storage overrides. `just local up` validates data selection, starts/reuses PostgreSQL and Kafka, verifies existing topics, then starts/reuses ClickHouse. Compose reuses unchanged containers and recreates only those whose declared configuration or image changed, so selected mounts, identities and environment take effect. This is a deliberate configuration update, not infrastructure recreation for each retry. Startup never builds images, creates topics or seeds consumer offsets; incompatible schema cutovers still require the explicit procedure below.

Build the web bundle once on the host and set `RECOUNT_BROWSER_BUILT=true` when testing the generated Nitro server. Playwright uses its standard Node runner; fixtures launch native Bun processes with isolated application databases. `just ingestion-api` and `just normalizer` run the corresponding native Rust processes with explicit local configuration. A Linux collector container reaching a native API needs a configured host-gateway address; keep its token and queue bindings unchanged across restarts.

Runtime-image packaging and Linux-specific checks remain final validation gates. They consume prebuilt artifacts and do not compile application sources in Docker. Native macOS checks do not validate the collector's Linux-only sampling code.

## Prepare runtime artifacts

Compile Linux binaries on the host for packaging and Linux validation, then execute those Linux artifacts in Linux containers. Native development uses host-compatible binaries instead. The runtime Dockerfiles consume this artifact layout:

```text
.state/artifacts/<arch>/        # amd64 or arm64, matching the Linux target
  bin/recount-collector
  bin/recount-ingestion-api
  bin/recount-normalizer
  web/server/index.mjs
  web/server/...              # Nitro bundles and traced runtime dependencies
  web/public/...              # immutable public artifact
  web/nitro.json
```

The web artifact is a copy of Nitro's generated `apps/web/.output`, validated before and after copying. It contains no root workspace or installed build-tool dependency tree. The Dockerfile starts `bun server/index.mjs` with `NITRO_HOST=0.0.0.0` and `NITRO_PORT=3000`; Nitro owns static serving and the production listener. The [web hosting reference](../apps/web/README.md#structure) records the pinned release candidate, public artifact boundary, cache policy and lifecycle. The current traced dependencies are JavaScript-only; if native runtime dependencies are added, build them on Linux for the explicitly selected target architecture. CI stages only from a matching Linux host. Docker does not compile sources or manufacture an adapter.

Use the repository's pinned Rust toolchain and lockfile. On a Linux build host matching the runtime architecture:

```sh
cargo build --locked --release \
  -p recount-collector -p recount-ingestion-api -p recount-normalizer
```

On other hosts, configure a Linux cross-toolchain for the intended target; no particular cross-compiler installation is required by the repository. Preserve local Cargo configuration and discover executable paths from Cargo's compiler-artifact JSON. Copy the resulting executables into the matching artifact directory; retain their executable modes. Kafka dependencies must be linked for the runtime image: the Rust images use Debian trixie slim and do not install a development toolchain or a dynamic librdkafka. Check shared-library requirements from the actual build before use.

Prepare schemas with the trusted Rust example on the native host; no Linux release build or Docker execution is needed for schema generation. The exporter uses compiled `ANALYTICAL_COLUMNS` and compares its compiled proto, generator, DDL template and transport definitions byte-for-byte with the selected source root before writing. Caller-supplied columns are not accepted. The output directory must not already exist, including an empty or partial directory.

```sh
cargo run --locked -p recount-telemetry-validation --example recount-schema-export -- \
  --source-root . --output .state/new-schema
```

Missing parents of the explicitly selected output directory are created; an existing bundle is never replaced. To generate and package a schema image together, use `just local prepare-clickhouse /absolute/path/to/new-schema`. That explicit recipe invokes Docker only after native generation. Package application images from staged Linux artifacts separately:

```sh
bun --no-env-file infra/local/artifacts.ts "$ARCH"
just local package "$ARCH"
```

Set `ARCH` to `amd64` or `arm64` for the intended Linux runtime. `.state/artifacts/<arch>` is the sole staging layout for both validation and packaging; there is no custom artifact-directory option. Packaging rejects non-ELF, wrong-architecture and non-executable Rust inputs and external web-workspace symlinks. Dockerfiles select that same layout from Docker's target architecture, not a fixed ARM default. Docker receives only runtime artifacts and Dockerfiles. Do not place private configuration or tokens in the artifact directory; none belong in an image.

Set `RECOUNT_SCHEMA_DIRECTORY` to the prepared directory and `RECOUNT_CLICKHOUSE_IMAGE` to its packaged image. Preparation renders the [DDL template](clickhouse/schema.sql.in); the runtime-only image pins ClickHouse 26.8.34.13 and embeds generated artifact hashes. It never overwrites an existing directory. `--output-rows` overrides `RECOUNT_NORMALIZER_OUTPUT_ROWS` for the native insertion-partition ceiling only. `--normalized-broker-max-bytes` overrides `RECOUNT_NORMALIZED_BROKER_MAX_BYTES` and must match the normalizer's topic declaration. `--kafka-receive-bytes` overrides the independent native protocol-response ceiling. The bundle records the `ProtobufSingle` format, fixed one-point shape, transport declarations and generated `native-profile.xml`/`native-transport.xml`, including defaults and provenance. Application packaging uses declarative [Buildx Bake targets](local/docker-bake.hcl) after target-architecture, executable and staging-privacy checks; native development does not require these images.

Every ClickHouse start checks the mounted SQL, generated columns, proto, profile, transport settings and declared bounds against the **image-pinned** manifest before the official entrypoint starts any server or native consumer. Runtime row/topic-budget/receive overrides must match preparation; omission uses exported owner defaults, not whatever custom value happened to be prepared. Rehashing mutually consistent but wrong mounted columns/DDL cannot change that trusted reference. The schema mount remains read-only at `/etc/clickhouse-server/format_schemas/`; health checks subsequently compare actual target columns with the trusted artifact. Rebuild artifacts and explicitly recreate incompatible disposable state for a schema cutover. There is no old-schema reader or automatic reset. Stop/recreate affected consumers and refresh their format-schema cache as part of an explicit cutover, never by overwriting files underneath a running consumer.

## Select data storage

The base stack uses project-scoped Docker named volumes and needs no host filesystem paths or mount helpers. Docker manages its own image, cache and volume storage; its physical disk layout is outside this repository. The stack never imports data from another project or previous stack.

For separately mounted project data, add `infra/local/data.binds.yaml` to `COMPOSE_FILE` and set all three expanded absolute paths: `RECOUNT_POSTGRES_DATA_DIRECTORY`, `RECOUNT_KAFKA_DATA_DIRECTORY` and `RECOUNT_CLICKHOUSE_DATA_DIRECTORY`. Paths in overlays are relative to the backend file. Every bind has `create_host_path: false`, including schema/configuration mounts. A missing directory fails rather than initializing an unexpected database elsewhere.

`just local up` rejects configured host-data paths that were not selected in resolved Compose mounts, including a forgotten bind override. Normal starts require concrete database identity/content, not merely an existing directory. PostgreSQL checks its current major, control file, database content and system identifier; Kafka checks its cluster/node identity and metadata log; ClickHouse checks its server UUID and current table metadata. Configure the expected identities with `RECOUNT_POSTGRES_DATA_ID`, `RECOUNT_KAFKA_DATA_ID` and `RECOUNT_CLICKHOUSE_DATA_ID`. The container entrypoint checks these before invoking each official image entrypoint, including ordinary container restarts; missing/empty data cannot trigger replacement initialization.

Physical-volume mounting and filesystem UUID checks belong in ignored machine-local launchers, before invoking shared commands. Keep existing local mount safeguards when selecting external storage; the portable preflight does not run `diskutil`, `findmnt`, mount helpers or disk relocation. It checks selected existing binds and database content; the in-container guard independently checks database identity. No shared command substitutes a volume or initializes replacement data when a selected bind is unavailable.

ClickHouse requires case-sensitive storage. Docker named volumes provide the portable default. If choosing a host bind, provision a compatible filesystem and permissions yourself. Startup does not mount disks, relocate data or fall back to a different location when a configured bind is unavailable.

ClickHouse data binds must already be writable by its image user, UID/GID `101:101`. The pinned entrypoint is configured not to recursively chown paths: it would otherwise attempt to change ownership of the read-only schema mount. Named volumes inherit the image directory ownership; host bind ownership is an explicit preparation step, never an automatic startup rewrite.

## Initialize an isolated current-schema instance

These commands start services and create current-schema state. Use them only for an explicitly selected instance and resource allocation. They do not authorize changing an already running shared stack.

1. Run application `just setup` or copy `infra/local/.env.example` to its ignored `.env`. Select an explicit new Compose project and replace passwords privately. Application and SELECT-only ingestion roles remain separate. Container database URLs use `postgres:5432/recount`; native tools use the loopback development port and explicitly exported service settings.
2. Run `just local init postgres` and `just local init kafka` only for their explicitly selected empty data. Each finite operation checks emptiness, starts one uniquely named one-off without dependencies, waits up to 180 seconds for readiness, stops it and reports the established identity. PostgreSQL readiness uses TCP loopback, which is unavailable during the image's temporary bootstrap server. Record the printed `RECOUNT_POSTGRES_DATA_ID` and `RECOUNT_KAFKA_DATA_ID` in the selected ignored configuration. Creation is inside signal/cleanup scope: failed or interrupted creation inspects only that invocation's UUID-bearing name and stops it if present. Partial data/container state remains for inspection, never automatic repair.
3. Start those initialized roles with `just local compose up --no-build --no-deps --detach --wait postgres kafka`. Explicitly run `just local topics-create`; existing topics cause creation to fail rather than be altered. `just local topics-verify` is read-only validation. Apply current Drizzle migrations through `just db-migrate` with the selected host database URL. Then set `RECOUNT_INGESTION_PASSWORD` privately and run `just local provision-ingestion`; its SELECT-only grants and four-connection role limit remain authoritative.
4. With all normalizer consumers and ClickHouse stopped, run `just local initialize-normalizer-offsets` for the genuinely fresh raw group. It invokes the native normalizer with the selected loopback broker and options before `bootstrap`, refusing existing checkpoints. It seeds retained earliest offsets but cannot prove a deleted prefix was complete. `just local initialize-clickhouse-offsets` separately refuses an existing ClickHouse group or nonzero normalized earliest offsets and reads back all zero seeds. Partial/unconfirmed seeds require inspection, never automatic repair or retry as recovery.
5. Prepare/package the matching ClickHouse schema image, then run `just local init clickhouse` only on its selected empty data. Record its printed `RECOUNT_CLICKHOUSE_DATA_ID`. Never use initialization to repair or replace missing bound data. Retain independently known identities and physical mount checks for existing installations.
6. Run `just local up` and `just local status`. Start native applications separately, or explicitly package them and run `just local apps-up`. Apply backend configuration changes through `local up` first; `apps-up` updates only application containers and never applies backend changes. `apps-stop` stops only those applications; `stop` stops only the backends and preserves data. The normalizer has no HTTP endpoint; inspect readiness/assignment and lag. ClickHouse health validates schema/query access, not freshness or successful consumption.

Published backend/application ports bind only to `127.0.0.1`; the controller remains private. Separate internal networks isolate broker, authority and analytics access. A packaged normalizer joins only the broker network and receives no PostgreSQL/ClickHouse credentials. Web has outbound connectivity for email; these commands do not send email or enroll collectors. VM/Ansible setup is the optional [Linux lab](lab/README.md). Configure optional bind files through `COMPOSE_FILE`; `apps-up` appends the application overlay without replacing the selected storage configuration.

Separate per-service access bridges enable loopback port publication for PostgreSQL, ingestion and ClickHouse. They do not connect those services to one another. Docker does not publish ports for a container attached only to internal networks; the private backend networks remain internal.

## Configuration ownership

Use `recount-ingestion-api --help`, `recount-normalizer --help` and `recount-schema-export --help` for generated option/default references. The shared `Limits` type owns the seven admission/normalization defaults; its flattened Clap group owns their flags and environment bindings. Component configuration owns independent service settings. The shared transport module owns row/topic-budget defaults and pure headroom calculations. Compose owns deployment topology, retention, broker-wide controls and resource caps, not a second inventory of application defaults.

The application overlay forwards explicitly allowlisted environment keys. Unset shared limits and normalizer settings remain unset in containers, so binaries apply their own defaults. Shell values override a selected Compose `--env-file`; a `.env` file alone is not wholesale forwarded. Empty application-limit overrides remain invalid rather than silently selecting defaults. Ingestion receives no normalized-topic settings; the normalizer receives no database credentials. The [example](local/.env.example) keeps deployment selections and focused override examples.

```sh
cargo run --locked -p recount-ingestion-api -- validate
cargo run --locked -p recount-normalizer -- validate
```

These commands check declarations without credentials, backend clients or sockets. They cannot establish permissions, actual topic caps/counts, database identity, schema compatibility or retained checkpoints. Ordinary startup still verifies its component-owned live boundaries; only explicit initialization/bootstrap operations create state. Coordinate structural overrides across ingestion and normalizer, topic budgets across producers/broker/consumers, and row/normalized-budget changes with a newly prepared trusted bundle before traffic. Never lower limits beneath accepted backlog.

## Broker and native consumer settings

| Control                                     | Development default                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Raw / normalized topics                     | `recount.metrics.raw` / `recount.metrics.normalized`                                             |
| Raw / normalized partition counts           | `RECOUNT_RAW_PARTITIONS=3` / `RECOUNT_NORMALIZED_PARTITIONS=3`                                   |
| Per-topic retention time                    | `RECOUNT_RAW_RETENTION_MS` / `RECOUNT_NORMALIZED_RETENTION_MS`: `21600000` (6 h)                 |
| Per-topic retention bytes per partition     | `RECOUNT_RAW_RETENTION_BYTES` / `RECOUNT_NORMALIZED_RETENTION_BYTES`: `134217728`                |
| Topic segment bytes / roll interval         | `RECOUNT_{RAW,NORMALIZED}_SEGMENT_BYTES=16777216` / `RECOUNT_{RAW,NORMALIZED}_SEGMENT_MS=60000`  |
| Topic record ceilings                       | `RECOUNT_RAW_BROKER_MAX_BYTES=6291456`, `RECOUNT_NORMALIZED_BROKER_MAX_BYTES=2097152`            |
| Broker message / replication fetch ceilings | `RECOUNT_BROKER_MESSAGE_BYTES=6291456`, `RECOUNT_BROKER_FETCH_BYTES=6291456`                     |
| Broker request ceiling                      | `RECOUNT_BROKER_REQUEST_BYTES=8388608`                                                           |
| Native normalized fetch / receive targets   | normalized topic budget / max(6 MiB, topic budget + 512); independent receive override supported |
| Native queued bytes target                  | ceil(2 × normalized topic budget / 1024) KiB; one-message minimum                                |
| Native source target / poll batch           | one row target / one Kafka record                                                                |
| Native poll / flush intervals               | 100 ms / 1000 ms                                                                                 |
| Normalizer / ClickHouse groups              | `recount-normalizer` / `recount-clickhouse`                                                      |

`RECOUNT_BROKER_RETENTION_MS`, `RECOUNT_BROKER_RETENTION_BYTES`, `RECOUNT_BROKER_SEGMENT_BYTES` and `RECOUNT_BROKER_SEGMENT_MS` explicitly set broker fallbacks to the same defaults. Both topics always receive explicit settings. Topic initialization checks existing counts/configuration and fails on differences; it does not resize, drain, delete or reconfigure them. Partition affinity assumes fixed counts. Coordinate count or limit changes across ingestion, normalizer, broker and ClickHouse before admitting traffic; do not lower downstream limits beneath accepted backlog.

Raw and normalized bodies retain provisional 4 MiB and 1 MiB bounds, with broker framing headroom. Each normalized Kafka body contains exactly one bare `AnalyticalPoint`. The native parser uses `ProtobufSingle`, `recount.proto:AnalyticalPoint`, no registry prefix/autogenerated schema, no broken-message skips and zero parse-error tolerance. `kafka_commit_every_batch=0` and `kafka_commit_on_select=0` preserve storage-before-commit sequencing; Kafka offsets and storage are not transactional. Multirow file/HTTP fixtures and query exports separately use standard delimited `Protobuf`, not an alternate Kafka reader.

Ingestion and normalizer share structural limits and exact normalized-size preflight, including the distinction between one normalized body and total output from one raw request. Both adapters reuse the headroom validator: each positive body capacity plus 65,536 bytes must fit its respective topic budget. Topic budgets used by these clients must be within librdkafka's 1,000–1,000,000,000-byte range. Broker-wide message, replication-fetch and socket-request controls retain independent operational meanings; matching defaults do not make them aliases of either topic budget.

For raw topic budget B, normalizer per-partition fetch is B, total fetch is 2B, queued raw bytes target is ceil(2B/1024) KiB, and receive allowance is max(100,000,000, 2B+512) bytes. The normalized producer queue targets ceil(2N/1024) KiB for normalized topic budget N, retaining its 128-message target, zero linger and 10 ms poll. ClickHouse derives per-partition/total fetch N and receive max(6 MiB, N+512), with the same ceil(2N/1024) KiB queue target. `RECOUNT_KAFKA_RECEIVE_BYTES` remains an independent native response override: an explicit value must cover N+512 and fit Int32. Receive limits cover metadata and other protocol replies as well as fetched records. Preserving the previous response floors avoids reducing control-plane headroom for low record budgets and high declared partition counts; it does not model every possible cluster's metadata. A deliberately smaller receive override is an operator-selected protocol ceiling, not evidence that all metadata will fit. Explicit consumer `message.max.bytes` matches the respective topic budget so librdkafka does not silently raise fetch above the receive allowance. These calculations follow [librdkafka's configuration rules](https://github.com/confluentinc/librdkafka/blob/v2.12.1/CONFIGURATION.md); fetch and queue sizes are soft targets, not peak-RSS guarantees. The [ClickHouse configuration loader](https://github.com/ClickHouse/ClickHouse/blob/v26.8.34.13-lts/src/Storages/Kafka/KafkaConfigLoader.cpp) maps XML underscores to standard Kafka property dots. One decode lane and all existing timeouts remain unchanged. There is no cross-request batching delay. Increasing active work requires measured memory/concurrency validation within the fixed container cap.

ClickHouse consumes into `telemetry.normalized_kafka`, then `telemetry.ingest_metric_points` inserts unchanged rows into `telemetry.metric_points`. The target uses `ReplacingMergeTree`, event-day partitions and `(project_id, source_id, resource_id, metric_name, time_unix_nano, sample_id)` ordering. Inserts fsync data and part directories. Native input rows/block and fetch/queue bytes are conservative targets, not a hard decoded-memory proof: an indivisible wide record can overshoot a row/block target, and decoded nested attributes consume more than wire bytes. Measure native peak memory and sparse flush behavior before claiming capacity.

The native row target and poll batch are **1**. The producer emits one point per record and `ProtobufSingle` parses one message; the non-expanding view and unsquashed insert preserve this one-event-day chunk. The exporter retains a finite conservative `max_partitions_per_insert_block=R` with throwing enabled, where `R = RECOUNT_NORMALIZER_OUTPUT_ROWS` ranges 1–16384 and defaults to 128. This is a native profile ceiling, not a normalizer packing option. Its approved generated transport settings, defaults and bundle hashes remain deployment inputs. Changing chunk/poll behavior requires native validation rather than assuming a row target is a hard bound for arbitrary inputs.

The prepared profile, bound file and manifest use the same R; image startup refuses an environment/preparation mismatch. Coordinate current framing, image/profile and consumers before traffic without reducing limits beneath accepted backlog. Single-point fanout and oversized-record cases retain the finite guard, but do not establish memory or throughput capacity for every R. No timestamp cutoff, day-aware packing framework or unlimited partition setting is introduced.

Kafka retains the existing 768 MiB development cap; ClickHouse retains 1.5 GiB with no swap and a 1.25 GiB server budget. Merge blocks target 128 rows/1 MiB. Reader queries remain limited to 256 MiB, six seconds and one thread. No cap is raised to hide failures. Six hours/128 MiB per partition is provisional retention, not a full-fleet or 24-hour recovery guarantee; asynchronous cleanup, active segments, metadata and internal topics use extra space. One broker/node does not provide disk-loss recovery or HA.

## Query and inspect recovery

Web receives only `RECOUNT_CLICKHOUSE_URL` and `RECOUNT_CLICKHOUSE_READER_PASSWORD`; `telemetry_reader` can SELECT the point table, not insert, alter or query the Kafka source. `telemetry_admin` is reserved for provisioning/operations. No application writer account, Rust storage service or PostgreSQL telemetry-index role remains.

```sh
just local query 'SELECT project_id, source_id, count() FROM telemetry.metric_points FINAL GROUP BY project_id, source_id LIMIT 20'
just local compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group recount-clickhouse
just local compose --file compose.yaml --file compose.apps.yaml logs --tail 20 normalizer
just local stop
```

`FINAL` provides logical sample uniqueness before duplicate-sensitive calculations; physical row counts may include retries until background replacement. Keep project authorization in application operations; an operator SQL command is not a tenant access-control boundary. There is no automatic telemetry TTL or permanent first-content-winner registry.

Poison records and unavailable offsets must remain visible failures without advancing past data loss. Inspect `system.kafka_consumers` with the native administrator for assignments/exceptions and standard Kafka group lag. Default native handling retries an affected stream; it does not quarantine or skip poison, and one consumer can stall other assigned partitions as well. With `auto.offset.reset=error`, expired offsets are unrecoverable gaps requiring an explicit operator decision, never silent success from earliest/latest. Broker/storage outages use bounded retries/backpressure; a crash around a storage/offset acknowledgement can replay samples. Keep immutable IDs and duplicate-safe queries intact.

Native session/heartbeat intervals are 10000/3000 ms; ClickHouse receives a 60-second graceful stop budget. After an unclean stop, allow the consumer session/rebalance to complete; a running server or successful point query does not prove a fresh Kafka assignment. Kafka's offset-reset CLI can print an active-group error while returning exit status zero. Any explicit test/operator reset must first verify an inactive group and then read back all intended checkpoints before restarting consumers. Normal startup never resets offsets.

`stop` preserves data. No recipe runs `down --volumes`, deletes topics or removes host data. Recreate only explicitly identified disposable state after inspecting its project/name/mounts. Native Kafka replay, failure, sparse flush and event-partition tests are separate integration gates; the local Protobuf fixture alone does not validate them.

## Validate native ingestion

The native gate is exposed through `just test-recovery` and the testing-owned `tests/justfile`. It requires explicitly allocated Kafka/ClickHouse authority and synthetic credentials, never inherited private environment files or unqualified shared groups. Allocate the 768 MiB broker / 1536 MiB ClickHouse slot before running it; helper processes retain their resource bounds. Compile inputs on the host. Ordinary browser/reader leaves reuse services with disposable private fixture state and do not restart the recovery sequence.

Prepare the shared `contract_fixture` and binary-safe Protobuf inputs using Cargo's compiler-artifact paths. Use the native schema exporter above for a matching new bundle and a compatible execution environment for Linux artifacts. Keep allocation evidence local. Inspect available leaves and their arguments before selecting a gate:

```sh
just --justfile tests/justfile --list
```

Kafka producers send each complete bare point as one binary message, preserving control bytes and newlines. Do not send a line-oriented payload or an entire multirow fixture file: the storage harness explicitly decodes its standard file stream and serializes each point separately. Coverage retains the native Kafka/MV path, generated-field/scalar-bit round trips, replay, unavailable destination and poison/no-commit behavior. Dedicated retention fixtures may expire only their own synthetic prefix; never change runtime-topic retention. Normalizer topology/cap/checkpoint checks are startup snapshots, with later native errors logged and reset disabled. Sparse single-point replay must become visible within its unchanged deadline. Restart cases require separate authority and cannot interrupt shared backends. Neither healthchecks nor these small fixtures establish capacity or every crash window.

Docker installations with exhausted default subnet pools require a separately allocated ignored local Compose network override, not network pruning or global daemon changes. Reuse/recreate a network only after verifying its project labels and exclusively owned endpoints; never connect unrelated projects. Backend networks remain internal, with separate access bridges for loopback publication. Keep machine-specific subnets and physical storage allocations out of shared source and CI.
