# Workload collection evaluation

CPU computation, memory pressure, direct-write I/O and a two-node Slurm job use
the same Linux collector, execution-participant schema and execution pages.
The [saved evidence](evidence/workloads/2026-11-16/manifest.json) comes from the
existing lab and shared application stack, with no workload-specific product
code or schema.

## Workloads and resources

All payloads run for 60 seconds with seed `42`. Each guest has one virtual CPU,
1024 MiB configured RAM and approximately 815 MiB visible to Linux. The guests
run aarch64 Linux `7.0.0-22-generic`, Recount `0.1.0`, stress-ng `0.20.01`, fio
`3.41` and Slurm `25.11.2`. The deployed application and collectors use commit
`19f254f8151d6413c3db195dacc438216501ad27`.

| Category              | Payload                                                                  | Required resources                                         | Launch and attribution                                               |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| CPU-bound             | One stress-ng `sqrt` worker                                              | One CPU; no input dataset                                  | `recount run`; explicit execution key                                |
| Memory pressure       | One stress-ng `vm` worker, `write64`, 128 MiB, retained allocation       | At least 128 MiB available plus tool/collector overhead    | `recount run`; explicit execution key                                |
| I/O-bound             | fio synchronous sequential direct writes, 64 KiB blocks, one 64 MiB file | 64 MiB free disk space; filesystem support for direct I/O  | `recount run`; explicit execution key                                |
| Distributed placement | One stress-ng `sqrt` worker on each of two Slurm nodes                   | Two idle one-CPU nodes; 192 MiB Slurm reservation per node | `srun -N2 -n2 --ntasks-per-node=1 --mpi=none`; shared `SLURM_JOB_ID` |

The I/O case reuses the existing
[sequential-write profile](../infra/lab/ansible/files/sequential-write.fio).
The memory case adds a fixed method rather than cycling through stress-ng's
default methods. Every stress-ng launch also uses `--keep-name` so worker process
renaming does not overwrite the environment labels visible through `/proc`.
Seeds are explicit even where the selected method does not need random input.
There is no external dataset.

The two-node case verifies scheduler placement and common execution attribution,
not MPI communication or scaling. MPI is not installed in these guests; no
packages or scheduler settings were changed. One task per node avoids
oversubscribing the one-CPU guests.

## Observed behavior

The machine-readable manifest contains sampled CPU-time and I/O counter deltas,
peak summed process RSS per node, point counts, membership counts and execution
keys. Tool output provides an independent workload result, not a replacement
for collector evidence.

The final run ID is `workload-20261116-0934`. Its standalone execution keys are
`run:workload-20261116-0934-cpu`, `run:workload-20261116-0934-memory` and
`run:workload-20261116-0934-io`; the distributed execution is `slurm:13`.

| Category              | Expected behavior                                                                   | Observed through Recount                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CPU-bound             | Approximately one busy CPU, small RSS, negligible disk I/O                          | 56.71 CPU-seconds over a 58.00-second sample span, about 98% of one CPU; 18.1 MiB peak summed RSS; zero read/write-byte delta            |
| Memory pressure       | Resident allocation substantially above the CPU case; CPU work from repeated writes | 130.3 MiB peak summed RSS versus 18.1 MiB for CPU; 56.86 CPU-seconds; zero read/write-byte delta                                         |
| I/O-bound             | Increasing writes, negligible reads, less CPU saturation than computation           | 78.46 GiB sampled writes, zero reads; 16.10 CPU-seconds over 58.00 seconds; 33.6 MiB peak summed RSS                                     |
| Distributed placement | Both nodes contribute CPU measurements under one scheduler key                      | `slurm:13`: two nodes, two participants and six process memberships; node1 56.83 and node2 57.03 CPU-seconds; zero read/write-byte delta |

All five payload runs reported exit status zero. The final evidence contains
7,552 associated points and 16 process memberships, all with collector scope
version `0.1.0`. Both nodes' collector and launcher binary hashes match in
`preflight.json`. Every execution was opened through the same existing listing
and detail UI: standalone pages show `RECOUNT_EXECUTION`, while the two-node page
shows `SLURM_JOB_ID` and two participants.

