# ClickHouse ingestion evaluation

The native metric pipeline (ingestion API → raw Kafka → Rust normalizer →
normalized Kafka → ClickHouse Kafka engine → `ReplacingMergeTree`) was measured
on one development host with isolated topics, consumer groups and databases.
Every run compared the stored rows with the exact sample identities of every
acknowledged batch. The capacity numbers describe this host and allocation; they
are not service targets. The [saved evidence](evidence/clickhouse/2026-11-16/README.md)
holds the commands, configuration and raw results.

## Findings

- **Functional correctness held in every scenario.** After retries, resends,
  service kills, a paused consumer, a rewound checkpoint, delayed responses and
  revocation, `FINAL` returned exactly one row per acknowledged sample. There
  were no foreign or unenrolled sources and no differing physical copies.
  Unacknowledged batches were stored either completely or not at all.
- **The shipped admission limit, one request in flight, sets acceptance
  capacity.** About 7 ms per request capped acknowledgements near 130
  batches/s (about 6,000 samples/s with this workload) however much was offered. The first-attempt
  `UNAVAILABLE` rate follows utilization even at low load (8% at 10 batches/s),
  so acknowledgement latency at higher percentiles is retry backoff.
- **Behind admission, the normalizer limits throughput.** With eight admitted
  requests, the pipeline kept up at 200 batches/s (9,200 samples/s).
  At 400 batches/s and above, the normalizer processed only about 160–200 raw
  records/s (7,500–9,000 samples/s) while using under 10% of a CPU, so it was
  waiting on publication round trips; eight workers raised this to about 290. Raw backlog then grew and the time until
  queryable reached minutes. See [normalizer workers](#normalizer-workers).
- **Freshness is bounded by the ClickHouse flush interval.** Without backlog,
  the median time from send to a queryable row was 1.8–3.2 s, almost all of it
  after acknowledgement; the 2-second `kafka_flush_interval_ms` dominates.
- **Authority lookups do not follow request rate.** The ingestion API read the
  node table about twice a minute, its 30-second revocation poll, at every
  tested rate up to 1,000 requests/s and with 512 principals. Revocation took
  effect 6.6 s and 24.1 s after the update in two runs; the 30-second poll
  plus request timing bounds it.
- **Duplicates collapse logically, not physically.** Resends inside one
  2-second insert block are merged while the block is written
  (`optimize_on_insert`). Later copies remain as physical rows until a
  background merge, and only `FINAL` or identity grouping removes them from
  results. Non-replicated tables have no block-level insert deduplication
  window here.
- **Memory stayed bounded under overload.** At 1,000 offered batches/s, the
  ingestion API stayed at 12.7 MiB RSS and the normalizer at 10.7 MiB. Clients
  received immediate `UNAVAILABLE` responses rather than queueing.
  Maximum-size 4 MB requests raised both to about 140 MiB.
- **ClickHouse merges are the largest memory consumer.** Each merge of the
  point table needed 350–400 MB. Concurrent merges exceeded the 1.25 GiB server
  limit once under heavy ingestion; ClickHouse retried the merge.

## Pipeline and resources

All services ran on one Apple M4 host (10 cores, 16 GiB, macOS 27.0.1).
Containers ran in an OrbStack Linux VM with 10 CPUs and 3.9 GiB. The ingestion
API, normalizer, load generator and k6 ran natively on the same host, so the
generator competed with the system it measured. Other agents' web tests used
the same host during the campaign; recorded 1-minute load averages were 5–14.

| Component     | Version and configuration                                                                                                                                                                                                                                                   | Resource allocation                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Source        | Recount `0.1.0`, commit `f64f408f0bc5`, plus the uncommitted load tool (`+dirty` in allocations)                                                                                                                                                                            | Release builds                                                              |
| Ingestion API | Admission `RECOUNT_INGESTION_MAX_IN_FLIGHT=1` (shipped default) or 8 in the headroom run; 10 s request timeout; Kafka `acks=all`, idempotent, zstd                                                                                                                          | Native process                                                              |
| Normalizer    | `RECOUNT_NORMALIZER_MAX_ACTIVE=2` (shipped default); tracked commits every 1 s; `acks=all`, idempotent, zstd                                                                                                                                                                | Native process                                                              |
| Kafka         | Apache Kafka 4.3.1, one combined broker/controller, replication factor 1; owned topics with 3 partitions (12 in the structural run), 6 h or 128 MiB per partition, 16 MiB/60 s segments                                                                                     | 1 CPU, 768 MiB, 256 MiB heap                                                |
| ClickHouse    | 26.8.34.13; `ReplacingMergeTree` partitioned by event day, ordered by project, source, resource, metric, time and sample ID; `fsync_after_insert=1`; Kafka engine `ProtobufSingle`, one consumer, 4,096-row blocks, 100 ms poll, 2,000 ms flush; 128-partition insert guard | 2 CPUs, 1,536 MiB; server memory limit 1.25 GiB; 4 background merge threads |
| PostgreSQL    | 18.6, migrated application database per allocation; the ingestion API's scoped revocation reader with a one-connection pool                                                                                                                                                 | 1 CPU, 512 MiB                                                              |

ClickHouse `query_log` is disabled in the shipped configuration, so query
latency comes from k6. Insert and merge durations come from `system.part_log`.
The Kafka engine does not record insert peak memory there; server
`MemoryTracking` sampling replaces it.

## Workload

Each allocation enrolled synthetic principals as the web application does: one
signed Ed25519 node token per node, a migrated database with organization,
project, enrollment-key and node rows, and an ingestion API trusting only the
allocation's public key. The main allocation had 64 principals in 4 projects:

| Node kind             | Count | Batch content                                                                                                                                                                        | Samples per batch |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Direct collector      | 48    | Standard profile; the enrolled root resource; 4 gauges × 8 points, 2 point attributes, 4 series values per gauge                                                                     | 32                |
| Linux, multi-resource | 16    | Linux profile; host resource (memory total/available, CPU-time counter by mode) plus 4 process resources (RSS, CPU-time counter), each a local resource with an execution membership | 88                |

Batches averaged 46 samples and 2,550 encoded bytes. Retained raw records
averaged about 720 bytes and normalized points about 92 bytes (zstd), a 5.9×
expansion. Batch identities are `<phase>-<node>-<sequence>`, and each sample's
ID derives from the trusted project, the node, the batch ID and its original
position.

Arrivals were seeded Poisson streams at the stated mean rate, open-loop: a
slot without client capacity (512 unfinished batches, 256 in overload) was
counted as skipped rather than delaying later arrivals. Failed requests were
retried unchanged with the collector's equal-jitter backoff, scaled down to a
3-second ceiling and 6 attempts. A client that exhausts its attempts is
recorded as `rejected`, which a real collector would keep retrying from its
disk queue. Every second, a one-point probe measured acknowledgement and the
time until a row with its sample ID was readable, polling every 50 ms.

The probe query now filters on the partition and full sorting key, reading one
granule. During the original campaign it filtered only on the sample ID, so
each poll scanned the growing table. The headroom 400 and 800 batches/s steps
and the normalizer-workers step were re-measured with the filtered probe. All
other figures from phases with probes (baseline, shipped-admission steps,
overload, recovery, soak and maximum-size requests) include that extra scan
load: their ClickHouse CPU and memory, concurrent read latency, time until
queryable and drain times are pessimistic. Identity verification is
unaffected.

Concurrent reads replayed four statements compiled by the web application's
own code, with its settings, through ClickHouse HTTP as a SELECT-only user with
the `telemetry_read` profile:

| Statement                   | Shape                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `node_chart`                | Node CPU/memory chart for one Linux node over 15 minutes, 120 buckets, with `FINAL` |
| `gauge_by_node`             | Average available memory per node, 10-second buckets                                |
| `counter_rate_by_execution` | Process CPU rate grouped by execution through the participant join                  |
| `execution_memory_table`    | p95 of process RSS for one execution, grouped by resource                           |

The reads skip the web server, session and PostgreSQL access checks; they
measure ClickHouse under concurrent ingestion.

## Functional correctness

Each verification is cumulative over the allocation. Totals are from the last
verification of each allocation.

| Scenario                               | Injection                                                                        | Result                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalizer crash and restart           | `SIGKILL` 20 s into a 50 batches/s run, restart after 30 s                       | Raw backlog peaked at 1,646 records; 88 points published before the kill were replayed and stored twice; `FINAL` exact                                |
| ClickHouse consumer stopped            | Kafka table and view detached for 30 s under load                                | Normalized backlog peaked at 72,515 records, drained at 1,826 records/s net; no rows or offsets lost                                                  |
| Ingestion API crash                    | `SIGKILL` under load, restart after 5 s                                          | 4 batches unacknowledged and absent; clients retried the rest; acknowledgement p99 8.9 s                                                              |
| Stored insert without committed offset | Idle owned group rewound 5,000 records per partition                             | 15,000 records replayed; physical rows exceeded logical rows by 10,904 at verification; `FINAL` exact                                                 |
| Lost response                          | Every fifth acknowledged batch resent unchanged after 3 s                        | Copies stored in later insert blocks; `FINAL` exact                                                                                                   |
| Delayed responses through Toxiproxy    | 400–2,000 ms latency per downstream chunk, 1 s client deadline, up to 8 attempts | 1,154 of 1,167 batches never acknowledged; 1,152 of them were stored completely, 2 not at all; insert amplification 4.3× for the phase; `FINAL` exact |
| Revocation under load                  | Node revoked in PostgreSQL during a 20 batches/s run                             | Its requests returned `UNAUTHENTICATED` from 6.6 s later (24.1 s in the authority run); rejected batches absent                                       |
| Denied grant                           | Requests claiming an unenrolled resource                                         | 1,455 `PERMISSION_DENIED`; nothing published                                                                                                          |
| Overload                               | 1,000 offered batches/s against admission 1                                      | 2,088 batches given up after 6 attempts and 50,257 skipped by the client; none stored                                                                 |
| k6 ramp without retries                | 50 → 200 requests/s                                                              | 11,508 acknowledged batches complete; 6,506 `UNAVAILABLE` batches absent                                                                              |

After the soak, the main allocation's 5,537,773 expected samples matched
5,537,773 `FINAL` rows; 5,744,369 rows had been inserted, an insert
amplification of 1.037, and merges had removed every physical copy by then. The
headroom allocation matched 3,935,451 samples, the structural allocation 852,027
and the authority allocation 115,520, all without duplicates.

The verifier computes every expected identity from the batch records and
compares, per source, the count, sum and XOR of the first 8 bytes of each stored
distinct sample ID. It also compares the `FINAL` row count and checks that
physical copies of a sample are identical. On a mismatch, it lists the missing
and unexpected IDs with their batches. It checks one source per query, with a
256 MiB memory limit: a global `GROUP BY sample_id` over four million IDs
exceeded the shared server's memory limit during the campaign.

## Capacity

### Shipped admission

| Offered batches/s | Acknowledged samples/s | First attempt p50 / p99 (ms) | Acknowledged p50 / p95 / p99 (ms) | Given up | Queryable p50 / p95 (s) | Peak raw / normalized lag |
| ----------------: | ---------------------: | ---------------------------: | --------------------------------: | -------: | ----------------------: | ------------------------: |
|                10 |                    462 |                     7.3 / 36 |                     9 / 151 / 205 |        0 |               3.2 / 5.1 |                30 / 2,212 |
|                25 |                  1,116 |                     6.9 / 49 |                     9 / 211 / 572 |        0 |               2.5 / 4.5 |                40 / 3,043 |
|                50 |                  2,313 |                     6.7 / 44 |                   9 / 830 / 2,347 |       15 |               2.3 / 4.3 |                65 / 8,133 |
|               100 |                  4,356 |                     6.7 / 53 |               161 / 2,644 / 4,904 |      318 |               2.2 / 3.9 |               139 / 7,606 |
|               150 |                  5,790 |                     6.7 / 58 |               351 / 4,371 / 5,130 |    1,495 |               2.3 / 4.8 |               175 / 8,776 |
|             1,000 |                  5,961 |                     6.9 / 81 |               178 / 4,366 / 5,136 |    2,088 |               2.5 / 5.7 |              228 / 15,494 |

At 150 batches/s, 23,000 `UNAVAILABLE` responses accompanied 7,600
acknowledgements. The ingestion API used 13 MiB and 9–11% of a CPU, the
normalizer 10 MiB and 5%.

### Headroom with eight admitted requests

| Offered batches/s | Acknowledged samples/s | Acknowledged p50 / p99 (ms) | Queryable p50 / p99 (s) | Peak raw / normalized lag | Normalizer RSS / CPU | ClickHouse memory | Query p95 (ms) |
| ----------------: | ---------------------: | --------------------------: | ----------------------: | ------------------------: | -------------------: | ----------------: | -------------: |
|               100 |                  4,605 |                     8 / 135 |               1.8 / 4.3 |              198 / 15,669 |          12 MiB / 5% |           350 MiB |          25–57 |
|               200 |                  9,184 |                     8 / 470 |               4.3 / 7.9 |            1,103 / 18,005 |          17 MiB / 8% |           683 MiB |          35–65 |
|               400 |                 18,315 |                   8 / 1,163 |             47.2 / 82.0 |           13,546 / 25,619 |          63 MiB / 9% |           759 MiB |        198–353 |
|               800 |                 35,027 |                  10 / 4,257 |           120.7 / 298.6 |          35,157 / 627,154 |         112 MiB / 7% |           895 MiB |        538–980 |

The 100 and 200 batches/s rows come from the original run, whose probes scanned
the table. The 400 and 800 batches/s rows were re-measured with the filtered
probe on a fresh allocation that ran only those two steps. During those steps,
the normalizer processed about 175 raw records/s (8,000 samples/s).

At 800 batches/s, the raw backlog drained 234 s after it peaked and the
normalized backlog reached 627,154 records. The normalized topic retained 295 MB
of its 384 MiB byte budget (3 × 128 MiB), so a longer run at this rate would
expire unconsumed records by size within minutes. The ClickHouse container
reached 231% CPU (two-CPU allocation) and Kafka 118%. New parts took 41 ms at
the median and 302 ms at p95 to write (`system.part_log`), with about 4,200
rows each. Concurrent read latency rose from tens of milliseconds to about a
second at p95, within the 6-second reader limit.

### Normalizer workers

The same 400 batches/s step with eight normalizer workers instead of two,
re-measured with the filtered probe, kept acknowledgements unchanged (8 ms p50,
869 ms p99) and raised normalizer throughput to about 290 raw records/s. Peak
raw backlog fell from 13,546 to 6,471 records, median time until queryable from
47.2 s to 11.0 s and concurrent read p95 to 53–161 ms. The normalizer still used
only 12% of a CPU and 32 MiB, so publication concurrency, not computation,
limits it. A single run on a shared host cannot separate normalizer concurrency
from broker capacity; Kafka reached 116% of its single-CPU allocation in this
run.

### k6 ramp

k6 sent one 16-point gauge per request without retries, ramping from 1 to 200
requests/s against admission 1. Acknowledged requests took 8 ms at the median
and 10 ms at p95; 6,506 requests (36%) received `UNAVAILABLE` immediately.

### Soak

For 25 minutes, 50 batches/s were offered to the main allocation, excluding the
revoked node, with 2 concurrent reads/s.

| Measure                         | Result                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| Acknowledged                    | 74,246 batches, 2,244 samples/s; 120 given up after 6 attempts |
| First attempt p50 / p99         | 6.9 / 36 ms                                                    |
| Acknowledged p50 / p95 / p99    | 9 / 554 / 2,096 ms                                             |
| Queryable p50 / p95 / p99 / max | 2.1 / 3.8 / 4.9 / 8.7 s                                        |
| Ingestion API / normalizer      | 12.3 / 9.6 MiB peak RSS, flat; 3.8% / 2.4% of a CPU            |
| ClickHouse                      | 5–13 active parts; about 320 MiB tracked memory, 729 MiB peak  |
| Peak lag raw / normalized       | 112 / 8,652 records, without growth                            |
| Concurrent reads p50 / p95      | 48–92 / 66–118 ms                                              |
| Credential lookups              | 2.04 per minute                                                |

The normalized topic reached its byte retention during the soak and deleted
consumed segments. Verification afterwards matched all 5,537,773 samples of the
allocation.

### Maximum-size requests

A separate allocation with 12 raw and normalized partitions received one request
per second for 60 s. Each request carried 16,384 points (64 gauges × 256 points,
160 bytes of attribute padding per point), 4.04 MB of the 4 MiB request limit.

| Measure                    | Result                                                     |
| -------------------------- | ---------------------------------------------------------- |
| Acknowledged               | 52 of 52, 14,364 samples/s                                 |
| Acknowledged p50 / p99     | 58 / 354 ms                                                |
| Queryable p50 / p95        | 5.8 / 20.0 s; normalized lag peaked at 62,004 records      |
| Ingestion API / normalizer | 139 / 145 MiB peak RSS                                     |
| ClickHouse                 | 11 active parts; 724 MiB tracked memory; inserts 19 ms p50 |
| Verification               | 852,027 samples exact                                      |

Merges of this table needed 350–400 MB each in every run (`system.part_log`).
With four background merge threads and a 1.25 GiB server limit, concurrent
merges can exceed the limit: one merge failed with `MEMORY_LIMIT_EXCEEDED`
during the 800 batches/s step and was retried. No insert failed.

### Authority

A separate allocation enrolled 512 principals in 8 projects with 8 admitted
requests. The node-table scan counter in the disposable database counts every
credential or revocation lookup.

| Phase        | Rate          | Result                                                                       | Lookups per minute |
| ------------ | ------------- | ---------------------------------------------------------------------------- | -----------------: |
| Accepted     | 200 batches/s | 24,189 acknowledged; 6.9 ms p50, 46 ms p99 first attempt                     |               2.50 |
| Denied grant | 200 batches/s | 24,056 `PERMISSION_DENIED` in 0.56 ms p50, 0.96 ms p99, without publication  |               1.99 |
| Revoked node | 20 batches/s  | Accepted until the next poll; `UNAUTHENTICATED` from 24.1 s after the update |               1.27 |

The main allocation recorded 1.8–3.0 lookups per minute from 10 to 1,000
offered requests/s. Signature and claim checks are in memory. The
one-connection pool serves only the 30-second revocation poll, so request
concurrency cannot contend for it, and normalizers read no PostgreSQL state.
Because the denied path takes under 1 ms, Kafka's `acks=all` publication
accounts for most of the 7 ms acknowledgement.

## Deduplication window

Sample IDs are deterministic, so a retried or replayed sample always produces
the same `(project, source, resource, metric, time, sample_id)` key in the same
event-day partition. Deduplication happens at these layers:

| Layer                                  | Scope                                       | Window                                                                                     |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Kafka producer idempotence             | Retries of one producer session             | One producer session; does not cover new requests or replays                               |
| `optimize_on_insert`                   | Copies inside one Kafka-engine insert block | One block: up to 4,096 rows or the 2-second flush; resends within it left no physical copy |
| ClickHouse insert-block hashes         | Identical blocks                            | None: `non_replicated_deduplication_window=0`, and Kafka-engine blocks differ between runs |
| Background `ReplacingMergeTree` merges | Copies in parts of one partition            | Eventual and unscheduled; a partition is not guaranteed to reach one part                  |
| `FINAL` or identity grouping           | Every copy with the same sorting key        | Unlimited while rows exist; no TTL is configured                                           |

The supported deduplication window is therefore the logical one: any number of
identical copies of a sample, at any time, return one row through `FINAL`. The
web readers use `FINAL` for this. Physical copies count against storage and
merge work: the Toxiproxy phase stored 4.3 rows per sample. Changing a sample's
event time or content under the same ID is a protocol violation with undefined
results; see [sample identity](telemetry-point-contract.md#sample-identity-and-retry-rules).

## Durability, retention and failure limits

- **Acceptance** means the raw record reached the single broker's page cache
  with `acks=all` and one replica. Kafka does not flush each write to disk, so
  host or power loss can lose acknowledged records; broker disk loss loses the
  log.
- **Storage commits** follow inserts: ClickHouse writes and fsyncs each part
  (`fsync_after_insert`, `fsync_part_directory`) before committing Kafka
  offsets. A crash between them replays the records, as the rewind scenario
  reproduced.
- **Replay** is bounded by the smaller of 6 hours and 128 MiB per partition. At
  the measured 720 bytes per raw record and 46 samples per batch, 384 MiB of raw
  retention holds about 560,000 batches: 62 minutes at 150 batches/s. Normalized
  retention, at 92 bytes per point, holds about 4.4 million points: 8 minutes at
  9,000 samples/s. Expired input is skipped, not recovered.
- **Overload** returns `UNAVAILABLE` at admission without buffering, so
  memory stays flat. Retrying clients carry the backlog; the collector's disk
  queue bounds it.
- **Revocation** depends on PostgreSQL only through the 30-second poll; tokens
  are verified in memory. Readiness fails once the list is 5 minutes old.

## Remaining gaps

- **Single broker and single ClickHouse server.** Replicated-broker failover,
  `min.insync.replicas` enforcement and analytical-storage redundancy are
  untested. One-broker results are not high availability.
- **Ingestion-to-Kafka interruption.** Toxiproxy could not sit between the
  ingestion API and Kafka without reconfiguring the shared broker's advertised
  listener. The ingestion-crash and delayed-response scenarios cover lost
  acknowledgements instead.
- **Separate generator host.** The generator, k6, services and containers shared
  one host with other workloads. Latency percentiles include that contention.
- **Multi-hour soak.** The soak lasted 25 minutes. Retention expiry, merge
  backlog and memory growth over hours remain unmeasured.
- **Gateways with independent resources.** Node tokens grant only the node's own
  root and local resources; a gateway reporting independently enrolled
  resources has no grant path, so it was not measured.
- **Web server path.** Reads replayed the compiled statements without the web
  server, session checks or PostgreSQL access queries.
- **ClickHouse query and insert memory.** With `query_log` disabled, per-query
  memory is not recorded; server memory was sampled every 5 seconds.

## Reproduce

Use the [allocation settings](../tests/README.md#backend-settings-and-isolation)
and the [pipeline load check](../tests/README.md#pipeline-load-check), plus a
namespace and these machine-local settings in an ignored file:

| Setting                        | Purpose                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `RECOUNT_LOAD_BIN_DIR`         | Directory with release `recount-ingestion-api`, `recount-normalizer` and `recount-pipeline-load` |
| `RECOUNT_LOAD_CONTAINERS`      | Comma-separated container names for `docker stats` samples                                       |
| `RECOUNT_LOAD_KAFKA_CONTAINER` | Broker container for the read-only `kafka-log-dirs.sh` size report                               |

Build once, then run all phases or a selection; the run directory must be
absolute:

```sh
cargo build --locked --release -p recount-ingestion-api -p recount-normalizer -p recount-pipeline-load
tests/load/campaign.sh "$PWD/.state/load/campaign" prepare baseline step
bun --no-env-file tests/load/report.ts .state/load/campaign --json report.json
"$RECOUNT_LOAD_BIN_DIR/recount-pipeline-load" cleanup --run .state/load/campaign
```

The phases are `prepare`, `baseline`, `step`, `headroom`, `workers`, `k6`,
`overload`, `recovery`, `soak`, `structural` and `authority`. `headroom`,
`workers`, `structural` and `authority` create and remove their own
allocations under `<run>-<phase>`. If any command fails, the script stops its
background jobs and Toxiproxy, removes the current sub-allocation and stops the
main allocation's services. It keeps the main allocation for inspection; remove
it with the `cleanup` command above. `cleanup` refuses names outside the tool's
`recount_load_`, `recount_load_reader_`, `recount_load_ingestion_` and
`<namespace>.load.` prefixes. Requirements are k6, Toxiproxy, Bun and Python 3.
The tool lives in `tests/load` beside its k6 scripts; `recount-pipeline-load
--help` lists the individual commands for custom scenarios.
