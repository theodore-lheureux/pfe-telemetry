# ClickHouse ingestion campaign, 2026-11-16

Raw results behind the [ClickHouse ingestion evaluation](../../../clickhouse-evaluation.md).
The campaign ran from 01:46 to 03:02 UTC on 2026-11-17 (the evening of
2026-11-16 local time). The headroom and normalizer-workers steps were
re-measured from 03:14 to 03:25 UTC with the filtered freshness probe. All runs
used commit `f64f408f0bc5` plus the uncommitted load tool, recorded as `+dirty`
in each allocation.

| Directory            | Allocation                                                                | Phases                                                                                   |
| -------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `main/`              | 64 principals in 4 projects, admission 1, 2 normalizer workers            | Baseline, steps, k6 ramp, overload, recovery and fault scenarios, authority denial, soak |
| `headroom/`          | As `main/`, admission 8; re-measured                                      | Steps at 400 and 800 batches/s                                                           |
| `headroom-original/` | The original headroom allocation, whose probes scanned the table          | Steps at 100 and 200 batches/s                                                           |
| `workers/`           | As `headroom/`, 8 normalizer workers; re-measured                         | 400 batches/s step                                                                       |
| `structural/`        | 5 principals, 12 partitions, admission 4                                  | Maximum-size requests                                                                    |
| `authority/`         | 512 principals in 8 projects, admission 8                                 | Accepted, denied and revoked requests                                                    |
| `check/`             | Three runs of `just --justfile tests/justfile load-check` after the fixes | Regression output                                                                        |

`commands.log` lists the campaign's commands in order and `commands-remeasure.log`
the re-measurement's, with the run directory shown as `$RUN`. Phase names in the
[campaign script](../../../../tests/load/campaign.sh) select the same sequence.

## Files

Each allocation directory holds:

- `allocation.public.json`: topics, groups, database names, settings,
  project IDs and node IDs, without credentials or the signing seed.
- `queries.json`: the web statements and settings replayed by k6.
- `report.json`: the per-phase summary from
  `bun --no-env-file tests/load/report.ts <run> --json report.json`, computed
  from the complete raw files before they were sampled.
- `normalizer.prom` and `logs/`: the normalizer's final metrics and non-empty
  service logs.
- `phases/<phase>/`:
  - `summary.json`: generator settings, host load, outcome and status counts,
    and acknowledgement, schedule-delay and freshness distributions.
  - `verify.json`: identity comparison, amplification, `system.part_log`
    summary, final lag and retained topic bytes.
  - `resources.jsonl.gz` and `drain.jsonl.gz`: complete 5-second samples of
    service RSS and CPU time, group lag, ClickHouse parts, merges and memory,
    container statistics and authority table scans, and the drain curve.
  - `batches.sample.jsonl.gz` and `k6-console.sample.log.gz`: deterministic
    samples of the per-batch records and k6 acknowledgement lines, described
    below.
  - `drain.json`, `k6-summary.json`, `k6-queries.json` and `revoke.log`, where
    the phase has them.

Verification is cumulative over its allocation. `main/phases/step-150/verify.json`
and earlier files came from the first verifier, which grouped all identities in
one query. That query exceeded ClickHouse's memory limit on the original
headroom allocation; every later file came from the per-source verifier.

## Trimmed raw records

The complete per-batch records were 100 MB uncompressed. To keep the evidence
near 1 MB, each `batches.jsonl` keeps lines 1–200 plus every 1,000th line, and
each k6 console log keeps lines 1–200 plus every 100th line
(`awk 'NR<=200 || NR%N==0'`). The summaries, verifications and reports were
computed from the complete files. Running the
[campaign script](../../../../tests/load/campaign.sh) with the same phases
regenerates complete raw records; the seeded arrivals repeat, but timings and
host contention differ.

## Excluded attempts

A first campaign was stopped after five minutes: its fixed-interval arrivals
and unjittered retry backoff collided deterministically with the single
admission slot. A first authority attempt stopped before sending because its
allocation had no Linux node for the query catalog. Both allocations were
removed; their results are not included. The original 400 and 800 batches/s
headroom steps and workers step were replaced by the re-measurement.
