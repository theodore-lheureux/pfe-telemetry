# Oracle ingestion deployment layout

The proposed layout co-locates the ingestion API, Kafka, normalizer, ClickHouse,
PostgreSQL, web application and one shared Live gateway on the existing VM.
It is a single-host prototype, not a highly available deployment.

## Inspection status

Read-only OCI inspection on 16 November 2026 confirmed:

| Item                     | Observed configuration                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Shape                    | `VM.Standard.A1.Flex`, running                                                                |
| CPU                      | 4 OCPUs / 4 vCPUs, 3.0 GHz Ampere Altra                                                       |
| RAM                      | 24 GiB                                                                                        |
| Network bandwidth        | 4 Gbit/s shape allocation                                                                     |
| Boot volume              | 47 GiB, 10 VPUs/GiB                                                                           |
| Additional block volumes | None attached                                                                                 |
| Image OS                 | Canonical Ubuntu 24.04, ARM64 image dated 27 October 2026                                     |
| Network                  | Existing public subnet in an existing VCN, default route through enabled internet gateway     |
| Security                 | One subnet security list; no VNIC NSGs                                                        |
| Ingress                  | TCP/22 from any IPv4 source; ICMP destination-unreachable/fragmentation rules; no 80/443 rule |
| Egress                   | All protocols to any IPv4 destination                                                         |
| Agent plugins            | Run Command, monitoring, custom logs and Cloud Guard workload protection report running       |

Exact identifiers, addresses, SSH connection settings and inspection receipts
remain in ignored `.state` files. An authenticated OCI Run Command returned the
host's Ed25519 fingerprint; the SSH scan matched it before an approved owner key
was used. Read-only guest inspection confirmed Ubuntu 24.04.5 LTS on ARM64,
approximately 41 GiB free boot-filesystem space, 23,275 MiB available RAM and no
swap. Only OS/OCI agent services are running; Docker, Bun and Caddy are absent.

The host firewall admits established traffic, ICMP, loopback and SSH, then
rejects other inbound IPv4 traffic. It therefore also needs a reviewed TCP/443
rule before HTTPS can work; changing the OCI security list alone is insufficient.
Preserve its Oracle instance-service/metadata rules. No guest configuration,
firewall, software or data was changed during inspection.

Subsequent approved infrastructure CD attached the 150-GiB data volume and applied
the DNS records, daily backup policy and TCP/443 cloud rule. Ansible host
preparation installed the runtime and receiver, mounted that volume persistently,
initialized the three backends and application authority, and enabled Caddy with
valid certificates for both domains. Application release activation remains
pending; the table above records the initial inspection, not the prepared host.

## Resource budget

The deployment [overlay](deploy/compose.yaml) raises memory caps without changing
the local development stack or claiming measured fleet capacity:

| Component     | Memory cap, no swap | CPU quota | Reason                                                     |
| ------------- | ------------------- | --------- | ---------------------------------------------------------- |
| PostgreSQL    | 1 GiB               | 1         | Application, enrollment and revocation authority           |
| Kafka         | 1.5 GiB             | 1         | One combined KRaft broker/controller; 256–512 MiB JVM heap |
| ClickHouse    | 8 GiB               | 2         | Native consumers, merges and queries; 6 GiB server budget  |
| Ingestion API | 1 GiB               | 1         | Admission defaults to one decoded request                  |
| Normalizer    | 1 GiB               | 1         | Two framework workers, one preparation lane                |
| Web           | 1 GiB               | 1         | SSR, auth, email and bounded analytical reads              |
| Live          | 512 MiB             | 1         | Shared shard readers and retained-packet inspection        |

Total container caps are **14 GiB** and eight CPU quotas. Quotas
are ceilings, not reserved CPUs or measured steady consumption. On the observed
four-OCPU/24-GiB VM, these caps leave **10 GiB outside the containers** for
the OS, existing workloads, Docker, proxy and filesystem cache. Recommend the
full co-located layout without resizing, subject to guest workload/free-space
inspection. Keep CPU quotas oversubscribed for burst sharing rather than
assuming eight physical cores.

Use one replica of each component and keep existing PIDs/log/stop budgets.
Run builds on GitHub, never on the VM. Run topic inspection tools sequentially;
their 256-MiB temporary JVM is additional to Kafka. Do not raise caps or workers
to hide OOMs. Monitor peak RSS, memory pressure, CPU throttling, iowait and
native consumer errors with representative traffic before claiming capacity.

If the inspected VM is smaller or already busy, do not deploy all roles by
shrinking limits blindly. PostgreSQL cannot simply be omitted: ingestion loads
revocations and web owns enrollment/auth. Moving web alone does not remove
PostgreSQL, and remote plaintext Kafka is not supported securely by the current
clients. Choose a reduced workload or separately approved placement after
inspection; do not add a paid database, broker or VM automatically.

## Storage and retention

The approved storage layout adds one 150-GiB block volume for PostgreSQL,
Kafka and ClickHouse: **47 + 150 = 197 GiB**, below the tenancy's 200-GiB
Always Free allocation only if no other counted volumes consume the remainder.
Check all subscribed regions, volumes, performance allocation and backup counts
before enabling `deployment_enabled`; the selected VM alone cannot establish
tenancy-wide free eligibility. Stop rather than create a chargeable resource.

Mount the new volume by its verified filesystem UUID and select the existing
`data.binds.yaml` overlay with explicit data directories. Require that filesystem
to be mounted before initialization or every deployment. Do not format an
existing filesystem or fall back to boot-disk directories when a mount is absent.
Keep database identities in the root-only environment. Startup refuses
absent/empty/incompatible data instead of initializing replacement databases.

