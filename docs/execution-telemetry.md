# Execution recordings and telemetry

Project readers can open every execution in their project. A recording selects an enrolled node as its source, optional exact host and fixed half-open interval of at most seven days. PostgreSQL retains that selection independently of node revocation or deletion. Creator attribution controls renaming, not read visibility: members rename their own recordings, project admins rename any, and viewers cannot write. Listings use 50-item UUID keyset pages.

The charts show source-labelled **node context**, not execution workload consumption. A recording's one-source/optional-host selection is not a resource hierarchy or proof of workload attribution. The collector supplies no authoritative execution lifecycle signal; recordings have no inferred running or completed status. Overlapping recordings can show the same samples.

## Storage and visibility

The [point contract](telemetry-point-contract.md) defines authenticated OTLP → raw Kafka → Rust normalizer → normalized Kafka → native ClickHouse consumption. The web application reads `telemetry.metric_points` directly. PostgreSQL stores application metadata and authorization, not telemetry acceptance, windows or completeness manifests.

Kafka acknowledgement confirms raw publication, not queryability. A query returns available matching points; different parts of a submission may become visible at different times. There is no whole-batch visibility gate. An empty result means no supported samples matched the authorized selection, not that ingestion is healthy. Capacity, timeout, unavailable storage and schema/query failures are errors, never successful empty or truncated responses.

Supported immutable retries retain their original sample identity and event-day partition. The reader uses bounded `FINAL` before selecting bucket samples, so physical duplicate rows do not depend on background merge completion. Reusing a producer identity with changed content is a protocol violation with undefined competing-row results; there is no permanent first-content-wins ledger.

## Authorization and selectors

