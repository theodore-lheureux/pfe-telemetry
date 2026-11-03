# Organizations and project access

Better Auth's `organization`, `member` and `invitation` tables are the canonical organization records. Application projects and explicit project grants reference those records; there is no second organization-membership model.

## Access policy

Projects are private by default. An organization member needs an explicit project role to read a project, except that organization owners and admins always have project admin access throughout their organization. An explicit lower project role cannot reduce that organization-level access. These roles never grant platform-wide operator access.

New organization grants use one canonical role: `owner`, `admin` or `member`. Native member and invitation hooks reject malformed or multi-role grants rather than changing their meaning after authorization. Invitation acceptance requires verified email ownership.

Project roles are `viewer`, `member` and `admin`. Every role grants project read access. Project admins can update project settings and manage explicit project memberships; viewers and members cannot. Only organization owners/admins create projects. The `member` role is available for non-administrative execution actions as those operations are implemented.

Any project reader can read all executions in that project. Execution ownership records attribution and controls permitted modifications, not read visibility. Per-execution private/shared ACLs are not part of this model. Separate projects provide the isolation boundary for unrelated workloads.

The same project scope must apply to future telemetry queries, exports and live channels. The current implementation covers organization/project metadata and membership operations; it does not make ClickHouse or the existing operator DuckDB queries tenant-authorized.

## Application interfaces

`apps/web/src/organizations/organization.functions.ts` provides these Start server functions:

| Operation                                 | Access                                                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `listOrganizations`                       | Current verified user's memberships only                             |
| `getOrganization`                         | Organization member                                                  |
| `createOrganization`                      | Verified user; creator becomes owner                                 |
| `listProjects`                            | Visible projects in the selected organization                        |
| `getProject`                              | Effective project reader                                             |
| `createProject`                           | Organization owner/admin                                             |
| `updateProject`                           | Effective project admin                                              |
| `listProjectMembers`                      | Effective project admin; explicit grants only                        |
| `setProjectMember`, `removeProjectMember` | Effective project admin; target must belong to the same organization |

Read operations use GET; mutations use POST. Inputs are validated on the server. Validation and transport failures reject the call; application outcomes use the `data`/`error` union in `contracts.ts`. Unknown or inaccessible organization/project references return `NOT_FOUND`; missing sessions return `UNAUTHENTICATED`. Responses are private and not HTTP-cached.

`OrganizationSummary` includes the current user's organization role. `ProjectSummary.role` is the effective role, including organization owner/admin access. Project-membership responses contain explicit grants, not an expanded list of implicit administrators. Organization IDs and membership IDs are opaque Better Auth strings; project IDs are UUIDs. Organization slugs are globally unique, and project slugs are unique within their organization.

Every operation resolves the current session and canonical membership. The active organization stored in a session, route context, client filters and cached roles are not authorization. Queries explicitly scope project IDs to an organization. Removing an organization membership cascades its project grants; rejoining does not restore those grants.

`request.server.ts` resolves verified sessions, wires dependencies and maps expected failures into the public result contract. `createOrganizationRequests` accepts explicit database/auth dependencies for database-backed callers and tests. Its `requireProjectAccess` derives the actor from request headers and returns an authorized project; it does not accept a caller-supplied user identity.

`access.server.ts` owns membership lookup and effective permission decisions. `organizations.server.ts` handles organization reads and native Better Auth creation; `projects.server.ts` handles project and grant operations. These feature modules use Drizzle directly and receive server-resolved actors, not browser headers. Tenant predicates and access checks stay beside the operations they protect. Future telemetry handlers must use the same access decision before querying a sink.

## Database integrity

The native member table has unique `(organization_id, user_id)` and `(id, organization_id)` keys. The second key supports tenant-qualified project membership foreign keys. Both project and organization membership must reference the same organization, even when data is written outside application helpers.

Better Auth rejects admin-to-owner promotion, but its native last-owner count checks do not serialize competing changes. The `organization_owner_guard` row is a derived integrity counter, not an authorization source. A member trigger updates that row in the same transaction as owner additions, role changes or deletion. Its positive-count constraint prevents competing operations from removing the final owner, including user-delete cascades. Failed writes roll back their counter changes. Promote a replacement owner before removing an existing final owner.

Organization deletion is disabled. Adding that workflow requires explicitly handling its membership and guard lifecycle; it must not bypass the owner invariant accidentally.

`0002_organizations_and_projects.sql` defines the tables and constraints. `0003_organization_owner_integrity.sql` contains the trigger. The application maintains `src/db/auth-schema.ts` and its member unique keys directly; Drizzle owns migration generation and history. Do not replace the database invariant with an unlocked application-side count.

## Validation

Run `just test-db` with an isolated PostgreSQL test account as described in [web development](../apps/web/README.md#test-database-changes). The organization tests cover private defaults, role precedence, cross-organization identifiers and foreign keys, revocation, native promotion restrictions, concurrent owner loss and user-delete cascades.
