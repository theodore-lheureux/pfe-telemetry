# Architecture

Recount collects resource measurements from distributed workloads and presents authorized execution-window context. The current ingestion path is authenticated OTLP → raw Kafka → Rust normalizer → normalized Kafka → native ClickHouse Kafka source/materialized view → `ReplacingMergeTree` points. PostgreSQL holds application, session, execution and credential authority only. Analytical visibility can be partial and delayed; there is no whole-batch visibility gate.

The web application uses TanStack Start and shadcn/ui, with shared English/French catalogs and localized transactional emails. Better Auth manages human sessions, email-code sign-in and passkeys. Collector bearer credentials are separate from those sessions. Existing execution pages provide fixed-window node context, not proof of workload attribution or completion. Trace storage, automatic execution associations and a live-streaming UI remain outside the implemented ingestion path. See [execution semantics](execution-telemetry.md) and the [web application](../apps/web/README.md).

## Component responsibilities

| Component                  | Responsibility                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux collector            | Sample node and verified process resources; persist immutable pending uploads and retry temporary failures.                                                                      |
| Ingestion API              | Authenticate each submission, resolve root/independent-resource grants, validate the whole request and exact output expansion, then acknowledge confirmed raw Kafka publication. |
| Normalizer                 | Revalidate retained context and publish one bare point per record; RustStream tracks settled prefixes only after every required output acknowledgement.                          |
| Kafka                      | Retain raw and normalized records separately and track each downstream group's progress.                                                                                         |
| ClickHouse                 | Consume normalized Protobuf through its native Kafka engine and project series metadata and narrow point rows into separate tables.                                              |
| TanStack Start application | Manage application state and independently authorize private server operations before querying ClickHouse with a read-only account.                                              |
| PostgreSQL                 | Maintain Better Auth memberships/sessions, projects, execution windows and collector enrollment keys and nodes.                                                                  |

The deployable Rust services are `apps/collector`, `apps/ingestion-api` and `apps/normalizer`. The normalizer needs Kafka only, not PostgreSQL or ClickHouse credentials. There is no Rust storage service, direct ClickHouse application writer or PostgreSQL telemetry acceptance ledger. Pure generated schema/identity/projection code lives in `crates/telemetry-schema`; semantic and resource-policy checks live in `crates/telemetry-validation`.

## Data flow

```mermaid
flowchart LR
    collectors["Collectors and standard OTLP exporters"] -->|OTLP/gRPC| ingest["Ingestion API"]
    ingest --> raw["Kafka: raw metrics"]
    raw --> normalizer["Rust normalizer"]
    normalizer --> normalized["Kafka: analytical Protobuf rows"]
    normalized --> native["ClickHouse Kafka source and materialized views"]
    native --> points["ReplacingMergeTree: telemetry.metric_points"]
    native --> series["AggregatingMergeTree: telemetry.metric_series"]
    web["TanStack Start application"] -->|Authorized read-only queries| points
    web --> series
    ingest -->|Revoked node IDs every 30 s| postgres["PostgreSQL: application and authority"]
    collectors -->|Enrollment and access tokens| web
    web -->|Sessions, projects and executions| postgres
```

Collectors need no broker credentials or partition knowledge. The API retains a generated `RawRecord` with trusted project/source, resolved access, unchanged OTLP ordering and submission metadata. The normalizer reuses admission's shared validation and projection, then publishes each bare `AnalyticalPoint` separately across explicit stream-affinity partitions. Native ClickHouse consumes `ProtobufSingle`.

Raw routing spreads immutable submissions; normalized routing gives streams explicit fixed-partition affinity. Neither promises global event-time order, especially across concurrent raw partitions. Preserve late and out-of-order observations with their original times. Exact messages, routing, limits and fidelity rules are in the [telemetry point contract](telemetry-point-contract.md), not a second application model.

## Acceptance, storage and recovery

Raw acknowledgement, normalized publication/input checkpointing and ClickHouse storage/downstream checkpointing are separate at-least-once boundaries. None is a distributed transaction. A timeout or crash can leave acknowledgement uncertain; retries preserve original identity, values and positions. RustStream owns worker dispatch and tracked prefixes; periodic commits follow required output acknowledgements. There is no custom normalizer polling/recovery state machine.

ClickHouse stores one observation per row, with native typed scalar/distribution/attribute projections. The target partitions by UTC event day and sorts project-first with immutable sample identity in the replacement key. One histogram observation retains its bucket structure in one row. The schema and generated SQL columns derive from the same `recount.proto` artifact.

