# Kafka retention and recovery

Kafka recovery is bounded by the first limit reached on each partition: retained
age, retained bytes, or available broker disk. Uncommitted records are not pinned.
The checked-in six-hour/128 MiB-per-partition limits are development controls,
not a supported outage duration. **24 hours is a candidate, not an approved
guarantee.** No aggregate collector load or supported outage window has been
agreed yet.

One broker with replication factor one supports process restarts while its disk
survives. It does not protect against broker disk loss, node loss, corruption or
disk exhaustion. `acks=all` and producer idempotence do not add a second replica
or deduplicate fresh application resends.

## Replay metric data after a hard VM crash

The metric point, series and delivery tables sync part directories but do not
sync data files on every insert. After a hard VM crash, ClickHouse can lose
recent writes even if Kafka has committed the corresponding offsets. An
ordinary graceful restart does not require a rewind.

1. On the recovered VM, pause the normalized and late metric consumers. Wait
   until their groups (`recount-clickhouse` and `recount-clickhouse-late` by
   default) are inactive. Save current offsets and check the retained ranges
   for both topics. Do not reset the raw normalizer or participant groups.
2. For each affected partition, plan to replay roughly one minute of Kafka
   record time before the last committed position at the crash. If using a
   timestamp-based reset, dry-run first and check every proposed offset against
   the saved checkpoint: never advance a lagging partition. Widen the replay
   window if observed loss or clock uncertainty requires it. Use the retained
   earliest offset if the target has expired, and report the gap.
3. Apply the verified reset to the two metric consumer groups only, read back
   the committed offsets, and resume consumption. Verify catch-up and affected
   measurement windows. `ReplacingMergeTree` deduplicates replayed points and
   deliveries; `AggregatingMergeTree` combines repeated series bounds. Dashboard
   reads use `FINAL` to deduplicate points before background merges finish.

This recovers only data still retained in Kafka. It does not recover a lost
Kafka disk or guarantee that a minute covers every crash.

When series caching is enabled, include at least one additional resend
interval in the replay window where retained offsets allow it. Points can
depend on metadata published earlier on the same output partition. Restart
normalizers to clear their local caches if series storage is lost or rebuilt;
do not rebuild just the series table from an arbitrary suffix of point-only
frames.

## Capacity budget

Local measurements supplied for this workload are approximately 12 MiB per
node-hour of raw log growth and 90 MiB per node-hour of normalized log growth:
**7.5× expansion**. For one node, a 24-hour outage alone requires 288 MiB raw and
2160 MiB normalized, or 2.39 GiB combined. This excludes catch-up traffic,
participants, live notifications, late records, indexes and free-space margin.
Participant traffic is new and low-volume after heartbeat throttling; it still
needs measurement, not a zero-byte assumption.

With three perfectly balanced partitions, the checked-in normalized byte target
holds approximately 4.27 node-hours across the topic. A single hot partition
holds approximately 1.42 node-hours. The raw equivalents are 32 and 10.67
node-hours, but the six-hour time limit still applies. More nodes divide these
windows by aggregate load; stable routing can produce skew.

Use measured **stored log bytes**, not decoded Protobuf sizes, for admission and
disk planning. For each topic and its hottest partition:

```text
time retention >= outage + catch-up + operational margin
partition byte retention >= hottest-partition bytes/hour × time retention × rate margin
catch-up hours = backlog bytes / (processing bytes/hour - incoming bytes/hour)
disk reservation >= sum(partitions × byte targets) + segments/indexes/internal topics + free reserve
```

Catch-up is impossible at a sustained processing rate at or below the incoming
rate. Raw normalizer lag and normalized/late ClickHouse lag are independent;
measure both stages while live input continues. A useful evaluation target is
24 hours outage + 6 hours catch-up + 6 hours operational margin, with another
25% byte-rate margin. This is a sizing hypothesis, not a measured service level.
For the supplied one-node rates, 36 hours needs at least 540 MiB raw and
4050 MiB normalized **on the hottest partition** after the 25% rate margin.
The late path needs the same normalized budget when historical uploads dominate.

