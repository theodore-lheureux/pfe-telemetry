# Execution recordings and telemetry

Project readers can open every execution in their project. A recording selects an enrolled source, optional exact host and fixed half-open interval of at most seven days. PostgreSQL retains that selection independently of credential rotation or revocation. Creator attribution controls renaming, not read visibility: members rename their own recordings, project admins rename any, and viewers cannot write. Listings use 50-item UUID keyset pages.

The charts show source-labelled **node context**, not execution workload consumption. They support recognized node CPU/memory semantics from standard OTLP and `external/1.0` input, and display each series' profile separately. The current collector deliberately sends standard OTLP; a profile label does not establish measurement truth or workload membership. The collector supplies no authoritative execution lifecycle signal; recordings have no inferred running or completed status. Process association claims remain unresolved. Overlapping recordings can show the same samples.

## Storage and replay

The storage worker uses the [official Rust client](https://clickhouse.com/docs/integrations/rust) to insert one complete envelope per synchronous ClickHouse row. A row contains the authenticated project/source, logical storage key, content digest, Kafka provenance, typed `Nested` point arrays and complete supported OTLP payload. The client validates the schema; ClickHouse enforces aligned nested-array lengths. The single-node MergeTree table enables insert and part-directory fsync. One row cannot expose partially inserted point arrays; there is no multi-table or PostgreSQL/ClickHouse transaction claim. Confirmation precedes offset commit. A response lost after insertion can replay.

Ingestion checks the same 64 MiB normalized-size budget as storage before Kafka publication, so metadata repetition cannot create an admitted but unrepresentable batch. The budget is a projection-size estimate, not a process memory limit. Stream identity canonicalizes attribute sets, including nested key/value lists, while preserving array order and the original supported payload for replay and conflict detection.

Logical identity is `(project, source, payload kind, client batch ID)`, or the retained record ID when no client ID exists. Content checks exclude server receipt time and record identity so client retries match. The writer checks previous digests and stops on conflicts without committing that offset. Queries always choose the complete lowest-offset batch per key before host/time predicates or aggregation. Duplicate physical rows therefore do not multiply results, regardless of merges or server deduplication-window expiry. Concurrent rebalance writes converge to the first Kafka record; conflicting later content cannot replace it.

Keep the topic name, partition count and partitioning unchanged while its history exists. Each key must retain one topic/partition provenance; detected changes stop writing and make affected queries fail. Do not recreate a topic with reset offsets against retained analytics. No automatic TTL deletes telemetry or deduplication history. There is no production migration; disposable prototype state may be recreated explicitly.

The current worker uses consumer group `pfe-storage`. Do not reuse consumer progress from a different storage sink: those offsets do not prove ClickHouse persistence. Start with disposable current-schema state or a new group that replays the retained Kafka records into it. Measurements older than broker retention are not imported from superseded exports.

The table partitions by a stable project/source hash into 16 partitions and orders by project, source, logical key and offset. Batch-level deduplication deliberately scans the selected source's history before applying time restrictions: pruning conflicting batches by their own timestamps could select the wrong content. This prototype caps that scan rather than claiming unlimited historical throughput. A higher-volume design needs a durable, coordinated batch-acceptance index before adding time pruning.

## Queries and values

Every server operation independently resolves the verified session and canonical project access. Execution, cursor, credential and mutation lookups include organization and project predicates. Query source/host/range comes from authorized PostgreSQL metadata, never browser-supplied tenant assertions. The [official JavaScript client](https://clickhouse.com/docs/integrations/javascript) runs only in `.server.ts` code with the read-only credential; there is no application SQL endpoint or private Query cache.

Queries accept a positive interval within the recording, at most 24 hours, and 1–600 buckets (300 by default). Initial queries cover at most five minutes. Each bucket retains its last measured sample, deterministically breaking same-time ties. Missing buckets are absent, explicit no-recorded-value samples remain null, and charts do not interpolate or zero-fill. CPU remains cumulative seconds across logical CPUs, not utilization. Memory is node-wide bytes. Resource/scope/boot/epoch/segment identities and counter origins remain separate series; no counter rates are inferred.

Nanoseconds use UInt64 and scalar integers use Nullable(Int64) in ClickHouse. Application responses retain timestamps and integer values as decimal strings; only bucket milliseconds become safe JavaScript numbers. Exact integers appear in locale-aware tables. Values outside JavaScript's safe integer range are not plotted. Histograms, summaries and exponential histograms retain native payload semantics but have no scalar chart. Charts require an explicit `pfe.collection.scope=node`, recognized names/units/types, and non-negative numeric byte gauges or cumulative monotonic CPU seconds. Native integer and double representations remain distinct; standard OTLP does not have to use the external profile's narrower scalar types. Missing standard-OTLP context is not inferred. Other telemetry remains retained without scalar charts. Trace and profiling signals remain unsupported at ingestion.

Buckets use source timestamps, including late arrivals, without clock correction. Nanosecond encoding does not establish measurement resolution or cross-node synchronization. Clock and coverage diagnostics remain in the retained supported payload; the charts do not manufacture clock-quality or live-health indicators.

| Boundary                                             | Limit                                |
| ---------------------------------------------------- | ------------------------------------ |
| Per web process / reader-user concurrent queries     | 2, no application waiting queue      |
| Source history read                                  | 100,000 batch rows / 256 MiB         |
| Query memory / threads / execution / client deadline | 256 MiB / 1 / 6 seconds / 10 seconds |
| Grouping / spill                                     | 200,000 groups / disabled            |
| Response / series / buckets                          | 4 MiB / 24 / 600                     |

Capacity, deadlines, unavailable storage and schema/query failures are errors, never successful empty or truncated responses. An empty result means no supported samples matched the authorized selection, not that ingestion is healthy. Query success sees completed local inserts; ingestion acknowledgement confirms Kafka retention only. Broker lag and retained-history loss must be monitored separately. A single node has no replica/disk-loss guarantee.

## Provision and validate

Use the [local pipeline](../infra/telemetry/README.md). Apply `infra/telemetry/clickhouse/schema.sql` explicitly with an administrator; it is repeatable for the current schema. Runtime credentials cannot create, alter, drop or truncate telemetry. The reader has SELECT only; the writer has SELECT/INSERT only. Do not give the application the provisioning credential. TLS and network access controls are required outside the isolated local setup.

Run storage integration tests against a disposable provisioned ClickHouse with `TELEMETRY_CLICKHOUSE_URL`, writer `TELEMETRY_CLICKHOUSE_PASSWORD` and `TELEMETRY_CLICKHOUSE_READER_PASSWORD`. Run database integration with disposable `TEST_DATABASE_URL`; helpers create random databases and apply the committed Drizzle history.