Start with current six-hour/128-MiB-per-partition limits for raw, normalized,
late and participant topics, plus five-minute/16-MiB Live limits. Three durable
partitions per topic and eight Live partitions reserve **1.625 GiB of byte
targets**, before active segments, indexes, internal topics and asynchronous
deletion. These are soft retention targets, not disk quotas.

The [recovery measurements](../../docs/kafka-recovery.md#capacity-budget)
report approximately **12 MiB raw and 90 MiB normalized per node-hour**:
7.5× expansion. A normalized hot partition reaches 128 MiB in approximately
1.42 node-hours; perfect three-way balance gives 4.27 node-hours across the
topic. Six-hour age retention therefore does not guarantee six-hour replay.

The current small fixtures measured normalizer catch-up of 120 records/1800
samples in 3.48 seconds and native ClickHouse catch-up of 512 points in
1.81 seconds with arrivals stopped. They do not establish sustained processing
rate, fleet size, memory peaks or 24-hour recovery.

A one-node 24-hour outage already needs about **2.39 GiB raw + normalized**
without overhead. The guide's 36-hour candidate reserves 27 GiB across
raw/normalized/late alone and about 40 GiB dedicated Kafka space with reserve.
Do not enable it until disk, skew, arrivals and net catch-up rate are measured
and the owner selects an outage window.

Keep the **47-GiB boot disk** for OS/agents, images and release staging, not the
database directories. The 150-GiB data filesystem allows separate operational
budgets: 10 GiB PostgreSQL, 10 GiB Kafka at the initial retention settings,
70 GiB ClickHouse and at least 30% free. These are monitored budgets, not quotas.

Reserve at least 8 GiB free for one release's download, unpacking and image
loading, independently of database growth and the filesystem's 30% free-space
target. The receiver requires both staging space and the 30% reserve
(approximately 22 GiB available on a 47-GiB filesystem before staging).
Retain the previous release; remove only explicitly identified obsolete
releases/images after approval. Never prune Docker globally.

ClickHouse has **no automatic telemetry TTL** in the current schema. Kafka
retention does not bound analytical growth. Use a provisional 70-GiB analytical
allocation, warn at 80%, and stop admitting new collection before exhausting
the host; the allocation is an operational budget, not an implemented quota.
Select analytical retention and its schema changes separately after measuring
compressed growth. Do not silently add a destructive TTL or promise indefinite
storage.

## Network and TLS

Reuse the internal broker, authority, analytics and Live bridges. Backend ports
and application upstreams remain bound to host loopback; Live has no public
port. Do not expose Kafka 9092/19092, PostgreSQL 5432/15432, ClickHouse
8123/18123, gRPC 14317 or web 3000 through OCI rules.

The host-side [Caddy configuration](deploy/Caddyfile) terminates HTTPS
on 443 for `app.recount.cloud` and `ingest.recount.cloud`, forwarding web HTTP/SSE to
loopback 3000 and gRPC over h2c to loopback 14317. Caddy obtains certificates
through ACME TLS-ALPN-01 on **443 only**; HTTP challenge and redirects are
disabled, so there is no port-80 rule. The root manages only those two DNS-only
A records in the existing `recount.cloud` zone. The apex and landing Worker
remain unchanged. Verify DNS resolution and certificate issuance before activation.
The proxy replaces untrusted forwarding headers, streams SSE without
buffering and sends a one-year `Strict-Transport-Security` header for the web
application. Verify HTTP/2 collector health/acceptance, passkeys, client-IP
handling and SSE through the real proxy before admitting users.

An existing proxy/tunnel may be preferable after inspection. Reuse it only
after checking gRPC, body/deadline limits and SSE. Opening 443, DNS/certificate
changes and firewall rules require explicit approval. Internal plaintext
connections remain confined to one host; they are not suitable for a split-host
deployment without supported TLS/auth configuration.

## Backups and recovery

The prepared volume policy creates daily incremental data-volume snapshots
with two-day retention. Verify tenancy-wide eligibility and the Always Free
five-backup limit before applying; reserve at least three free slots for two
retained daily snapshots plus creation/expiry overlap.
Do not add cross-region copies, paid object storage or a retention policy that
exceeds that limit. Snapshots of running databases are crash-consistent, not
application-consistent exports or a cross-store transaction. Test restoration
into approved isolated capacity before claiming recoverability.
Keep signing keys, Better Auth secret, database identities and TLS material
separately encrypted and recoverable. Do not put runtime secrets in S3 state,
release archives, OCI command text or GitHub logs.

An attached boot/block volume and OCI's underlying replication are not independent
backups. Live needs no backup. Kafka is a bounded replay buffer, not an archive;
do not copy a running Kafka data directory as if it were a coherent backup.
Disk-loss recovery restores application authority and analytical backups, then
replays only retained/independently archived raw data where available. Some
accepted data can be lost on a single broker. Measure actual backup size and
charges before approving automation.

## Deployment controller

GitHub Actions handles native builds, approval gates and OCI-only release
activation. Infrastructure plan/apply runs in serialized, approval-gated GitHub
Actions with a scoped AWS state user and OCI identity. Only identity bootstrap
runs locally with profile `pfe`; CD cannot manage IAM.
The [Ansible bootstrap](README.md#prepare-the-host-after-approval) owns host
packages, persistent storage, backend initialization, runtime authority and Caddy
over host-key-verified SSH. It does not activate application releases; deployment
CD invokes only the restricted receiver.
**Semaphore is not needed for this layout.** The earlier
AWS controller would duplicate orchestration, credentials and maintenance.
Its EC2, disks, Cloudflare Tunnel/Access and state remain untouched; retirement
is a separate owner decision, not part of this deployment.
