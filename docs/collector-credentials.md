# Collector credentials

Verified effective project admins manage collector credentials. Organization owners and admins inherit this permission; explicit project admins also qualify. Project members and viewers cannot create, list, rotate or revoke credentials. Better Auth sessions and canonical memberships determine access on every operation, independently of route context or the active organization.

## Application interface

`apps/web/src/credentials/credential.functions.ts` exports these TanStack Start server functions:

| Function                    | Method | Input                                                                                   |
| --------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `listCollectorCredentials`  | GET    | `organizationId`, `projectId`                                                           |
| `createCollectorCredential` | POST   | Project reference, `name`, `sourceId`, `rootId` and optional typed grants/upload policy |
| `rotateCollectorCredential` | POST   | Project reference and `credentialId`                                                    |
| `revokeCollectorCredential` | POST   | Project reference and `credentialId`                                                    |

Client-safe DTOs are in `credentials/contracts.ts`. Results use the organization `OperationResult` union. Missing sessions return `UNAUTHENTICATED`; unverified users and project readers without admin access receive `FORBIDDEN`. Unknown or inaccessible project/credential references return `NOT_FOUND`. Malformed inputs reject the RPC; a creation expiry that is not in the future returns `INVALID_INPUT`. Unexpected storage or cryptographic failures reject the call. Responses are private and `no-store`, including validation failures.

Creation and rotation return `{ credential, token }`. Only these responses reveal the token. Listing and revocation return summaries without tokens or digests. Keep the reveal separate from cached listing data: do not put tokens in URLs, logs, persisted mutation/query state or browser storage. Refetch or invalidate the owning credential listing after successful mutations and clear private data on account changes. A lost creation/rotation response cannot be recovered; rotate an active credential again, or create a replacement if it has expired or been revoked.

## Enrollment policy

Every credential binds one project, one stable reporting source and a default typed root. Root grants and independent-resource grants are indexed records, not a host array. Several independently revocable credentials can enroll the same source; source/resource identities are project-qualified. Submitted telemetry does not choose the authenticated project or source, and credential rotation does not redefine observed resources.

| Field                  | Default    | Constraint                                                                  |
| ---------------------- | ---------- | --------------------------------------------------------------------------- |
| `sourceId`             | Required   | 1–128 UTF-8 bytes, no Unicode control/surrogate characters                  |
| `rootId`               | Required   | Same identifier rules; reserved `recount.local.` namespace is forbidden     |
| `rootKind`             | `1` (host) | Current generated resource-kind value, `0`–`8`                              |
| `adapter`              | `standard` | `standard` or `linux`                                                       |
| `allowedLocalKinds`    | `[]`       | Distinct supported local kinds; empty grants the root alone, not a wildcard |
| `additionalRoots`      | `[]`       | Up to 256 typed root grants per creation operation                          |
| `resources`            | `[]`       | Up to 256 exact typed independent-resource grants per creation operation    |
| `maximumSubmissionAge` | `3600`     | Positive integer seconds                                                    |
| `allowedClockSkew`     | `60`       | Non-negative integer seconds; zero is valid                                 |
| `expiresAt`            | `null`     | Optional timezone-bearing ISO timestamp, strictly future at creation        |

The API parser preserves identifier spelling: no case folding or normalization; the web form trims its inputs before submission. Root/independent grant IDs must be unique and disjoint in a creation request. `standard` roots have no local-kind delegation. Linux roots may explicitly permit supported local kinds; the current enrollment form creates one host root with adapter `linux` and process kind `4`. The richer server-function input can also enroll additional roots and exact independent bindings; the form is not a topology editor.

Each duration is at most `18446744073` seconds (`floor((2^64 - 1) / 10^9)`), and age plus skew must fit the same whole-second UInt64-nanosecond bound. The credential form and server parser share `MAX_U64_NANOSECONDS_DURATION_SECONDS`; the collector queue-age parser uses the equivalent Rust constant. All durations remain finite; there is no unlimited sentinel. These are representation checks, not a shared one-day/one-hour policy ceiling. Upload policy applies to declared batch creation, never individual measurement age. Choose collector queue lifetime no greater than enrolled upload age.

