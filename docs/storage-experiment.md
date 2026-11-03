# Concurrent ingestion and historical queries

The tested storage boundary supports concurrent ingestion and historical queries at the offered load: one Rust worker publishes immutable Parquet files while independent DuckDB processes read completed files. Keep DuckDB as the analytical query candidate, Kafka as the retained ingestion log and the worker as the sole owner of historical publication. The experiment establishes feasibility at this scale, not maximum capacity or a production latency guarantee.

## Experiment

The [repeatable experiment](../tests/storage/README.md) exercises the existing OTLP ingestion service, Kafka, storage worker and DuckDB views. It uses generated standard OTLP metrics without depending on the collector's full external profile. The first investigation is limited to two focused working days, including recovery checks and documentation.

Each measured scenario starts with 96,000 historical points in 500 batches, spanning eight hosts and eight processes per host. Three metrics per process cover integer cumulative counters and a memory gauge. A write phase submits another 28,800 points in 150 batches, paced at ten batches per second. Measurement timestamps cover a fixed historical interval; submission timestamps are current. The generated values support exact result assertions rather than physical workload modelling.

Three repetitions compare one reader without writes, writes without readers, writes with one reader and writes with four readers. Readers reuse DuckDB processes and cycle through fixed-history aggregations, filtered rate calculations and visibility probes. The historical results must stay unchanged while new files appear. Complete-set checks validate identities and values, not only row counts.

The environment is Linux aarch64 under OrbStack on an Apple M4 with 16 GiB host RAM. Docker has ten CPUs and approximately 3.89 GiB RAM. The existing local pipeline and monitoring services remain active, so these are shared-host observations. Each ingestion and storage container is limited to one CPU and 512 MiB; Kafka has one CPU and 768 MiB. Each reader has one CPU and 256 MiB, with DuckDB limited to one thread, 128 MB memory and 24 MB temporary space. The immutable image references and SQL settings come from the [Compose configuration](../infra/telemetry/compose.yaml).

## Results

The measured run completed on **2026-11-03, 02:19:24–02:28:48 UTC**, using DuckDB **1.5.6**, Kafka **4.3.1** and the server built from baseline commit `08a9140c42e3abcef65d6b9a097c8d6719a4f1f1` plus the experiment files in this change. The [evidence directory](../tests/storage/results/2026-11-03/) preserves compressed raw events, query stderr, the per-repetition summary and a manifest of commands and source hashes.

All 12 scenarios passed. There were **3,626 successful query attempts**, including 2,729 historical queries with exact result assertions and 897 freshness probes. Every write scenario accepted all 150 offered batches and subsequently contained exactly 124,800 unique expected points. Historical results remained unchanged during ingestion, and existing reader processes observed newly published files without reopening their connections. Kafka lag was zero at each end-of-scenario checkpoint.

The following p95 values pool raw samples across the three repetitions; they are not averages of per-run percentiles. Durations are milliseconds. The summary retains p50, p95, p99, maxima and sample counts separately for each repetition.

| Scenario              | Accepted points/s, observed range | OTLP acknowledgement p95 | Historical range p95 | Aggregate p95 | Counter rate p95 |
| --------------------- | --------------------------------- | ------------------------ | -------------------- | ------------- | ---------------- |
| One reader, no writes | —                                 | —                        | 60.1                 | 54.6          | 145.5            |
| Writes, no readers    | 1,919.5–1,919.9                   | 12.4                     | —                    | —             | —                |
| Writes, one reader    | 1,919.5–1,920.3                   | 10.4                     | 71.1                 | 71.2          | 170.2            |
| Writes, four readers  | 1,919.9–1,920.2                   | 32.7                     | 85.7                 | 81.1          | 217.5            |

