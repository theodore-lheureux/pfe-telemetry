# Execution keys and participant facts

An execution is `(project_id, execution_key)`, derived from participant facts in ClickHouse. The first claim introduces the key; later claims join it idempotently. A key such as `run:2026-11-15-a` or `slurm:48213` needs no pre-registration or PostgreSQL execution record. Reusing a key intentionally joins the existing execution, even after every participant has ended.

Participant facts are separate from measurements. Neither OTLP points, analytical point columns, resource identities nor `series_id` gain an execution dimension. The [execution web model](execution-telemetry.md) uses project-scoped keys rather than source/interval recordings.

## Environment labels and privacy

The root collector reads `/proc/<pid>/environ` once per process incarnation (PID plus raw start ticks within the boot and process namespace). Bound the read to 65,536 bytes, using at most one extra byte to detect overflow. Unreadable, truncated, oversized or malformed input supplies no direct label; the verified-parent fallback below may still associate the process. Otherwise the decision is unknown, not a member. Cache the final decision for the incarnation; do not retry environment reads on later scans. Verify the incarnation around the read so PID reuse cannot transfer a label.

Extract only these explicit labels:

- `RECOUNT_EXECUTION`: execution key.
- Optional `RECOUNT_EXECUTION_NAME` and `RECOUNT_EXECUTION_VERSION`: execution metadata.
- Optional `RECOUNT_EXECUTION_PARAMETERS`: a JSON object of unique string keys and string values, subject to the parameter limits below. Reject duplicate keys, non-string values and invalid metadata.

An explicit key takes precedence over scheduler discovery. If an explicit label is present but invalid, the process is unlabelled; do not fall back to a scheduler or parent. This also applies to duplicate keys, invalid explicit metadata and malformed input containing an explicit key. Without it, configured scheduler variable names map to execution-key prefixes. The default mapping is `{"SLURM_JOB_ID": "slurm"}`, producing `slurm:<id>`. Operators may configure names such as `PBS_JOBID` or `LSB_JOBID`. Match configured names in bytewise order when several are present, and validate the complete resulting key without trimming or rewriting the value. An invalid selected value supplies no direct label. Explicit metadata is used only with `RECOUNT_EXECUTION`, not scheduler-derived keys.

Discard every other variable immediately. Never store, log or transmit the raw environment or discarded variable names or values, including in errors, durable state, queues and diagnostics. Retain only the validated execution key, explicit metadata and matched variable name. Temporary read buffers are not durable state.

The environment reflects labels supplied at exec; children normally inherit them. Programs that rename their process title can overwrite the memory backing `/proc/<pid>/environ`. When no valid direct label is readable and no invalid explicit label forbids fallback, discovery may inherit a parent's cached label, metadata and matched variable name. The parent must already be labelled and verified in the decision cache. Read its current PID and start ticks, require an exact cached incarnation with start ticks no later than the child's, and require known, equal kernel UIDs for the child, current parent and cached parent. Equal ticks are valid because start-time resolution can place a parent and child in the same tick. Recheck the child's incarnation and parent PID after the lookup. A PID alone is never sufficient.

Inheritance is part of the once-per-incarnation decision, not a later retry or ancestry search. New incarnations collected within a scan are decided in ascending start-tick order, independently of proc-directory enumeration order. A parent not yet labelled at the child's decision cannot supply a label later. The collector does not reread a cached incarnation after exec or an environment change, and cannot recover processes that start and disappear between scans or during downtime. There is no retrospective launcher evidence.

A local user labels only their own processes through the environment they supply. A shared key is attribution, not a web identity or proof of job ownership. The collector obtains process identity and UID from the kernel, not environment variables; a label cannot target another PID or grant cross-project access. Root remains a trusted collection boundary.

### Launcher

