# Execution keys and participant facts

An execution is `(project_id, execution_key)`. The first accepted claim creates its PostgreSQL record asynchronously; later claims join the same key. A key such as `run:2026-11-15-a` or `slurm:48213` needs no pre-registration. Reusing a key intentionally joins the existing execution, even after every participant has ended.

Participant facts are separate from measurements. Neither OTLP points, analytical point columns, resource identities nor `series_id` gain an execution dimension. This replaces the one-source/interval recording model in [execution telemetry](execution-telemetry.md); that model remains implemented until Phase 2.

## Local launcher delivery

The launcher writes a bare Protobuf `LocalExecutionClaim` from [executions.proto](../crates/telemetry-schema/proto/executions.proto) to a configured `RECOUNT_CLAIM_DIRECTORY`. The same directory is configured on the collector; its project is the collector's enrolled project. The launcher needs no backend credential or connection. Provision the directory and UID-owned child directories before starting workloads.

1. Each launcher UID owns a `0700` child directory named by its decimal UID. The collector needs read/write access, normally as root. Never use a world-writable common inbox.
2. Serialize writers and collector cleanup with an exclusive advisory lock on that UID directory's `.lock` file. Write a `0600` temporary regular file, sync it, atomically rename it to `<claim_id>.pb`, then sync the directory. Reject symlinks, unexpected ownership, nonregular files and oversized files; open relative to trusted directory handles without following links.
3. `claim_id` is a fresh UUID. On first collector ownership, it becomes `participant_id`. If durable collector state is lost while the claim file remains, allocate fresh participant and fact IDs and retain `launcher_claim_id` as provenance; never restart the old fact's revision sequence. Local snapshot revisions start at 1 and increase durably, independently of collector fact revisions. Each file is the latest complete snapshot, not an append log. Commit the initial snapshot before releasing the child to execute. Failure to persist the initial claim fails the launch.
4. Persist another snapshot when the root exits, including its exclusive `ended_unix_nano` and wait result. Retain the last verified live observation as `last_seen_unix_nano`, strictly before that end. This local end describes the root, not its descendants or cgroup. For a cgroup already observed by the collector, the collector closes its lifecycle only after verified emptiness. If the collector is down, the file remains discoverable after restart, even if the command has exited. The launcher reports final persistence failures explicitly.
5. The collector copies a snapshot and its processing cursor into its durable state before considering it consumed. It queues immutable network facts separately, retries unchanged after uncertain responses and scans the inbox on startup and periodically. A newer file revision can subsume earlier snapshots because it retains the original start and known end/exit. It must not move the start to collector discovery time.
6. A launcher snapshot is terminal when `exit` is present; the launcher never changes it again. Retain nonterminal files. Remove a terminal file under the same lock only after durable collector ownership, including any still-live cgroup tracking; retain it if copying fails. Files have no automatic age eviction. Per UID, cap the inbox at 1,024 claims and 64 MiB, including temporary replacement space. Capacity errors are visible; never silently evict another claim.

The launcher supplies a verified root `LocalProcessIncarnation` containing only PID and start ticks, plus boot ID, local owner UID, timing/exit and explicit metadata. `LocalParticipantSubject.dedicated_cgroup` states whether the launcher created a dedicated cgroup for the command. Local claims carry no cgroup path, inode, incarnation or namespace ID. The launcher reads no workload environment or arguments for metadata.

The collector checks the claim owner against the file UID. It verifies the live root's boot ID, PID, start ticks and UID in its own procfs view and applies its configured `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`. When `dedicated_cgroup` is true, it reads the actual cgroup from `/proc/<pid>/cgroup` and derives its cgroup identity from the kernel; otherwise it follows ancestry from the root. There is no UID allowlist, delegated-subtree configuration or launcher-declared path to authorize. The kernel enforces cgroup creation and placement permissions. `RECOUNT_CGROUP_SUBTREE` may be an optional creation-location hint for the launcher, never an authorization input.

A launcher can falsely mark an inherited shared cgroup as dedicated. For launcher-derived cgroup membership, verify each candidate process's UID and associate it only when that UID equals the claim UID. Exclude descendants that change UID and close an existing interval when a UID change is observed. A root-only UID check is insufficient. Scheduler-adapter pattern matching is unchanged.