The paced load held approximately 1,920 points/s in all write scenarios. Four readers increased the acknowledgement tail and historical query latency, but did not prevent acceptance or eventual publication. The lower acknowledgement p95 with one reader than with no readers should be treated as shared-host run variability, not evidence that querying improves ingestion. Compared with the read-only baseline, concurrent-write scenarios also accumulate 150 extra files, so the query difference combines write contention and a growing file set.

For sampled latest batches, acknowledgement-to-observation p95 ranged from **138–153 ms** with one reader and **144–153 ms** with four. The largest sampled observation was 179 ms. These probes observed 159 distinct live batches across the three single-reader runs and 246 across the four-reader runs. They are sparse observations of the latest visible batch, not per-point ingestion latency percentiles or a worst-case freshness bound. They also compare host and guest wall clocks; clock uncertainty is not independently calibrated.

### Resources and file growth

The table gives the largest sampled Docker memory usage across all repetitions of each mode. Docker's memory accounting is not an exact process RSS measurement.

| Scenario              | Ingestion MiB | Kafka MiB | Storage worker MiB | Per-reader MiB |
| --------------------- | ------------- | --------- | ------------------ | -------------- |
| One reader, no writes | 3.0           | 315.9     | 3.5                | 118.7          |
| Writes, no readers    | 2.9           | 390.0     | 4.7                | —              |
| Writes, one reader    | 3.8           | 315.1     | 4.4                | 142.4          |
| Writes, four readers  | 5.2           | 315.4     | 5.2                | 140.8          |

Historical readers consumed approximately one CPU each; sampled peaks ranged up to 111% of one CPU despite the one-CPU quota. Treat these as sampled CPU ratios, not sustained quota exceedance. During four-reader phases, ingestion and storage peaks were 2.6% and 3.1%, respectively; Kafka peaked at 12.0%. The isolated write-only cases included a Kafka peak of 102%. Resource snapshots are periodic samples and can miss transient peaks.

The historical directory occupied 8,000 KiB for 500 files, 10,400 KiB for 650 files, and 12,800 KiB after recovery with 800 files. Each file holds only 192 points. Storage block-write counters reached about 16 MB during the normal write scenarios, including preloading. Readers reported 0–19.6 MB of block reads and no block writes; cache hits mean these counters do not measure total logical bytes scanned.

Small-file overhead and per-reader CPU are the main scaling concerns to investigate next. This run does not isolate file metadata cost from Parquet scanning or demonstrate a file-count ceiling. The 15-second phases and sub-million-point individual datasets do not establish long-retention performance, cold-cache behavior or saturation throughput.

### Restart and replay

| Check                                                    | Observed result                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A second storage writer opens the same directory         | Rejected with `Another storage worker owns this directory`.                                                   |
| Stop storage and accept 50 further batches               | Acceptance continues; historical count stays at 124,800 points and Kafka lag rises to 50 batches.             |
| Resume storage                                           | All 50 batches become queryable within 2.38 s of issuing start.                                               |
| Kill the worker during another 100-batch submission      | All submissions succeed. Full-set validation passes about 46 s after the kill command.                        |
| Restart ingestion, Kafka and storage with intact volumes | All 153,600 expected points remain queryable with no duplicate identities or invalid values.                  |
| Replay all 800 batches with a new consumer group         | Consumer lag reaches zero; historical storage still has exactly 800 files and 153,600 unique expected points. |

The roughly 46-second crash recovery is materially longer than orderly resume. It includes consumer-group recovery and catch-up; this experiment does not isolate each component of that delay. A future freshness or outage target must account for group recovery, not only Parquet write speed. The full replay reached zero lag within the first group inspection, approximately 7.4 s after the replay launch command; that is an observation bound, not a precisely sampled replay throughput.

The experiment image also passed the generator validation test and all five existing storage tests on Linux. The runner stopped and removed its containers; the experiment volumes remain available for inspection.

## Write ownership and reader consistency

[`Store::open`](../apps/server/src/storage.rs) takes an exclusive directory writer lock. One worker may publish into that directory. Adding a Kafka consumer group does not grant another writer ownership of the same directory; replay must run after the original worker releases the lock.

