# Executions and participant telemetry

An execution is a project-scoped key claimed by collectors. The first participant
fact makes the key observable; later claims join it idempotently. Executions are
not pre-created in PostgreSQL, and users do not select source/time recordings.

The ingestion API validates each claim against the enrolled node's project and
host root, then publishes a final analytical participant record directly to
`recount.participants`. ClickHouse consumes that single topic into
`telemetry.execution_participants`. Metrics keep their independent normalizer
path. Points and `series_id` remain unchanged.

Project readers can list and open every execution in their project. Each server
operation authorizes canonical project access before reserving an analytics slot
and querying ClickHouse with a project predicate. Reads use the existing
SELECT-only telemetry client. There is no execution edit or create API.

## Execution reads

The reader uses `FINAL` to select the latest fact revisions before removing
retraction tombstones and grouping by execution key. It displays the earliest
active lifecycle's explicit metadata, ordered deterministically by first seen,
node and fact ID. Missing names fall back to the key. Corrections and retractions
may change the selected metadata. There is no separate metadata owner or
distributed completion status.

Lifecycle facts have no root process. Their metadata comes from the first
labelled process on a node during that participant's nonempty period.
Process memberships identify each labelled incarnation separately. Detail pages
show matched environment variable names and participant counts, not raw
environments, cgroup placement or inferred exit status.

Pages contain up to 50 keys in ascending key order, with a project-qualified key
cursor. A read returns at most 51 grouped rows and is bounded to 100,000 physical
rows, 256 MiB read/memory, one thread, six seconds of server execution and an
eight-MiB result. Limit, storage and cancellation failures are errors, not empty
or silently truncated pages. Internal RPC timestamps remain native `Date` values.

## Execution detail page

The timeline places each node's participant lifecycles and process memberships
on one time axis. An open interval ends at its last observation with a dashed
tail; it never extends to the current time. An execution is live while any fact
has no end, and its page then offers the shared manual and automatic refresh
control instead of streaming. Collectors do not yet report clock
synchronization, so the page marks it as unknown: times from different nodes
may be offset, and no offset is estimated or corrected.

Measurements chart CPU time (rate, in cores), resident memory (latest, in bytes)
and disk I/O (rate, in bytes per second) of the member processes, by node. Only
metrics the project has reported are shown. The server derives the range from
the execution's own facts: from the first observation to just past the latest
end or last observation, widened to whole buckets and limited to the latest 30
days. Each read checks project access first, then uses the analytics runner with
an `execution` filter, so lifecycle facts never attribute node-wide load.
Counter rates stay within one continuity segment, as in
[series and calculations](telemetry-semantic-model.md#series-and-calculations).

The `node` and `at` search parameters select a machine and an instant, so a
view can be shared. A selected node must belong to the execution. Clicking a
chart, moving the instant slider or selecting a timeline bar sets the instant;
the values table lists each measure per node in that bucket with its unit. A
missing value reads "No recorded value", with whether the node was offline,
online without data or unknown, and is never shown as zero. Each measure covers at
most the 50 machines with the largest values; the page says when others were left
out and lists them as not shown until one is selected.

## Running and validating

Provision `RECOUNT_PARTICIPANT_TOPIC` and `RECOUNT_PARTICIPANT_PARTITIONS` on a
fresh allocation. The schema exporter includes the participant proto and native
table/source/view. Explicit fresh ClickHouse offset initialization refuses
existing groups before seeding the metric, late-metric and participant consumers.
There is no participant worker, normalizer group or PostgreSQL service credential.
Never reset or recreate a shared backend to add this path.

Kafka acknowledgement means acceptance, not immediate queryability. Immutable
retries keep fact and revision identity. `ReplacingMergeTree(revision)` and
bounded `FINAL` reads make replay safe before background merges.

The [participant contract](execution-participants.md) defines bounded environment
reading, privacy, wire fields, membership intervals and provenance.
The launcher only validates labels, sets the environment and executes the command.
Collector discovery/export and workload query resolution remain separate integrations.
The [test reference](../tests/README.md) covers allocated native Kafka/ClickHouse
checks, authorized execution reads and the EN/FR metadata browser tests.
