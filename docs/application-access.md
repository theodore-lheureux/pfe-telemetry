# Organizations and project access

Better Auth's `organization`, `member` and `invitation` tables are the canonical organization records. Application projects and explicit project grants reference those records; there is no second organization-membership model.

## Access policy

Projects are private by default. An organization member needs an explicit project role to read a project, except that organization owners and admins always have project admin access throughout their organization. An explicit lower project role cannot reduce that organization-level access. These roles never grant platform-wide operator access.

New organization grants use one canonical role: `owner`, `admin` or `member`. Native member and invitation hooks reject malformed or multi-role grants rather than changing their meaning after authorization. Invitation acceptance requires verified email ownership.

Project roles are `viewer`, `member` and `admin`. Every role grants project read access. Project admins can update project settings and manage explicit project memberships; viewers and members cannot. Only organization owners/admins create projects. The `member` role is available for non-administrative execution actions as those operations are implemented.

Only effective project admins manage [collector credentials and enrollment policy](collector-credentials.md), including listing credentials. Credential identities and lifecycle operations are project-scoped.

Any project reader can read all executions in that project. Execution ownership records attribution and controls permitted modifications, not read visibility. Per-execution private/shared ACLs are not part of this model. Separate projects provide the isolation boundary for unrelated workloads.

The same project scope applies to [execution recordings and telemetry queries](execution-telemetry.md). Every telemetry RPC checks current project membership before resolving the recording and querying ClickHouse. Direct operator SQL is not a tenant-authorized application interface.

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

## Organization invitations

`src/organizations/invitation.functions.ts` wraps [Better Auth invitations](https://www.better-auth.com/docs/plugins/organization#invitations). Input and response types are defined in `invitation-contracts.ts`.

| Operation                                                   | Access                      |
| ----------------------------------------------------------- | --------------------------- |
| `createInvitation`, `cancelInvitation`                      | Organization owner/admin    |
| `listInvitations`                                           | Organization member         |
| `inspectInvitation`, `acceptInvitation`, `rejectInvitation` | Matching verified recipient |

All operations require a verified session, including native endpoints. Only owners may invite owners. Invitations expire after 48 hours; check expiry as well as status. Resending a live pending invitation preserves its role; expired invitations receive a new link. Cancel and recreate an invitation to change its role.

Email links open `/invitations/$invitationId`. Acceptance requires an explicit POST, creates a canonical membership and does not restore previous project grants. Invitations do not bypass closed registration.

Create/resend attempts are limited to ten per user per minute across HTTP and server calls. A successful response does not guarantee email delivery; use Resend to retry. Canceling or rejecting an invitation does not revoke an existing membership.

Refresh invitation data after changes and membership/session state after acceptance. Preserve the local return URL through sign-in.

## Database integrity

The native member table has unique `(organization_id, user_id)` and `(id, organization_id)` keys. The second key supports tenant-qualified project membership foreign keys. Both project and organization membership must reference the same organization, even when data is written outside application helpers.

Better Auth rejects admin-to-owner promotion, but its native last-owner count checks do not serialize competing changes. The `organization_owner_guard` row is a derived integrity counter, not an authorization source. A member trigger updates that row in the same transaction as owner additions, role changes or deletion. Its positive-count constraint prevents competing operations from removing the final owner, including user-delete cascades. Failed writes roll back their counter changes. Promote a replacement owner before removing an existing final owner.

Organization deletion is disabled. Adding that workflow requires explicitly handling its membership and guard lifecycle; it must not bypass the owner invariant accidentally.

`0002_organizations_and_projects.sql` defines the tables and constraints. `0003_organization_owner_integrity.sql` contains the trigger. The application maintains `src/db/auth-schema.ts` and its member unique keys directly; Drizzle owns migration generation and history. Do not replace the database invariant with an unlocked application-side count.

## Member administration

The member administration page is `/organizations/$organizationId/members`. Every organization member can see the canonical member directory and leave; only owners/admins can change roles, remove other members or manage invitations. Administrators cannot appoint, demote or remove owners. To replace an owner, an existing owner first promotes another member to owner, then removes or demotes the previous owner. The final owner cannot leave. Concurrent owner loss returns a controlled conflict rather than bypassing the database invariant.

Effective project admins manage explicit grants at `/organizations/$organizationId/projects/$projectId/settings/members`. The selector lists current members of the same organization. Organization owner/admin access is shown as implicit and cannot be reduced by a project grant. Removing a redundant explicit grant leaves that implicit access intact. Giving up one's own explicit project administration returns to the organization's project list.

`member.functions.ts` exposes `listOrganizationMembers`, `listProjectGrantCandidates`, `updateOrganizationMemberRole`, `removeOrganizationMember` and `leaveOrganization`. Each operation resolves a verified session independently. `members.server.ts` projects safe directory fields and calls native Better Auth APIs for organization membership changes; project grants use the existing application operations. Router context/loaders own the UI state and are invalidated after successful changes. The UI does not introduce Better Auth organization stores or private Query data.

Invitation email links open `/invitations/$invitationId`. Sign-in preserves that local return path. Invitation details are shown only after the backend verifies the signed-in user's matching, verified email. Opening a link never joins an organization: acceptance and rejection require explicit POST actions. Unavailable links show invalid, expired, canceled or already-used feedback; rejection shows a terminal confirmation and does not remove an existing membership. New ordinary members still need explicit project access. Administrators can cancel pending invitations or retry delivery with Resend; only owners can resend owner invitations. A resend preserves the stored role, and an expired invitation receives a new link. Creation and resend feedback do not guarantee email delivery.

## Validation

Run `just test-db` with an isolated PostgreSQL test account as described in [web development](../apps/web/README.md#test-database-changes). The organization tests cover private defaults, role precedence, cross-organization identifiers and foreign keys, revocation, native promotion restrictions, concurrent owner loss and user-delete cascades. Invitation regressions cover native role restrictions, verified mailbox matching, expiry, replay, concurrent acceptance, resend, delivery failure and shared send-attempt limits. `just test-web` checks invitation validation and email rendering/delivery with a non-network transport.