For illustration, 36-hour retention with 1 GiB raw and 4 GiB each normalized/late
per partition reserves 27 GiB across those three topics at three partitions each.
Add participant/live targets (currently 384/128 MiB), Kafka overhead and at least
30% filesystem free space: about 40 GiB dedicated usable space before other
occupants. It is not a node-count capacity promise. Choose smaller, measured
budgets if the local disk cannot support this reservation; do not claim 24-hour
recovery from a larger time setting alone.

There are shared fixed partitions, not one partition per tenant or node.
Producers retain stable collector/node routing; do not resize topics underneath
running producers and consumers. Full HPC throughput and concurrent-query sizing
remain separate validation.

## Create and verify topics

`infra/local/compose.yaml` declares every topic's settings. Raw, normalized,
late, participant and live topics each have independent `RETENTION_MS`,
`RETENTION_BYTES`, `SEGMENT_BYTES` and `SEGMENT_MS` under
`RECOUNT_{RAW,NORMALIZED,LATE,PARTICIPANT,LIVE}_*`. Late partition count and
record size match normalized output. Participant partition count and record
size are independent. Defaults remain six hours/128 MiB for durable topics and
five minutes/16 MiB for best-effort live notifications.

Retention bytes apply **per partition**. Segment rolling and deletion checks
are asynchronous: active segments, deletion delay and indexes make byte targets
soft storage limits, not disk quotas. Segment size must fit a maximum record.
The broker message, replica fetch and request controls, normalizer consumer
fetch/receive budgets and generated ClickHouse transport settings must also fit
those records. See the [deployment settings](../infra/README.md#broker-and-native-consumer-settings).
Changing a generated transport cap requires a matching prepared schema bundle.

Create configured topics once, then verify them against the explicitly selected
Compose stack:

```sh
just local topics-create
just local topics-verify
```

Verification uses `DescribeConfigs --all` effective values, including inherited
broker defaults, and checks topology, replication, cleanup, compression, segment
and record limits. A matching value in a synonym is not a matching effective
setting. Verification never creates or repairs topics. Creation refuses existing
topics and applies the declared settings once. There is no in-place reconciliation,
migration or compatibility path.

For incompatible disposable local topics, stop their consumers and recreate only
the explicitly selected topics with the current schema and configuration. This
discards their contents. Never perform that cleanup automatically on startup or
extend its scope to unrelated topics, groups, tables or volumes. Shared-state
cleanup requires the owner's explicit authorization.

The 24-hour outage candidate, 36-hour retention example and approximately 40 GiB
reservation above are **production deployment choices**, not development defaults.
Select the admitted load and disk budget before creating deployment topics.

## Lag, retention headroom and disk

Kafka's own read-only tools report consumer lag, retained offsets and log sizes.
Run them in the broker container; none of them joins a group, commits or resets
offsets:

```sh
kafka=/opt/kafka/bin
docker exec recount-kafka-1 $kafka/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --all-groups
docker exec recount-kafka-1 $kafka/kafka-get-offsets.sh \
  --bootstrap-server localhost:9092 --time -2
docker exec recount-kafka-1 $kafka/kafka-log-dirs.sh \
  --bootstrap-server localhost:9092 --describe
```

`kafka-consumer-groups.sh` lists each durable group's committed offset, log end
offset and lag per partition: `recount-normalizer` on the raw topic,
`recount-clickhouse`, `recount-clickhouse-late` and
`recount-clickhouse-participants` on the normalized, late and participant
topics. The live reader is best-effort and has no group to check.
`kafka-get-offsets.sh --time -2` prints each partition's earliest retained
offset. A committed offset close to that earliest offset means the consumer is
about to lose unread records to retention; one below it already has a gap.
`kafka-log-dirs.sh` reports the bytes each partition occupies, to compare with
its `retention.bytes` and the disk. Negative headroom is possible while deletion
runs asynchronously, and record counts are not byte or time estimates.

The time guard asks Kafka for the first offset at
`now - retention.ms + warn-ms`; a lagging checkpoint before that offset warns.
It is an advisory timestamp-based signal, not an exact deletion deadline:
producer timestamps can be unordered, segment deletion uses segment timestamps,
and snapshots race concurrent writes/deletion. Choose a warning margin longer
than the inspection interval and required operator response. A snapshot with no
warning is not proof of a minimum remaining window. Broker log-directory bytes
exclude indexes and other filesystem occupants; the filesystem check includes
them.

The default warning margin is one hour. CLI inspection across five topics can
take more than a minute on the small broker; commands run sequentially to avoid
concurrent JVM memory pressure. Best-effort `-` readers omit the time guard.
For a durable topic whose entire retention is shorter than the warning margin,
any unread records are conservatively within the warning window.

Both the normalizer and ClickHouse deliberately use `auto.offset.reset=earliest`.
New groups start at retained earliest without an offset-seeding command.
Unavailable offsets are discarded, with a native warning, and consumption
continues from retained earliest. This is the active-development policy: the
remaining suffix is usable, but must not be described as complete recovery.
Invalid retained payloads and failed storage/publication still use their existing
error handling; retention expiry does not authorize skipping poison.

The normalizer turns the pinned librdkafka's error-driven `OFFSET` warning into
an explicit `event=retention_gap action=resume_earliest` warning with group,
partition/offset detail and the process-local counter
`recount_normalizer_retention_gaps_total`. Set
`RECOUNT_NORMALIZER_METRICS_FILE` (or `--metrics-file`) to atomically export that
counter in Prometheus text format. The parent directory must already exist and be
writable, with a separate output file for each process. A configured initial
export failure prevents startup; a later export failure warns without stopping
ingestion. The counter restarts at zero with the
process and counts reset notifications, not lost samples or unique incidents.
Fresh-group initialization is not counted as a gap.

The capacity command's JSON includes a numeric `retentionGap` gauge per partition.
Add `--format prometheus` for `recount_kafka_retention_gap`, lag, prefix distance,
log-byte headroom and disk gauges, plus a per-topic inspection-success gauge.
These snapshots cover every supplied group, including ClickHouse groups.
Short-lived gaps can disappear between inspections after a reset; keep the native
warnings and normalizer reset counter for event history. ClickHouse's own native
logs report its offset resets; `system.kafka_consumers` exposes assignments and
other consumption failures. No new monitoring service or telemetry table is added.

For an explicitly authorized one-off reset, stop only the affected consumer,
verify its Kafka group is inactive, reset that exact group/topic to retained
earliest, read back the offsets, then restart it. Kafka's reset CLI can report an
active-group error while exiting zero; never trust exit status alone. Do not
restart all of ClickHouse to stop one Kafka consumer, or interrupt participant
consumers and unrelated collectors.

Kafka retention is not ClickHouse duplicate correctness. Stable sample identity
and duplicate-safe queries remain necessary. Native insert-hash history is a
finite count-based retry aid, not a duration or the sole replay guarantee.

## Reproduce outage, catch-up and expiry

Reuse running Kafka and ClickHouse. Never restart backends or change existing
topics/offsets. These tests publish only current-schema fixtures in newly
allocated topic/group namespaces:

```sh
export RECOUNT_NORMALIZER_TEST_ALLOW_PUBLISH=1
export RECOUNT_NORMALIZER_TEST_NAMESPACE=recount.retention
export RECOUNT_NORMALIZER_TEST_BROKER=127.0.0.1:19092
cargo test --locked -p recount-normalizer --test kafka \
  continuous_backlog_advances_confirmed_prefix_beyond_active_slots \
  -- --ignored --exact --nocapture
cargo test --locked -p recount-normalizer --test kafka \
  natural_time_and_byte_expiry_warn_count_and_resume_the_suffix \
  -- --ignored --exact --nocapture
```

The first command allocates three raw/output partitions with a fresh group,
queues 120 valid raw records while the worker is absent, waits two seconds,
then starts the real normalizer. Every input checkpoint and expected sample
identity must complete. Its result prints payload bytes, outage duration and
checkpoint catch-up time; payload throughput is not stored-log throughput.
Topics remain under the printed unique allocation for read-only log-size
inspection with `kafka-log-dirs.sh`. Remove only those exact
owned topics after recording the result.

The expiry test independently exercises natural time and byte eviction with
short limits on its own new topics. It waits for earliest offset to advance,
publishes a readable suffix, and requires the real worker to warn about
`retention_gap`, increment the exported counter and consume/commit the suffix.
The time case also pauses only its own worker process before publication,
then resumes it after expiry and requires processing to continue without fail-stop.
Successful expiry cases delete only their own exact topic names. Failures leave
evidence. No test reduces broker-wide/shared-topic retention.

The existing native storage expiry test additionally verifies that ClickHouse
continues from a naturally expired normalized checkpoint into the retained suffix:

```sh
cargo test --locked -p recount-normalizer --test storage \
  worker_outage_catches_up_current_schema_points_without_offset_loss \
  -- --ignored --exact --nocapture
cargo test --locked -p recount-normalizer --test storage \
  naturally_expired_checkpoint_resumes_the_retained_suffix \
  -- --ignored --exact --nocapture
```

Supply the explicit storage endpoints, fixture executable and fresh allocation
permission from the [test guide](../tests/README.md).
The new-group and native expiry cases require ClickHouse running the current
`auto_offset_reset=earliest` configuration. Do not reload or restart a shared
ClickHouse instance just to satisfy that prerequisite.
These are accelerated small-fixture recovery checks, not a 24-hour soak or
steady-load fleet benchmark. Before approving a supported window, record
representative retained growth, partition skew, both stages' net drain rates,
participant/late traffic, free disk and continuing arrival load.

### Small-fixture measurements

The disposable outage/catch-up fixtures on 16 November 2026 reused running
backends without restarting them or modifying shared topics or offsets:

| Stage             | Queued input                                           | Consumer absent | Time to confirmed catch-up |
| ----------------- | ------------------------------------------------------ | --------------- | -------------------------- |
| Normalizer        | 120 raw records, 280,210 payload bytes → 1,800 samples | 3.02 s          | 3.48 s                     |
| Native ClickHouse | 512 distinct points, 478,720 payload bytes             | 5.21 s          | 1.81 s                     |

One measured capture retained 292,450 raw log bytes. Its historical points routed to late,
where the normalizer retained 263,185 compressed log bytes from 1,392,990 encoded
point bytes. The recent output topic remained empty as expected. The fixture's
compression/expansion differs from the supplied node-hour workload; do not
replace that measured 7.5× workload expansion with this synthetic ratio.
The native test confirms both physical/logical row counts and its committed
prefix. Startup, assignment and flush latency are included in catch-up time;
new arrivals were stopped during drain. These results support finite current-schema
catch-up, not a sustained fleet rate or a 24-hour
guarantee. The outage duration, admitted aggregate load and disk allocation
remain owner decisions.

## Chart coverage and Kafka lag

The web application estimates how far ingestion has progressed by reading the next uncommitted record in each lagging partition of the raw, recent normalized and late normalized topics. The watermark is the oldest receive time among those records, or the current time when all three consumer groups are caught up. The ingestion API sets the raw Kafka record timestamp to receive time. The normalizer copies it to `recount-raw-received-ms` on each output; packing stays within one raw delivery. The normalized Kafka timestamp stays at publication time so replay does not shorten retention.

Match the web application's Kafka topic and group settings to the deployed pipeline, including `RECOUNT_CLICKHOUSE_GROUP` and `RECOUNT_CLICKHOUSE_LATE_GROUP` when the schema bundle uses non-default group names. The web application caches the watermark for five seconds and falls back to the latest stored heartbeat bucket for the project if Kafka cannot supply it. Charts hatch buckets whose end plus the normal collector send delay (one default 1 s collection cycle plus 60 s default clock skew) is newer than the watermark. The default one-hour maximum submission age allows spool replay; it is not normal send delay.