`recount run --execution <key> [--name <name>] [--version <version>] [--param k=v] -- cmd` validates inputs, sets these environment variables and replaces itself with `cmd` through Unix `exec()`. Parameters are serialized as a JSON object. Omitted name/version are removed and omitted parameters become `{}`, so a nested launch cannot inherit another execution's metadata. Unrelated environment variables and standard streams pass through unchanged.

There is no claim directory, local claim protocol, cgroup creation, collector handoff or helper process. Verified-parent inheritance belongs to collector discovery, not the launcher. Command exit status and signals pass through by construction; the launcher does not observe or report them.

## Identity and membership

| Identity    | Meaning                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node        | Enrolled node UUID; also the existing telemetry `source_id`. `host_id` is the token's host root, not a hostname.                                                                            |
| Process     | Enclosing boot ID plus `namespace_id`, positive PID and raw `start_time_ticks`; use the existing Linux process hash and `local_resource_id(project, host, PROCESS, incarnation)` unchanged. |
| Participant | Node-scoped UUID for one nonempty period of labelled processes sharing `(node, execution key, boot)`.                                                                                       |
| Fact        | Node-scoped UUID for one lifecycle or one labelled process incarnation. Each revision is a full replacement snapshot.                                                                       |

Emit one `PROCESS_MEMBERSHIP` per labelled process incarnation, open while the process is alive and ended when it disappears. It requires a process subject, a fresh fact UUID distinct from the participant ID and no execution metadata. All labelled processes count independently, including labels inherited through the environment or verified-parent fallback; no cgroup evidence is involved.

Emit one `PARTICIPANT_LIFECYCLE` per `(node, execution key, boot)` while at least one labelled process is alive. Its `fact_id` equals `participant_id`, and its subject is absent: there is no distinguished root process. It opens with the first labelled process and ends when the last disappears. Reappearance after closure creates a new participant. Metadata, provenance and optional owner UID come from the first labelled process and remain fixed; owner UID does not describe every process in the participant. Membership facts retain each process's matched variable and observed UID. No exit status is collected; unknown is not success.

Confirm initial lifecycle publication before uploading that participant's memberships. Ingestion does not require a synchronous parent lookup. Lifecycle facts never attribute node-wide measurements. Preserve identities across collector restart only with durable evidence; uncertain rediscovery gets fresh IDs rather than restarting an old revision sequence.

Provenance contains only origin `ENVIRONMENT` and `environment_variable`, the matched name (`RECOUNT_EXECUTION` or a configured scheduler variable). Verified-parent inheritance retains the parent's matched variable name; the wire provenance does not distinguish a direct read from inheritance. Each membership still records the child's observed UID. Local numeric `owner_uid` is kernel evidence, not a Better Auth owner. An unknown owner remains absent, never invented as UID 0.

Keep a global collector safety cap on tracked facts: skip new associations and log a bounded diagnostic when full, without logging environment contents or evicting live facts. Prune ended facts only after their final revision has been acknowledged and no queued retry depends on them. Keep the once-per-incarnation read decision while a process is alive, including unknown or cap-skipped processes.

## Collector → ingestion

The unary RPC `/recount.telemetry.ExecutionParticipants/Claim` accepts one `ParticipantFact` and returns an empty `ClaimParticipantResponse` only after confirmed publication of its final `AnalyticalParticipant` to Kafka. This is a separate service next to OTLP, not execution attributes hidden in metrics. Use the existing node bearer token and endpoint. No compression is accepted initially.