Replacing merges clean up physical retries but do not make ordinary reads immediately unique. Current duplicate-sensitive readers use `FINAL` before bucketing/calculation and keep continuity segments separate. Different original observations are not collapsed merely because their timestamps or values match. There is no permanent first-content-winner registry: changing content under a reused immutable producer identity violates the protocol.

Invalid retained input or a failed publication takes explicit global handler fail-stop, leaving unfinished input unsettled. Startup validates declared topology and effective caps before publication. Fresh groups start at retained earliest. Unavailable offsets deliberately use reset=`earliest`: expired data is discarded with a warning and gap visibility, and the normalizer counts native reset events. The retained suffix is not complete recovery. The [normalizer reference](../apps/normalizer/README.md) and [Kafka recovery guide](kafka-recovery.md) explain the limits; short retention and process liveness do not establish high availability or completeness.

## Identity, authority and privacy

Project, reporting source, observed resource, stream and sample are distinct identities. Each enrolled node is one source. A source may report several resources, and token renewal does not create a new source or observed resource. The ingestion API verifies each submission's signed node access token in memory, rejects nodes on its periodically refreshed revocation list, and grants the token's host root without a per-submission database lookup.

An enrolled root grants reporting within its namespace and explicitly allowed adapter/local kinds. The Linux adapter derives process-local identity from root, boot, namespace, PID and start ticks without enrolling/querying every PID. Independent VMs and devices require exact typed bindings, which node tokens do not grant. Neither a payload parent/placement assertion nor an empty grant list expands authority; root scope is not physical attestation. The normalizer validates accepted stored context without refreshing node state, grant policy or upload age.

Private application reads independently authorize project access through Better Auth's canonical memberships. Route context and browser guards are not authorization boundaries. Keep ingestion's read-only authority role separate from the application's database role and ClickHouse query credential. See [collector enrollment](collector-enrollment.md) and [application access](application-access.md).

The isolated development network uses plaintext OTLP/Kafka; production transport security is not supplied by that isolation. Do not log tokens or payloads. Linux metric sampling collects numeric real UIDs and recognized Slurm job and step IDs for process attribution. GPU allocation measurements link a GPU UUID to a verified process incarnation. It does not export usernames or raw cgroup paths, and excludes arguments, environment variables, executable paths, application files and process memory. Opt-in execution discovery is separate. Retention and access policies apply to pending buffers, retained raw records and analytical projections alike.

## Measurements and validation

Preserve exact values, optional/no-recorded states, resource/scope attributes, source timestamps and continuity. Missing measurements are not measured zero. Submission-age/clock policy applies to declared batch creation, not individual measurement age; no blanket measurement-age/future cutoff or timestamp rewriting is introduced.

The [optional Linux lab](../infra/lab/README.md) supplies independent guests, monitoring and controlled stress-ng/fio workloads. It reaches the separately provisioned Recount stack; a gRPC connectivity probe does not prove authenticated acceptance or analytical visibility. Compile Linux application/test artifacts on the host and execute them in allocated Linux environments.

Validate semantic fixtures separately from real Kafka/MV replay, poison, checkpoint ambiguity, retention gaps and browser authorization. Measure collector overhead, peak decoded memory, backlog recovery, low-volume latency and sample-to-query delay with representative workloads before making capacity claims. Configurable byte/row/concurrency bounds are provisional safety controls, not a demonstrated HPC or IoT fleet budget.

## Local diagram sources

PlantUML sources share the Recount styling in `diagram-style.iuml`; teal boxes are Recount components. Rendered PNGs are in `diagrams/`, numbered in presentation order; rendering tools are not managed by this repository.

| Diagram                                                           | Source                                                     | Shows                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| [1-current-architecture](diagrams/1-current-architecture.png)     | [current-architecture.puml](current-architecture.puml)     | Components and their connections                   |
| [2-telemetry-flow](diagrams/2-telemetry-flow.png)                 | [telemetry-flow.puml](telemetry-flow.puml)                 | One upload from collector to dashboard             |
| [3-execution-participants](diagrams/3-execution-participants.png) | [execution-participants.puml](execution-participants.puml) | How a labelled process joins an execution          |
| [4-application-access](diagrams/4-application-access.png)         | [application-access.puml](application-access.puml)         | Organizations, projects, roles and their resources |
| [5-deployment](diagrams/5-deployment.png)                         | [deployment.puml](deployment.puml)                         | Where each component runs                          |
