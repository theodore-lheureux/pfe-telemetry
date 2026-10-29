# Collector credentials

Verified effective project admins manage collector credentials. Organization owners and admins inherit this permission; explicit project admins also qualify. Project members and viewers cannot create, list, rotate or revoke credentials. Better Auth sessions and canonical memberships determine access on every operation, independently of route context or the active organization.

## Application interface

`apps/web/src/credentials/credential.functions.ts` exports these TanStack Start server functions:

| Function                    | Method | Input                                                                     |
| --------------------------- | ------ | ------------------------------------------------------------------------- |
| `listCollectorCredentials`  | GET    | `organizationId`, `projectId`                                             |
| `createCollectorCredential` | POST   | Project reference, `name`, `sourceId`, `hosts` and optional policy fields |
| `rotateCollectorCredential` | POST   | Project reference and `credentialId`                                      |
| `revokeCollectorCredential` | POST   | Project reference and `credentialId`                                      |

Client-safe DTOs are in `credentials/contracts.ts`. Results use the organization `OperationResult` union. Missing sessions return `UNAUTHENTICATED`; unverified users and project readers without admin access receive `FORBIDDEN`. Unknown or inaccessible project/credential references return `NOT_FOUND`. Malformed inputs reject the RPC; a creation expiry that is not in the future returns `INVALID_INPUT`. Unexpected storage or cryptographic failures reject the call. Responses are private and `no-store`, including validation failures.

Creation and rotation return `{ credential, token }`. Only these responses reveal the token. Listing and revocation return summaries without tokens or digests. Keep the reveal separate from cached listing data: do not put tokens in URLs, logs, persisted mutation/query state or browser storage. Refetch or invalidate the owning credential listing after successful mutations and clear private data on account changes. A lost creation/rotation response cannot be recovered; rotate an active credential again, or create a replacement if it has expired or been revoked.

## Enrollment policy

Every credential binds one project, one source and an exact permitted-host list. Several independently revocable credentials can enroll the same source. Source identities are project-scoped, not globally unique. Submitted telemetry does not choose the authenticated project or source.

| Field                  | Default  | Constraint                                                           |
| ---------------------- | -------- | -------------------------------------------------------------------- |
| `sourceId`             | Required | Nonempty, at most 128 UTF-8 bytes, no Unicode control characters     |
| `hosts`                | Required | At most 256 distinct identifiers with the same rules as `sourceId`   |
| `requireHostId`        | `true`   | Requires a nonempty permitted-host list when true                    |
| `maximumSubmissionAge` | `3600`   | Integer seconds, 1–86400                                             |
| `allowedClockSkew`     | `60`     | Integer seconds, 1–3600                                              |
| `expiresAt`            | `null`   | Optional timezone-bearing ISO timestamp, strictly future at creation |

Identifiers are not trimmed, normalized or case-folded. Hosts have no wildcard semantics. `requireHostId: false` permits telemetry without a host identifier; a supplied host must still match the allowlist, as in the ingestion service's existing enrollment policy.

## Ingestion lookup contract

Migration `0004_collector_credentials.sql` creates `ingestion.collector_credential`. The web application manages its rows; the ingestion login receives only schema `USAGE` and table `SELECT`, without access to `app`. The tenant-qualified `(project_id, organization_id)` foreign key references `app.project` and cascades on project deletion. PostgreSQL constraints enforce static digest and enrollment-policy validity. Shared identifier-validation helpers remain in `app` for credential and execution writes; credential reads do not execute CHECK constraints. Constraint helpers are maintained in the same Drizzle migration; there is no separate migration runner.

Tokens have this format:

```text
pfe_<lowercase UUID>_<43-character unpadded base64url secret>
```

The UUID is the row's public `id`; the secret is generated from 32 cryptographically random bytes. `token_sha256` stores the lowercase hex SHA-256 digest of the **entire ASCII token**, not just the secret. No plaintext or reversible secret representation is stored.

Parse the token strictly, select by UUID, and compare the digest in constant time. A credential is eligible only when `revoked_at IS NULL` and `expires_at IS NULL OR expires_at > statement_timestamp()`. Resolve current state for each new submission; an unbounded positive authentication cache would defeat revocation. A dedicated ingestion connection needs schema usage and read-only access to this table, not application membership or session tables.

The row provides `project_id`, `source_id`, `hosts`, `require_host_id`, `maximum_submission_age` and `allowed_clock_skew`, matching `apps/server/src/auth.rs`'s `Source` policy. PFE-61 replaces the static-file lookup with this live database contract; the web backend does not alter the Rust authentication path.

Rotation atomically replaces the digest on the same public ID and records `rotated_at`, preserving policy and expiry. The old token stops matching immediately after commit. Revoked or expired credentials cannot rotate. Concurrent rotations are last-writer-wins; an earlier returned token may already be invalid. Revocation permanently disables the credential through the management API and preserves the first `revoked_at` timestamp, including across retries and competing rotation.

## Design choice

[Better Auth API keys](https://www.better-auth.com/docs/plugins/api-key) support hashed secrets and organization ownership, but still require application-specific project authorization and source/host policy. Their documented management model does not supply this same-ID rotation and permanent timestamped revocation contract, and verification performs tracking writes. A small purpose-built table keeps Better Auth responsible for human sessions and memberships while allowing read-only ingestion verification.

The implementation uses [Node cryptographic randomness and SHA-256](https://nodejs.org/api/crypto.html), [Drizzle constraints](https://orm.drizzle.team/docs/indexes-constraints) and atomic updates. Expiry decisions use [PostgreSQL database time](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT); they are not time-dependent `CHECK` constraints.

Run `just test-web` and `just test-db` with the disposable PostgreSQL configuration described in [web development](../apps/web/README.md#test-database-changes). Credential integration tests create isolated databases, replay migration history, and exercise authorization, tenant constraints, one-time reveals, expiry, rotation, revocation and concurrent lifecycle operations.