If the root has already exited when the collector first observes the claim, record only its lifecycle using the claim's original start and known root end/exit. Do not discover a cgroup or emit process membership retrospectively: the collector took no samples while the workload ran. Unknown end/exit remains absent. Finished offline claims are declarative launcher evidence, not retrospective kernel attestation.

Directory write access permits a local user to assert execution attribution within this project, subject to live process ownership checks. It must not confer cross-project access or a web user identity.

## Identity and membership

| Identity    | Meaning                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node        | Enrolled node UUID; also the existing telemetry `source_id`. `host_id` is the token's host root, not a hostname.                                                                            |
| Process     | Enclosing boot ID plus `namespace_id`, positive PID and raw `start_time_ticks`; use the existing Linux process hash and `local_resource_id(project, host, PROCESS, incarnation)` unchanged. |
| Cgroup      | Boot ID, cgroup namespace identity, canonical absolute v2 path, nonzero inode and a persisted incarnation UUID. Path/inode alone do not survive deletion/recreation safely.                 |
| Participant | Node-scoped UUID for one cgroup lifecycle or, without a cgroup, one launched ancestry root. Scheduler discovery allocates and persists it.                                                  |
| Fact        | Node-scoped UUID for one lifecycle or one continuous process-membership interval. Each revision is a full replacement snapshot.                                                             |

`PARTICIPANT_LIFECYCLE` identifies the participant's cgroup and optional launched root, or its ancestry root when no cgroup exists; its `fact_id` equals `participant_id`. `PROCESS_MEMBERSHIP` requires a process incarnation and a fresh fact UUID for each actual membership interval; it repeats the participant ID and cgroup when present. Emit membership facts for the root and every observed member, not only the launch process. Confirm initial lifecycle publication before uploading that participant's membership facts. Ingestion does not require a synchronous parent lookup. Cgroup-only lifecycle facts do not attribute node-wide measurements.

Cgroup membership includes observed descendants of the collector-observed path at path-component boundaries, with the per-member UID check above for launcher-derived membership. Moving out closes an interval; moving back starts a new fact. Cgroup disappearance/recreation gets a new incarnation and participant. Preserve identities across collector restart only with durable evidence; uncertain rediscovery gets new identities rather than silently merging histories.

Use ancestry only when cgroups cannot be used. Verify both child and parent incarnations when discovering an edge, and retain discovered descendants after reparenting. Do not infer a new edge from a reused parent PID or assign an unknown orphan. Fallback cannot recover a child that forked and reparented between observations. Missing evidence remains unassociated, not node-wide membership.

Provenance retains `origin` (`LAUNCHER`, `SCHEDULER_ADAPTER`, `ANCESTRY`), launcher claim UUID, configured adapter identifier, and verified ancestry root/parent incarnations as applicable. Ancestry-origin facts retain their launcher claim reference. Cgroup membership facts keep the launcher or scheduler origin. Local numeric `owner_uid` identifies the workload root's owner, not each descendant's current UID or a Better Auth owner. Retain the launcher file UID; a scheduler owner that cannot be established remains absent, never invented as UID 0.

## Collector → ingestion

The unary RPC `/recount.telemetry.ExecutionParticipants/Claim` accepts one `ParticipantFact` and returns an empty `ClaimParticipantResponse` only after confirmed raw Kafka publication. This is a separate service next to OTLP, not execution attributes hidden in metrics. Use the existing node bearer token and endpoint. No compression is accepted initially.

