# Collector enrollment

Collectors enroll themselves with a project-scoped **enrollment key** and then authenticate as individual **nodes** with one-hour access tokens. The ingestion service verifies each token in memory, so per-submission authority needs no database lookup and adding a machine needs no administrator action beyond distributing the key.

## Decisions

| Question                      | Decision                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| How collectors get authority  | One enrollment key per fleet or environment, distributed by configuration management         |
| Approval of new nodes         | Automatic: a valid, unexpired enrollment key below its node limit is sufficient              |
| Node identity                 | The machine ID (`/etc/machine-id`, or the collector's `--host-id`); hostname is display only |
| Per-submission authentication | Signed access token verified in memory by the ingestion service                              |
| Revocation                    | Per node; the ingestion service polls revoked node IDs every 30 seconds                      |
| Access-token lifetime         | One hour                                                                                     |
| Default Linux local kinds     | Processes and containers                                                                     |
| Node limit per key            | Optional; unlimited by default                                                               |
| Deleting a node               | Revokes it and removes it from the node list; its telemetry stays queryable                  |

## Concepts

An **enrollment key** belongs to one project and carries the policy every node enrolled with it receives: adapter, allowed local resource kinds, upload timing, optional node limit, optional expiry and labels. The key can enroll nodes; it cannot submit telemetry. Revoking or expiring a key stops new enrollments and does not affect nodes that already enrolled. Key format: `recount_enroll_<UUID>_<43-character base64url secret>`; the web application stores only the SHA-256 digest of the whole key and shows the key once, when it is created.

A **node** is one machine in one project. It has a stable node ID, the machine ID as its host root, a display hostname, the enrollment key's labels, the key that created it and an Ed25519 public key. The collector keeps the matching private key; the server never sees it. The node ID is also the telemetry source ID.

An **access token** is a compact JWS (`alg` `EdDSA`) signed by the web application. Its claims name the node (`sub`), organization (`org`), project, root (`root`, `rootKind` host), adapter, local kinds (`localKinds`), upload timing in seconds (`maxAge`, `skew`), issuer `recount`, audience `recount-ingestion`, issue time and an expiry one hour later. The header's `kid` identifies the signing key.

## Enrollment

1. A project admin creates an enrollment key in **Project settings → Collectors** and copies it from the one-time reveal.
2. Configuration management installs the key in a private file and starts the collector with `--enrollment-key-file`, `--enrollment-url` (the web application URL) and `--state-directory`.
3. On first start the collector generates an Ed25519 key pair, stores the private key in `node.key` and sends `POST /api/collectors/enroll` with the enrollment key, machine ID, hostname, collector version and public key.
4. The web application locks the key row and checks that it is active, unexpired and below its node limit. It creates the node or, when an active node in the same project already has that machine ID, requires its original enrollment key before replacing the stored public key and keeping the node ID. Another enrollment key cannot take over that node or its renewal policy. It returns the node ID, project ID and a first access token.
5. The collector writes the node ID and project ID to `node.json`. Both files use mode `0600`. The enrollment key file can be removed after enrollment.

Enrollment is idempotent per active machine ID. A reimaged machine with a new machine ID enrolls as a new node; machines cloned from one image need distinct machine IDs or explicit `--host-id` values. Enrollment requests are not rate limited.

## Access tokens

The collector requests a token ten minutes before the current one expires, and whenever the ingestion service refuses the current one, by sending `POST /api/collectors/token` with its node ID, a Unix timestamp and a base64url Ed25519 signature over `recount-collector-token\n<node ID>\n<timestamp>`. The web application rejects timestamps more than two minutes from its clock, unknown or revoked nodes and invalid signatures, then issues a token and updates the node's `last_seen_at`. At 10,000 nodes this is about 3 requests per second.

Collector endpoints answer JSON with `Cache-Control: no-store`. Rejections carry only a stable code (`FORBIDDEN`, `CAPACITY` or `INVALID_INPUT`) so that wrong keys, revoked keys and unknown nodes are indistinguishable.

## Ingestion and revocation

The ingestion service is configured with the trusted public keys through `RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS`. It checks each submission's signature, issuer, audience and expiry in memory and grants exactly the token's host root with its adapter and local kinds; independent resources are not granted to nodes. The web application also publishes its current public key at `/.well-known/recount-collector-keys` as a JWK set.

Every 30 seconds the ingestion service reads the IDs of nodes revoked within the last two hours, which covers every token that can still be valid. Its database role reads only `id`, tenant columns and `revoked_at` from `ingestion.collector_node`. Until the first list loads, submissions fail as unavailable. If later refreshes fail, the service keeps the last list, and readiness fails once the list is five minutes old. A node revoked during such an outage can submit until its token expires, at most one hour.

A revoked node cannot obtain new tokens. Its collector keeps queued batches until they reach the queue lifetime and logs that its token was refused.

## Signing keys

`RECOUNT_COLLECTOR_SIGNING_KEY` holds the web application's Ed25519 seed: 32 random bytes, base64url without padding. Generate one with `openssl rand 32 | basenc --base64url | tr -d =`, and print the matching public key for the ingestion service with `bun apps/web/scripts/collector-public-key.ts`. The key ID is the first 16 characters of the base64url SHA-256 of the base64url public key.

To rotate the signing key, add the new public key to the ingestion service's comma-separated list, switch the web application to the new seed, and remove the old public key after one token lifetime has passed.

## Management

**Project settings → Collectors** has two sections. Only effective project admins can view or change them.

- **Nodes**: a paginated table with search by hostname, machine ID or label, a status filter, and bulk revoke and delete. Revoked nodes stay listed until deleted. Deleting a node revokes it and hides its record; its telemetry stays queryable, and the machine can enroll again as a new node.
- **Enrollment keys**: name, labels, active node count, node limit, expiry and status, with create and revoke.

## Data model

| Table                      | Key fields                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingestion.enrollment_key` | `id`, tenant, `name`, `key_sha256`, adapter, `allowed_local_kinds`, upload timing, `max_nodes`, `labels`, `expires_at`, `revoked_at`                                |
| `ingestion.collector_node` | `id`, tenant, `enrollment_key_id`, `machine_id`, `hostname`, `public_key`, `labels`, `collector_version`, `enrolled_at`, `last_seen_at`, `revoked_at`, `deleted_at` |

`collector_node` has a partial unique index on (project, `machine_id`) for nodes that are not revoked, and a deleted node must also be revoked. The web application owns both tables and their Drizzle migrations.

## Alternatives considered

| Option                                              | Why not chosen                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-node credentials created by an administrator    | Manual work per node and one authority query per submission                                                                                                                                     |
| One shared fleet token for telemetry                | A leaked token exposes the whole fleet; no per-node revocation or identity                                                                                                                      |
| Mutual TLS with a per-project certificate authority | Strongest transport binding, but requires certificate issuance, renewal and TLS through proxies; the collector currently supports only plaintext endpoints. Node key pairs leave this path open |
| Long-lived per-node tokens issued at enrollment     | Revocation needs a per-submission lookup again                                                                                                                                                  |

## Consequences

- The collector must reach the web application to enroll and renew tokens, in addition to the ingestion endpoint. A node that cannot renew keeps queueing locally within the queue's lifetime.
- Independent-resource grants, such as VMs or devices reported by another node, are not part of enrollment keys. They can be added later as node-level grants.
- Anyone holding an enrollment key can enroll machines into the project until the key expires or is revoked. Use short expiries for one-off keys and a node limit where the fleet size is known.