| Fields                                          | Required semantics                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`, `node_id`, `host_id`, `boot_id`   | Exact enrolled project, node and host; canonical Linux boot UUID.                                                                                       |
| `execution_key`                                 | Case-sensitive ASCII `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`. No trimming, case folding or project prefix parsing.                                         |
| `participant_id`, `fact_id`, `revision`, `kind` | Canonical lowercase, nonnil UUIDs; positive UInt64 revision; known nonzero kind.                                                                        |
| `subject`, `provenance`, `owner_uid`            | Subject absent for lifecycle, required process for membership; origin `ENVIRONMENT` with matched variable name; optional kernel owner (UID 0 is valid). |
| `first_seen_unix_nano`, `last_seen_unix_nano`   | Nonzero UInt64 Unix nanoseconds, first ≤ last; observed coverage, not proof of continuous sampling.                                                     |
| `ended_unix_nano`                               | Optional exclusive membership/lifecycle end strictly after last seen. Unknown end remains absent.                                                       |
| `metadata`                                      | Optional lifecycle execution name, workload version and unique string parameters from the first labelled process's explicit labels only.                |
| `retracted`                                     | Higher revision withdraws this fact; retain the tombstone so replay cannot resurrect it.                                                                |

An open membership covers `[first_seen, last_seen]`; a closed membership covers `[first_seen, ended)`. Never extend membership to query time merely because an end is unknown. No exit code or signal is inferred from disappearance.

Identity fields (tenant, node, host, boot, execution key, participant, kind, subject, provenance and owner UID) do not change within a fact. New revisions may correct times, end and retraction; lifecycle revisions retain identical metadata. Correct the wrong execution or subject by retracting the old fact and creating a new fact. Retraction affects only that fact: withdrawing a participant requires retracting its membership facts too. The collector persists revision allocation before queueing; after losing that state, allocate fresh IDs. Reusing a revision with changed content violates the protocol; there is no permanent conflict ledger.

### Limits and authorization

Limits are UTF-8 bytes and declared in [`execution.rs`](../crates/telemetry-schema/src/execution.rs): 65,536 per network claim and 73,728 per final analytical record. Preflight both before publication. Environment reads are independently bounded to 65,536 bytes. Name ≤128 bytes; workload version ≤256; ≤32 parameters with keys 1–64 and values 0–1,024 bytes; namespace identifiers 1–128; environment variable names 1–128 with ASCII `[A-Za-z_][A-Za-z0-9_]*`. Names/version are nonempty when present, have no leading/trailing whitespace, and metadata strings contain no control characters. Parameter keys use ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, are unique and sorted bytewise. Empty parameter values are valid.

Process namespace identifiers use the existing collector identifier grammar. Process PID fits positive Int32; start ticks may be zero. Unknown enum values, absent required messages, incompatible subjects, invalid variable names, times/identities and duplicate parameters fail validation. Membership facts forbid metadata. Lifecycle facts forbid subjects, including an empty subject message.

Ingestion authenticates using the [existing node-token and revocation policy](collector-enrollment.md#ingestion-and-revocation), then requires exact equality with the token's project, node/source and host root. It requires the Linux adapter and process local-kind grant, not a container grant. It derives trusted `SecurityScope`; caller fields never grant authority. Process identities use the enclosing host and boot. No synchronous execution lookup, PostgreSQL write or workload inference occurs on admission.

Malformed claims return `INVALID_ARGUMENT`, foreign scope or missing grants `PERMISSION_DENIED`, invalid tokens `UNAUTHENTICATED`, and deterministic limits `RESOURCE_EXHAUSTED` without retry advice. None publish. Authority/broker outages return retryable `UNAVAILABLE`; an uncertain timeout retries the identical fact. Upload timing uses `last_seen` with the token's existing maximum age/skew; old facts outside that finite delivery window are explicitly rejected with `FAILED_PRECONDITION`, not retimed. End must not exceed the ingestion clock plus token skew. Replaying already accepted Kafka records does not refresh credentials, revocation or upload age.

## Kafka and storage

Use one topic, `recount.participants`. After token-scope checks, ingestion resolves the existing process resource IDs and publishes one bare `AnalyticalParticipant`, including its accepted record UUID and receipt time. Route by `TypedHash("recount.execution-route")`, with project ID and execution key as length-prefixed fields, using the existing fixed-count partition function. One key stays ordered in one partition; there is no cross-key order.

ClickHouse consumes that topic directly. There is no participant raw/normalized split, normalizer mode, application consumer group, PostgreSQL projection or projector credential. Admission already performs the validation and projection needed by storage, so another worker would duplicate that boundary without satisfying an additional acceptance check.

The participant topic is trusted storage input: only ingestion may publish to it. Broker access is an operator boundary, not node authorization.

Kafka acknowledgement confirms acceptance, not immediate queryability. Native replay preserves the stored fact/revision identity and process resource IDs. Only the ClickHouse group advances downstream progress; its strict source and non-aggregating materialized view store records before advancing offsets.

### ClickHouse participants

`telemetry.execution_participants` uses the flat `AnalyticalParticipant` fields as typed columns: strings, UInt8 enums/boolean, UInt32 PID/UID, UInt64 revisions/ticks/nanoseconds, nullable optional scalars and Protobuf bytes for full provenance. `environment_variable` records the matched name directly. Metadata is queryable through nullable `execution_name`, nullable `workload_version` and an array of parameter key/value tuples. Lifecycle process columns are null.

```sql
ENGINE = ReplacingMergeTree(revision)
PARTITION BY cityHash64(project_id) % 16
ORDER BY (project_id, execution_key, node_id, fact_id)
```

The fixed project hash partition keeps every revision and tombstone together even when corrected times cross days. There is no event-day partition or automatic participant TTL. A strict Kafka `ProtobufSingle` source (`executions.proto:AnalyticalParticipant`, group `recount-clickhouse-participants`) and non-aggregating materialized view insert facts alongside, not into, `metric_points`.

Readers select the latest revision using bounded `FINAL` with tenant/key predicates **before** filtering tombstones, subject or corrected times. Immutable retries collapse independently of background merges; lower revisions arriving late cannot supersede newer ones. Same-revision conflicting content is a protocol violation with undefined competing-row results. Receipt/record IDs are lineage, never replacement keys or revision precedence.

Query-time execution analytics resolves only nonretracted `PROCESS_MEMBERSHIP` rows to `(project, node/source, process_resource_id, interval)` and performs a semijoin against point resource/time. Overlapping facts must not multiply points. Unassociated processes stay observable. Participant lifecycle facts supply machine/owner/start/end display, not invented workload measurements, exit status or aggregate distributed completion.

### Execution reads

The web application lists keys from a bounded, project-predicated query over `execution_participants FINAL`. It filters retractions after selecting revisions, then groups by execution key. Lifecycle metadata comes from the earliest active lifecycle, ordered by `(first_seen_unix_nano, node_id, fact_id)`; absent names fall back to the key. Corrections and retractions can change the displayed metadata. Every project reader can read all executions in that project under [application access](application-access.md).

Each private operation checks canonical project access and uses the existing analytics slot and SELECT-only ClickHouse client. Pages contain 50 keys in ascending key order, with one additional row to detect the next page. Queries cap physical rows, bytes, result size, memory and execution time; limit failures are errors, not empty or truncated successes.

The committed Drizzle migration drops the old `app.execution` interval table. There is no replacement PostgreSQL execution table or metadata editing API. Owner UID, node and start/end remain on participant facts. No old-record conversion, dual readers or data backfill is provided.

## Implementation boundary and fixtures

Ingestion supplies validation, analytical projection and direct publication. The web application reads execution listings. The launcher owns input validation and env-and-exec only; the collector owns bounded environment discovery, durable membership/lifecycle facts and claim export; workload analytics consumes those facts at query time.

Fixtures cover two nodes joining one key, duplicate/out-of-order revisions and retractions, inherited process membership, rootless lifecycle facts, environment provenance, unassociated processes, PID reuse, malformed/foreign project/node/host claims, native Kafka replay and bounded authorized execution reads. Assert unchanged point and process identities and `series_id`. Use the reused backend with disposable database/topic/group names. Launcher checks cover validation, environment replacement, PID, streams, signals and status. Collector checks cover one read per incarnation, unreadable/truncated environments, scheduler precedence, privacy, lifecycle closure/reappearance, safety caps and pruning of ended acknowledged facts.