| Fields                                          | Required semantics                                                                                                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`, `node_id`, `host_id`, `boot_id`   | Exact enrolled project, node and host; canonical Linux boot UUID.                                                                                                                                                                                   |
| `execution_key`                                 | Case-sensitive ASCII `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`. No trimming, case folding or project prefix parsing.                                                                                                                                     |
| `participant_id`, `fact_id`, `revision`, `kind` | Canonical lowercase, nonnil UUIDs; positive UInt64 revision; known nonzero kind.                                                                                                                                                                    |
| `subject`, `provenance`, `owner_uid`            | Subject rules above; known origin; optional owner (UID 0 is valid). Launcher origin requires claim UUID and owner; scheduler origin requires adapter; ancestry requires root and parent and no cgroup.                                              |
| `first_seen_unix_nano`, `last_seen_unix_nano`   | Nonzero UInt64 Unix nanoseconds, first ≤ last; observed coverage, not proof of continuous sampling.                                                                                                                                                 |
| `ended_unix_nano`, `exit`                       | Optional exclusive membership/lifecycle end strictly after last seen. Exit has a nonzero timestamp ≥ first seen and exactly one outcome: exit code 0–255 or signal 1–64. It describes the subject/root process, never an inferred distributed exit. |
| `metadata`                                      | Optional execution name, workload version and unique string parameters. No automatic command/environment capture.                                                                                                                                   |
| `retracted`                                     | Higher revision withdraws this fact; retain the tombstone so replay cannot resurrect it.                                                                                                                                                            |

An open membership covers `[first_seen, last_seen]`; a closed membership covers `[first_seen, ended)`. Never extend membership to query time merely because an end is unknown. A process membership may not carry execution metadata. Exit requires a process subject; end and exit are independent because cgroup descendants may outlive the root. Unknown status is absent, not exit code zero.

Identity fields (tenant, node, host, boot, execution key, participant, kind, subject, provenance and owner UID) do not change within a fact. New revisions may correct times, end, exit and retraction; lifecycle revisions retain identical metadata. Correct the wrong execution or subject by retracting the old fact and creating a new fact. Retraction affects only that fact: withdrawing a participant requires retracting its membership facts too. The collector persists revision allocation before queueing; after losing that state, allocate fresh IDs. Reusing a revision with changed content violates the protocol; there is no permanent conflict ledger.

### Limits and authorization

Limits are UTF-8 bytes and declared in [`execution.rs`](../crates/telemetry-schema/src/execution.rs): 65,536 per local/network claim, 69,632 per raw record and 73,728 per analytical record. Preflight all three before publication. Name ≤128 bytes; workload version ≤256; ≤32 parameters with keys 1–64 and values 0–1,024 bytes; namespace identifiers 1–128; cgroup path ≤4,096; adapter identifier ≤64. Names/version are nonempty when present, have no leading/trailing whitespace, and metadata strings contain no control characters. Parameter keys use ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`, are unique and sorted bytewise. Adapter uses that same grammar. Empty parameter values are valid.

Process/cgroup namespace identifiers use the existing collector identifier grammar. Process PID fits positive Int32; start ticks may be zero. Cgroup paths start with `/`, are not `/`, and contain no empty, `.` or `..` component, trailing slash or control character. Cgroup incarnation and launcher references use canonical nonnil UUIDs. Unknown enum values, absent required messages, incompatible provenance, invalid times/identities and duplicate parameters fail validation. Membership facts forbid metadata; provenance fields irrelevant to their origin are rejected except the retained launcher reference on ancestry.