Every server operation independently resolves the verified session and canonical project access. Execution, cursor, credential and mutation lookups include organization and project predicates. Query project/source/host/range comes from authorized execution metadata, never browser-supplied resource or tenant assertions. The [official JavaScript client](https://clickhouse.com/docs/integrations/javascript) runs only in `.server.ts` code with the separate SELECT-only credential. There is no application SQL endpoint or private Query cache.

The chart query requires a typed host resource (`resource_kind=1`) and an explicit string resource attribute `recount.collection.scope=node`. It recognizes:

- `recount.node.cpu.time`: cumulative monotonic sums in seconds.
- `recount.node.memory.total` and `recount.node.memory.available`: nonnegative gauges in bytes.

No-recorded observations remain null even when their payload contains a value. Flags remain available in the response. Other metric kinds and semantics remain stored but have no scalar chart. No provider profile, Linux process identity, missing node context or workload membership is invented.

## Buckets, continuity and exact values

Queries accept a positive interval within the recording, at most 24 hours, and 1–600 buckets (300 by default). Initial queries cover at most five minutes. Each continuity-specific `stream_id` segment retains its last sample per bucket; original sample identity deterministically breaks timestamp ties. Missing buckets stay absent. Segments are neither summed nor connected. CPU is cumulative seconds, not utilization; no counter rates are inferred.

Logical charts group actual project/source/resource, instrumentation name/version, schema URLs, metric semantics and canonical typed resource/scope/point attributes. Only resource `recount.host.boot_id`, resource `recount.collection.epoch_id`, point `recount.counter.segment_id` and counter start origin are excluded from the logical group. They still distinguish continuity-specific stream segments. Other providers, resource contexts and typed dimensions remain separate. Attribute map order does not change grouping; numeric types, Float64 bits, array positions and missingness remain distinct.

Nanoseconds use UInt64 and scalar integers use Nullable(Int64) in ClickHouse. Responses retain timestamps and integer values as decimal strings; only bucket milliseconds become safe JavaScript numbers. Internal application RPC boundaries retain `Date`. Exact integers appear in locale-aware EN/FR tables; values outside JavaScript's safe integer range are not plotted. Histograms, exponential histograms and summaries keep their native typed analytical fields without payload decoding, but have no chart UI.

Buckets use source timestamps, including late arrivals, without clock correction. Nanosecond encoding does not establish measurement resolution or cross-node synchronization. The charts do not manufacture clock-quality or live-health indicators.

| Boundary                                               | Limit                                |
| ------------------------------------------------------ | ------------------------------------ |
| Concurrent reads, all web instances / per organization | 2 / 1, waiting up to 5 seconds       |
| Physical point rows / bytes read                       | 100,000 / 256 MiB                    |
| Query memory / threads / execution / client deadline   | 256 MiB / 1 / 6 seconds / 10 seconds |
| Grouping / spill                                       | 200,000 groups / disabled            |
| Result rows / result bytes                             | 50,000 / 8 MiB                       |
| Logical charts / segments / buckets                    | 24 / 256 / 600                       |

These are bounded-query safety controls, not a fleet-capacity promise. Queries project only the supported scalar fields and grouping dimensions, not distribution arrays, lineage or complete payloads. A narrow selector can still exceed a physical read bound; shorten the interval rather than silently dropping points. Eventual visibility does not guarantee complete retained history or recovery from broker expiry or disk loss.

## Reader configuration and checks

Set `RECOUNT_CLICKHOUSE_URL` to the ClickHouse HTTP origin (for example, `http://clickhouse:8123`) and `RECOUNT_CLICKHOUSE_READER_PASSWORD` to the `telemetry_reader` password. The client selects database `telemetry`. The URL must not contain credentials, a query, a fragment or a non-root path. The web application needs SELECT only and never a PostgreSQL storage role or ClickHouse writer password.

Every ClickHouse read by the web application, from execution charts to Activity, Explore and the Overview, first reserves a slot in the PostgreSQL table `app.analytics_slot`, so the limits hold across web instances. `RECOUNT_ANALYTICS_CONCURRENCY` sets the reads running at once across all instances (default 2) and must not exceed the `telemetry_reader` profile's `max_concurrent_queries_for_user`. `RECOUNT_ANALYTICS_ORGANIZATION_CONCURRENCY` sets the reads one organization may run at once (default 1, at most the total). A read that finds no free slot retries for up to five seconds and then fails with `CAPACITY`; a cancelled request stops waiting. Reservations expire after 60 seconds, which releases those of a stopped instance. The table is `UNLOGGED`: it skips the write-ahead log and replication, and PostgreSQL empties it after a crash.

The disposable reader fixtures use the shared host-built `contract_fixture` executable. Set `RECOUNT_CONTRACT_FIXTURE` to its executable path from Cargo's compiler-artifact JSON. The native Bun suite invokes it with `--ordinary` and `--columns`, loads length-delimited `AnalyticalPoint` Protobuf through the real ClickHouse HTTP client, and keeps replacing merges stopped while checking duplicates:

```sh
bun run i18n:compile
just test-integration telemetry
```

Supply `RECOUNT_CLICKHOUSE_TEST_URL`, the synthetic administrator's `RECOUNT_CLICKHOUSE_TEST_USER`/`RECOUNT_CLICKHOUSE_TEST_PASSWORD`, and `RECOUNT_CLICKHOUSE_TEST_READER_PASSWORD` for the allocated `telemetry_reader` without access to randomly named fixture databases. The reused server must have the matching `recount.proto` in its format-schema directory. The helper creates and removes only its own database and a uniquely named SELECT-only reader. Checks cover positive reads, actual write/unrelated-read denial, cancellation, exact scalar values, typed dimension ordering/bits and query/concurrency limits. They do not establish native Kafka ingestion or the full collector-to-browser path. See the [test contract](../tests/README.md) for allocation settings and assertion owners.

## Allocated execution browser pipeline

`apps/web/tests/browser/execution-pipeline.spec.ts` is an explicitly selected two-collector EN/FR gate, not infrastructure provisioning. Obtain a coordinator execution lease first. The coordinator must provision fresh allocated raw/normalized topics, a matching native ClickHouse consumer/source/group and the current schema, plus the application authority database and its isolated networks. Do not reuse poisoned topics or a previous normalizer group. The test does not create topics, initialize native tables, reset checkpoints or drain old records.

For daily iteration, use host Node Playwright and native Bun against the reused backend, with native ingestion/normalization and Linux collectors. Select the separate full-pipeline configuration with `just test-integration pipeline`. It starts packaged Linux collector/API/normalizer processes while its fixture runs Bun natively. It does not rebuild backend infrastructure or compile application sources in Docker.

Supply these allocated settings explicitly:

| Settings                                                                                                                             | Purpose                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECOUNT_PIPELINE_ISOLATED=true`, `RECOUNT_PIPELINE_RESTART_CLICKHOUSE=true`                                                         | Confirm the allocated full pipeline and mandatory controlled restart.                                                                                                                  |
| `RECOUNT_PIPELINE_COMPOSE_PROJECT`, `RECOUNT_PIPELINE_NETWORK`, `RECOUNT_PIPELINE_DATABASE_NETWORK`                                  | Approved Compose allocation and existing broker/analytics and authority networks.                                                                                                      |
| `RECOUNT_PIPELINE_BOOTSTRAP`, `RECOUNT_PIPELINE_RAW_TOPIC`, `RECOUNT_PIPELINE_NORMALIZED_TOPIC`, `RECOUNT_PIPELINE_NORMALIZER_GROUP` | Allocated broker addresses, distinct fresh topics and fresh normalizer group. Main `recount.metrics.raw`, `recount.metrics.normalized` and `recount-normalizer` defaults are rejected. |
| `RECOUNT_PIPELINE_KAFKA_CONTAINER_ID`, `RECOUNT_PIPELINE_NATIVE_GROUP`                                                               | Full immutable ID of the existing allocated Kafka container and its native ClickHouse consumer group. Used only to inspect confirmed prefixes; no checkpoint reset is permitted.       |
| `RECOUNT_PIPELINE_RAW_PARTITIONS`, `RECOUNT_PIPELINE_NORMALIZED_PARTITIONS`                                                          | Positive partition counts matching broker metadata and native consumer provisioning.                                                                                                   |
| `RECOUNT_PIPELINE_COLLECTOR_IMAGE`, `RECOUNT_PIPELINE_INGESTION_API_IMAGE`, `RECOUNT_PIPELINE_NORMALIZER_IMAGE`                      | Existing packaged images containing matching host-built Linux executables.                                                                                                             |
| `RECOUNT_PIPELINE_BIN_DIRECTORY`, `RECOUNT_PIPELINE_HOST_ROOT`                                                                       | Host binaries used for hash verification and checkout path used for Docker-daemon queue/token binds.                                                                                   |

The ingestion API and normalizer share explicit `RECOUNT_MAX_REQUEST_BYTES`, `RECOUNT_MAX_POINTS`, `RECOUNT_MAX_EXPANDED_ITEMS`, `RECOUNT_MAX_AUTHORITIES`, `RECOUNT_MAX_ATTRIBUTE_NODES`, `RECOUNT_NORMALIZED_MAX_RECORD_BYTES` and `RECOUNT_NORMALIZED_MAX_OUTPUT_BYTES`. Topic budgets are coordinated declarations; initial development caps are 6,291,456 raw bytes and 2,097,152 normalized bytes, not production capacity guarantees. The normalizer emits one bare point per record, and native Kafka ingestion uses `ProtobufSingle`. The schema exporter's `RECOUNT_NORMALIZER_OUTPUT_ROWS` setting retains the finite native insertion-partition ceiling (default 128); it is not a normalizer packing control. Validate the current schema/topic/count/limit combination before granting a lease; do not substitute a registry or drift controller.

The test explicitly runs `recount-normalizer bootstrap` for the fresh group before starting normal operation. Existing checkpoints cause bootstrap to fail; there is no reset or fallback to a reused group. The ingestion database URL is passed by environment, never as a CLI argument or Docker `--env KEY=value` argument. Its generated authority role has SELECT on exactly the credential, root-grant and independent-resource-grant tables. Two collectors share the stable source but use distinct enrolled Linux roots with process-local kind 4 grants.

Each started process has a read-only root, a 384 MiB memory limit with no additional swap, 0.5 CPU, no capabilities and a 128-process limit. Packaged binaries and bound token files remain read-only. Each collector has only its own writable queue mount, bounded to 8 MiB / 32 batches / 60 seconds and a 500 ms sampling interval. These are smoke-test settings. The normalizer retains its bounded service defaults for active records, retries, delivery and shutdown; this gate does not duplicate the native recovery tests.

Set `RECOUNT_PIPELINE_HOST_ROOT` to the checkout's actual Docker-daemon host path. The generated relative `.state/pipeline/<random-id>` queue/token directory must identify the same files from the host Node runner and Docker daemon. `RECOUNT_PIPELINE_BIN_DIRECTORY` must be readable by the runner. The test validates ELF input, compares each host binary's SHA-256 with its packaged executable, resolves immutable image IDs and starts those packaged entrypoints. No compiler or image build is invoked. `RECOUNT_PIPELINE_DATABASE_HOST` and `RECOUNT_PIPELINE_DATABASE_PORT` select the container-visible PostgreSQL endpoint, defaulting to `postgres:5432` on the allocated authority network.

### Controlled restart

The full gate requires `RECOUNT_PIPELINE_RESTART_CLICKHOUSE=true`; disabling it fails rather than skipping restart coverage. The coordinator must approve and supply `RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER` and its full 64-character `RECOUNT_PIPELINE_CLICKHOUSE_CONTAINER_ID`, in addition to the isolated Compose project and expected network above. Immediately before restarting, Docker inspection must match the full ID, exact name, `com.docker.compose.project`, service label `clickhouse`, running state and expected network. Only the verified immutable ID is restarted; inspection never dumps `Config.Env` or passwords. A name alone is not sufficient authority.

Before capturing the restart baseline, the test stops its publishers, waits for the normalizer's confirmed prefix to reach the raw topic's end, stops the normalizer, and waits for the native consumer's confirmed prefix to reach the normalized topic's end. These read-only checks use the allocated Kafka container's standard CLI after validating its full ID and Compose ownership. The test then requires exact equality for the same published time window after restart. It does not claim that unuploaded collector queue entries were drained.

The test records restart as `NOT_RUN_NOT_REACHED`, `FAILED` or `PASSED`. `pipeline-artifact-identity`, `pipeline-restart-status`, optional `pipeline-restart-identity` and sanitized `pipeline-output` attachments preserve the allocation and artifact evidence. Each output stream carries at most 4,096 UTF-16 characters of an incomplete line across chunks. Complete bounded lines are sanitized before entering the 12,000-character retained tail; oversized lines are discarded through their next newline, never retained as raw suffixes. A bounded unterminated final line is sanitized on child close. Before launching pipeline children, this gate rejects CR/LF in known secret values with a generic error that never prints the value. This is a test-fixture input constraint, not a product authentication or telemetry protocol restriction. Tokens, authority URLs/passwords and known secret environment values are removed from diagnostic output. Cleanup stops only the test's randomly named child containers and removes its generated role and queue/token directory; topic/native-table provisioning remains coordinator-owned.

The full private browser gate and its restart require exclusive coordinated execution. Storage and HTTP reader passes do not establish that browser result.