Supported local kinds and deterministic identities follow the [resource-grant contract](telemetry-point-contract.md#resource-grant-interface). The Linux adapter checks one root authority for its supported local processes, not a database grant/query per PID. Independent VMs/devices require exact typed membership; payload parent/placement claims confer no permission. Root scope permits reporting in a namespace, not physical attestation. The default request authority-key limit and per-operation grant limits are not project/fleet enrollment capacity promises.

## Ingestion lookup contract

The application-maintained [Drizzle schema](../apps/web/src/db/credentials-schema.ts) defines `ingestion.collector_credential`, `ingestion.collector_root_grant` and `ingestion.collector_resource_grant`. Creation transactionally writes the credential and grants. Tenant-qualified foreign keys bind credentials to projects/organizations and grants to the same credential tenant. Digest, identifiers, resource kinds, adapter/local-kind restrictions and upload-duration constraints remain enforced in PostgreSQL.

The web application owns writes and normal Drizzle generate → review → migrate history. The ingestion role receives only schema `USAGE` and table `SELECT` on these three authority tables, without application/session membership access or telemetry acceptance tables. Identifier constraint helpers remain application-maintained; read-only ingestion does not need to execute write-time CHECK helpers. Use [stack provisioning](../infra/README.md) and [database development](../apps/web/README.md#test-database-changes), not a second migration runner or prototype data conversion.

Tokens have this format:

```text
recount_<lowercase UUID>_<43-character unpadded base64url secret>
```

The UUID is the row's public `id`; the secret is generated from 32 cryptographically random bytes. `token_sha256` stores the lowercase hex SHA-256 digest of the **entire ASCII token**, not just the secret. No plaintext or reversible secret representation is stored.

The [ingestion API authority](../apps/ingestion-api/src/auth.rs) parses the token, selects by public UUID and compares the digest in constant time. Eligibility requires `revoked_at IS NULL` and `expires_at IS NULL OR expires_at > statement_timestamp()`. Each submission uses live authoritative reads through a bounded verified PostgreSQL pool; there is no positive credential cache, offline grant or per-sample credential lookup. Database outages fail closed with retryable unavailability, not anonymous acceptance.

The credential provides trusted project/source, default root and upload policy. After resolving resource claims, ingestion fetches only the bounded distinct root and independent-resource keys requested in that submission. The grant lookup rechecks credential digest/revocation/expiry and tenant-qualified joins. Shared policy validates exact typed grants before raw publication. The normalizer does not query these tables: accepted Kafka replay validates stored context shape without refreshing current revocation, grants or upload age. Private analytical reads independently authorize human project access.

Rotation atomically replaces the digest on the same public ID and records `rotated_at`, preserving policy and expiry. The old token stops matching immediately after commit. Revoked or expired credentials cannot rotate. Concurrent rotations are last-writer-wins; an earlier returned token may already be invalid. Revocation permanently disables the credential through the management API and preserves the first `revoked_at` timestamp, including across retries and competing rotation.

## Design choice

[Better Auth API keys](https://www.better-auth.com/docs/plugins/api-key) support hashed secrets and organization ownership, but still require application-specific project/source/resource policy. Their documented management model does not supply this same-ID rotation and permanent timestamped revocation contract, and verification performs tracking writes. Dedicated authority tables keep Better Auth responsible for human sessions and canonical memberships while allowing read-only ingestion verification.

The implementation uses [Node cryptographic randomness and SHA-256](https://nodejs.org/api/crypto.html), [Drizzle constraints](https://orm.drizzle.team/docs/indexes-constraints) and atomic updates. Expiry decisions use [PostgreSQL database time](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT); they are not time-dependent `CHECK` constraints.

Credential integration tests create isolated databases, replay application migration history and exercise authorization, tenant constraints, typed grants, one-time reveals, expiry, rotation, revocation and concurrent lifecycle operations. Compile on the host and run application/test harnesses only in Docker with explicitly allocated disposable PostgreSQL resources; see [web development](../apps/web/README.md#test-database-changes) and the [ingestion validation reference](../apps/ingestion-api/README.md#validation). Do not use private/shared databases as test targets.