Ingestion authenticates using the [existing node-token and revocation policy](collector-enrollment.md#ingestion-and-revocation), then requires exact equality with the token's project, node/source and host root. It requires the Linux adapter and process local-kind grant, plus the container local-kind grant when a cgroup is present. It derives trusted `SecurityScope`; caller fields never grant authority. Root, ancestry and parent identities all use the same enclosing host and boot. No synchronous execution lookup, PostgreSQL write or workload inference occurs on admission.

Malformed claims return `INVALID_ARGUMENT`, foreign scope or missing grants `PERMISSION_DENIED`, invalid tokens `UNAUTHENTICATED`, and deterministic limits `RESOURCE_EXHAUSTED` without retry advice. None publish. Authority/broker outages return retryable `UNAVAILABLE`; an uncertain timeout retries the identical fact. Upload timing uses `last_seen` with the token's existing maximum age/skew; old facts outside that finite delivery window are explicitly rejected with `FAILED_PRECONDITION`, not retimed. End/exit must not exceed the ingestion clock plus token skew. Accepted replay validates the retained contract without refreshing credentials, revocation or upload age.

## Kafka and storage

Use separate `recount.participants.raw` and `recount.participants.normalized` topics. Ingestion writes one bare `RawParticipantRecord` containing trusted scope, accepted record UUID, receipt time and the fact. Route by `TypedHash("recount.execution-route")`, with project ID and execution key as length-prefixed fields, using the existing fixed-count partition function. One key stays ordered in one partition; there is no cross-key order.

A participant mode of the normalizer consumes raw facts with group `recount-participants`. For each input it validates the retained record, upserts the PostgreSQL execution, then publishes one bare `AnalyticalParticipant` and waits for Kafka acknowledgement before advancing input progress. Failures halt that input; do not skip poison or reset checkpoints. A separate service credential permits only execution projection, not user or membership administration. Fresh groups require explicit bootstrap, as for point normalization.

PostgreSQL commit and Kafka output are not atomic. A crash can leave execution metadata visible before participants, or replay an upsert/output; both are safe. Kafka acceptance is not either store's visibility guarantee. Replaying retained raw facts preserves fact/revision identity and process resource IDs.

### ClickHouse participants

`telemetry.execution_participants` uses the flat `AnalyticalParticipant` fields as typed columns: strings, UInt8 enums/boolean, UInt32 PID/UID/outcomes, UInt64 revisions/ticks/nanoseconds, nullable optional scalars, and Protobuf bytes for full provenance and metadata.

```sql
ENGINE = ReplacingMergeTree(revision)
PARTITION BY cityHash64(project_id) % 16
ORDER BY (project_id, execution_key, node_id, fact_id)
```

The fixed project hash partition keeps every revision and tombstone together even when corrected times cross days. There is no event-day partition or automatic participant TTL. A strict Kafka `ProtobufSingle` source (`executions.proto:AnalyticalParticipant`, group `recount-clickhouse-participants`) and non-aggregating materialized view insert facts alongside, not into, `metric_points`.

Readers select the latest revision using bounded `FINAL` with tenant/key predicates **before** filtering tombstones, subject or corrected times. Immutable retries collapse independently of background merges; lower revisions arriving late cannot supersede newer ones. Same-revision conflicting content is a protocol violation with undefined competing-row results. Receipt/record IDs are lineage, never replacement keys or revision precedence.

Query-time execution analytics resolves only nonretracted `PROCESS_MEMBERSHIP` rows to `(project, node/source, process_resource_id, interval)` and performs a semijoin against point resource/time. Overlapping facts must not multiply points. Unassociated processes stay observable. Participant lifecycle facts supply machine/owner/start/end/exit display, not invented workload measurements or aggregate distributed completion.

### PostgreSQL execution

Replace `app.execution` directly with UUID `id`, tenant-qualified project foreign key, `execution_key` (unique with project ID), `name`, nullable `workload_version`, `parameters` JSONB string object, `created_at`, nullable `created_by` web-user attribution and retained `created_by_node_id`. Remove source, host and recording interval columns. Do not foreign-key historical node attribution to a deletable node. Keep project-reader visibility from [application access](application-access.md).

The projector inserts with `ON CONFLICT (project_id, execution_key) DO NOTHING`, resolving organization from the canonical project in the same transaction. The first accepted record in that key's partition supplies initial metadata (default name = key, version absent, parameters `{}`); joins never overwrite it, even when later metadata differs. A database/project failure prevents checkpoint progress. Creation is eventual and requires no prior web record.

The browser lists these projected executions and removes the recording-create form/API. Machine claims do not impersonate web users: `created_by` is null; project admins may edit execution metadata under independently authorized, tenant-qualified operations. Owner UID remains participant provenance. Start/end/exit come from participants, not stored source/time selectors. No old-record conversion, dual readers or data backfill is provided. Generate one Drizzle migration for the new schema; recreate only explicitly allocated incompatible disposable test databases.

## Implementation boundary and fixtures

Ingestion owns validation, projection, storage and execution listings. The launcher owns local persistence; the collector owns cgroup/ancestry discovery, durable membership facts and claim export; query-time analytics resolves memberships. Runtime implementation follows this contract.

Phase 2 fixtures cover two nodes joining one key, duplicate/out-of-order revisions and retractions, cgroup root/child membership, ancestry with reparenting, unassociated processes, same PID with different ticks/boot/namespace, explicit zero exit versus unknown, malformed/foreign project/node/root claims, and offline handoff/replay. Assert unchanged point bytes, process resource IDs and `series_id`; verify first-claim creation and stable metadata after joins. Use the reused backend with disposable database/topic/group names. Linux-only discovery/export checks run in the existing Linux build container.