Publication writes a hidden temporary file, synchronizes its contents, renames it to its stable batch-derived filename and synchronizes the directory. Only then does the worker queue the Kafka offset commit. DuckDB reads `*.parquet` through a read-only mount, so incomplete `.tmp` files are outside the query's file set. Existing final files are immutable. Replay checks the stored identity and content digest before treating an existing file as already published.

This boundary avoids sharing a writable DuckDB database file between the worker and the web application. Embedded DuckDB permits concurrent read/write threads inside one owning process, but independent processes cannot simply open the same native file for simultaneous embedded writes and reads. The distinction is between an embedded file and a coordinated service, not a prohibition on all DuckDB concurrency. [DuckDB concurrency](https://duckdb.org/docs/2.0/connect/concurrency.html)

A query binds a set of published files; separate statements can observe different sets as ingestion progresses. A report requiring a common snapshot across several statements would need a pinned file manifest or another transactional snapshot mechanism. Compaction and deletion would also need coordinated reader lifetimes before replacing the append-only directory model. Browser queries still require project authorization in server-side application code.

## Recovery boundary

Acceptance means Kafka publication succeeded, not that historical queries can already see the samples. The collector may continue submitting while the worker is stopped, within broker retention and capacity. Recovery needs enough remaining retention and processing capacity to drain the backlog.

The experiment checks orderly worker suspension, worker `SIGKILL` during ingestion, restart of the ingestion service, broker and worker with intact volumes, and full replay using a new consumer group. Full replay exercises already-published files with no consumer checkpoint. The timed crash does not establish exactly where execution stopped between file synchronization, rename and offset commit. Existing Linux storage tests separately cover abandoned temporary files, conflicting batches and reopening the store.

These checks establish process-restart behavior on the tested local filesystem. They do not establish survival of disk loss, host power failure, replicated failover or network-filesystem locking. The local Kafka deployment has one replica, a six-hour retention setting and a 128 MiB per-partition retention target; size-based expiry can shorten the replay window. Historical files have independent lifetime and no automatic expiry. See [ingestion and reliability](ingestion-and-reliability.md) for the acceptance and retention boundaries.

Existing-file replay compares stored metadata with the retained payload's identity and digest. It is not a full-file checksum scan or a repair mechanism for arbitrary disk corruption.

## Proposed storage approach and alternatives

Keep one storage worker as the owner of immutable Parquet publication and retain DuckDB as the candidate query engine. Broker offsets and file identities provide separate ingestion recovery and historical deduplication. Web processes should access authorized query results or read published files through a controlled query layer, rather than sharing the worker's writable database file.

The next design choice depends on the measured limit:

| Observed constraint                                                                    | Proposed response                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata scans and many small files dominate query time                                | Batch publication or compact into larger, time/project-partitioned Parquet files. Preserve batch deduplication and atomic manifest publication across compaction.                                           |
| Independent readers exhaust CPU or memory                                              | Use a bounded query service with admission limits and explicit resource budgets. This makes concurrency controllable without changing the historical format.                                                |
| Native DuckDB tables are preferable to a file-based boundary                           | Give one service ownership of the embedded database and send both writes and queries through it. DuckDB 2.0 also offers the Quack client-server protocol; evaluate it separately against the same workload. |
| Multiple writers and transactional table snapshots are required                        | Evaluate DuckLake with a shared PostgreSQL catalog, including catalog operations, compaction and recovery.                                                                                                  |
| Sustained analytical ingestion or concurrent query demand exceeds a single-host design | Compare a server-oriented analytical store such as ClickHouse using the same identities, retention requirements and measurement procedure.                                                                  |

Quack and DuckLake change the coordination model and require their own measurements; they are alternatives rather than results of this experiment. [DuckDB server and DuckLake concurrency](https://duckdb.org/docs/2.0/connect/concurrency.html#multiple-processes)