Collector counter spans are approximately 58 seconds of each 60-second tool
run. stress-ng independently reports 58.66 CPU-seconds for CPU, 58.84 for memory
and 58.78/59.00 for the distributed tasks. fio reports 87,214,325,760 written
bytes over 60.002 seconds, versus 84,242,923,520 bytes in the collector's sampled
delta. These differences are consistent with omitted counter edges; sampled
deltas are not full tool totals.

### Worker environment retention

The [first pass](evidence/workloads/2026-11-16-default-names/manifest.json), with
stress-ng's default process naming, completed successfully but did **not** capture
its busy workers as execution members. CPU/memory executions contained only two
idle wrapper/parent processes each: sampled CPU deltas were zero and the memory
case peaked at only 17.3 MiB summed RSS, despite the tool reporting a 128 MiB
worker allocation. Both Slurm participants also lacked their busy CPU workers.
fio retained worker labels and produced associated I/O measurements.

stress-ng's
[`stress_proc_name_raw_set`](https://github.com/ColinIanKing/stress-ng/blob/V0.20.01/core-helper.c)
calls `setproctitle` unless `--keep-name` is selected. The saved first-pass
commands omit that flag; the final scripts include it. This is a workload launch
requirement, not an ancestry fallback or collector modification. Environment
discovery cannot attribute workers whose readable environment no longer
contains labels.

## Repeat the experiment

Use the existing [lab](../infra/lab/README.md#existing-local-state) and running
application stack. Both collectors must have execution discovery enabled and
must be enrolled in the same project. Install stress-ng, fio, Slurm and the
Recount launcher beforehand; these scripts do not provision anything.

1. In ignored local settings, export `RECOUNT_LAB_CHECKOUT` to the checkout from
   which existing lab commands work, and `VAGRANT_DOTFILE_PATH` to its existing
   Vagrant metadata. Match VM identities before running commands. If either VM
   is suspended, resume it explicitly with `just lab vagrant resume
--no-provision` from that checkout. Stop on a resume error; do not use `up`,
   recreate a VM or change metadata.
2. Run from the worktree holding the workload scripts:

   ```sh
   python3 infra/lab/workloads/run.py workload-YYYYMMDD-HHMM \
     --seconds 60 --seed 42 --output infra/lab/.state/results/labelled-workloads
   ```

   Choose a fresh run ID and output directory; duration accepts 30–120 seconds.
   Execution keys are
   `run:<run-id>-cpu`, `run:<run-id>-memory`, `run:<run-id>-io` and the allocated
   `slurm:<job-id>`. Reusing a key joins the old execution rather than creating a
   separate run. Guest directories also refuse reuse.

3. After collectors publish the closed participant facts, export the evidence.
   Set `RECOUNT_CLICKHOUSE_CONTAINER` to the existing ClickHouse container name:

   ```sh
   python3 infra/lab/workloads/export.py infra/lab/.state/results/labelled-workloads \
     --project "$RECOUNT_PROJECT_ID" --deployed-commit "$RECOUNT_DEPLOYED_COMMIT"
   ```

   This performs read-only queries. It does not create tables, topics, databases
   or consumer groups, or change offsets. If facts are still open, retry the
   export after collection catches up; do not rerun the payload with the same
   execution key.

4. Sign in to the same project in an isolated `agent-browser` session. Set
   `RECOUNT_PROJECT_URL` to the project's URL and keep browser authentication
   state outside committed evidence. With the UI in English:

   ```sh
   python3 infra/lab/workloads/capture-ui.py infra/lab/.state/results/labelled-workloads \
     --session workload-evidence
   ```

   The script checks each execution's listing link, key, node count, participant
   count and matched environment variable. Run the exporter again afterward to
   include UI files in the checksum manifest.

The runner executes lab commands with `cwd=RECOUNT_LAB_CHECKOUT`, but reads its
payloads and saves results in the invoking worktree. It refuses stopped VMs and
never resumes, provisions, stops or destroys them. The scheduler allocation has
a three-minute limit and a 30-second immediate-allocation timeout. Standalone
tools have bounded runtimes. Guest scripts and small result files remain under
their unique `/var/tmp/recount-workloads-<run-id>-<category>` directories for
inspection; fio unlinks its own data file on successful completion. No shared
state is cleaned up.

## Evidence format and calculations

The committed evidence directory contains:

| Path                                                             | Contents                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `launches.json`                                                  | Exact launcher/scheduler argument arrays and task output                                                  |
| `preflight.json`                                                 | Collector service and scheduler state; final-pass collector/launcher binary hashes on both nodes          |
| `<category>/<node>/run.json`                                     | Seed, duration, exact payload command, tool versions, guest capacity, wall-clock bounds and exit result   |
| `<category>/<node>/tool-result.yaml.gz` or `tool-result.json.gz` | Losslessly gzip-compressed stress-ng YAML or fio JSON                                                     |
| `<category>/participants.jsonl`                                  | Latest participant facts from a project/key-qualified `FINAL` read                                        |
| `<category>/points.jsonl.gz`                                     | Gzip-compressed JSON Lines of execution-associated process points                                         |
| `<category>/ui.json`, `ui-listing.json`                          | Rendered English execution-page text, paths and machine-readable timestamps; no session cookies           |
| `manifest.json`                                                  | Project, deployed commit, expected behavior, derived measurements and SHA-256 checksums of evidence files |

JSON Lines use one object per line. ClickHouse UInt64 values may be JSON strings.
Point records retain sample IDs as hex, series IDs, source/resource identities,
timestamps, values, counter temporality, scope version and point attributes.
The [export SQL](../infra/lab/workloads/points.sql) selects process points by
node/resource identity and observed membership interval, using an existence test
so overlapping memberships cannot multiply measurements. Node-wide values are
not attributed to an execution.

CPU and I/O results sum `last - first` for each series and counter segment,
separating I/O directions. Initial cumulative values are excluded; counter
decreases fail the export. These are sampled-window deltas, not full-lifetime
totals. Peak RSS sums associated processes at each node's scan timestamp, then
takes that node's maximum. Summed RSS can count shared pages more than once; it
is not unique physical-memory consumption. Counter spans report the earliest
and latest associated counter samples, not continuous coverage.

The exporter also accepts `--offline` to recompute the manifest from saved facts
and compressed points without connecting to ClickHouse. Keep the same project
and deployed-commit arguments. Format generated JSON with the repository's
Biome configuration before publishing, then regenerate checksums and format
`manifest.json`; the manifest excludes itself from its checksum map.

To check the summarizer without a running lab:

```sh
python3 -m unittest discover -s infra/lab/workloads -p 'test_*.py' -v
```

## Limits and workload-source choice

- These are resource generators, not representative application performance
  scores. One run per category demonstrates generic collection, not statistical
  repeatability or a regression threshold.
- A 128 MiB write loop demonstrates resident-memory pressure and CPU work. It
  does not establish that memory bandwidth is the limiting resource.
- Direct I/O bypasses the guest page cache, not necessarily VirtualBox or host
  storage caches. The two guests share a physical host and backing storage.
- Discovery can miss short-lived processes and the beginning/end of counters.
  Tool exit results are external evidence; collector disappearance is not an
  exit status. See the [participant contract](execution-participants.md).
- The results here were calculated from the stored process points directly.
  The execution page charts the same points: CPU, memory and disk I/O of the
  member processes by node, described in
  [execution telemetry](execution-telemetry.md#execution-detail-page).
- [SeBS](https://github.com/spcl/serverless-benchmarks) supplies FaaS applications,
  automatic deployment and measurement, including a Docker-based local backend.
  It is useful for a later serverless study, but would add a platform/deployment
  layer to this bounded VM resource comparison.
- [TaPS](https://github.com/proxystore/taps) supplies real and synthetic scientific
  task applications with executors such as Dask, Parsl, Ray and Globus Compute.
  It is a stronger candidate for later task/data-movement studies, but introduces
  executor/application dependencies unnecessary for these four collection cases.
  Both sources were evaluated from their upstream READMEs; neither was installed
  or benchmarked here.
