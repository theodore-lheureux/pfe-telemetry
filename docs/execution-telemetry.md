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

## Overlapping workloads

An execution page lists the project's other executions that ran on one of its
nodes at the same time. Each participant's interval runs from its first
observation to its explicit end, which is exclusive, or through its last
observation. Two executions overlap on a node when one participant of each was
active there at once, so a participant starting at another's explicit end does
not overlap it. ClickHouse reads the project's latest non-retracted facts once,
under the participant read limits above, and derives each execution's shared
nodes, metadata and overlap span from that read, earliest first. The span runs
from the first to the last moment of overlap on any shared node; overlap need not
be continuous within it. The list shows up to 20 executions, with a notice when
more overlap, and up to 20 shared nodes for each, with their collector hostnames
when the project still knows them.

The page also splits process CPU (`process.cpu.time` rate, roughly busy cores)
and resident memory (`recount.process.memory.rss`) on the execution's nodes,
while it was active, into three stacked shares:

| Share                          | Process points                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| This execution                 | Members of the execution when measured                              |
| Other executions               | Members of another of the project's executions, but not this one    |
| Processes without an execution | The project's processes that belonged to no execution when measured |

The split is an ordinary analytics query with execution filters, run through the
same compiler and limits as Explore. It covers one window for all the nodes, from
the execution's first observation on any node to its last on any node, in whole
buckets of the shortest interval giving at most 120, limited to the most recent
30 days. A node where the execution started later or ended earlier therefore
contributes load outside its own participation. Executions on more than 100
nodes report a capacity error instead of a split. A missing process metric shows
as unavailable rather than zero.

Memory is each process's average resident size in a bucket, summed per share.
When a process joins or leaves an execution within a bucket, its points fall in
two shares and both include it for that bucket, so the stacked total briefly
exceeds the node's actual use. Taking each share's last value instead would not
avoid this, since each share keeps its own last point; the average keeps each
share representative of the time the process belonged to it.

Overlap is context, not proof that one workload affected another. Both reads are
limited to the execution's project: executions and processes that other projects'
collectors report from the same host are neither listed nor counted.

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
