# Organizations and project access

Better Auth's `organization`, `member` and `invitation` tables are the canonical organization records. Application projects and explicit project grants reference those records; there is no second organization-membership model.

## Access policy

Projects are private by default. An organization member needs an explicit project role to read a project, except that organization owners and admins always have project admin access throughout their organization. An explicit lower project role cannot reduce that organization-level access. These roles never grant platform-wide operator access.

New organization grants use one canonical role: `owner`, `admin` or `member`. Native member and invitation hooks reject malformed or multi-role grants rather than changing their meaning after authorization. Invitation acceptance requires verified email ownership.

Project roles are `viewer`, `member` and `admin`. Every role grants project read access. Project admins can update project settings and manage explicit project memberships; viewers and members cannot. Only organization owners/admins create projects. The `member` role is available for non-administrative execution actions as those operations are implemented.

Only effective project admins manage [collector enrollment keys and nodes](collector-enrollment.md), including listing them. Keys, nodes and their lifecycle operations are project-scoped. Collector enrollment and token endpoints authenticate with enrollment keys and node signatures, not user sessions.

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

Read operations use GET; mutations use POST. Inputs are validated on the server. Validation and transport failures reject the call; application outcomes use the `data`/`error` union in `lib/operation-result.ts`. Unknown or inaccessible organization/project references return `NOT_FOUND`; missing sessions return `UNAUTHENTICATED`. Responses are private and not HTTP-cached.

`OrganizationSummary` includes the current user's organization role. `ProjectSummary.role` is the effective role, including organization owner/admin access. Project-membership responses contain explicit grants, not an expanded list of implicit administrators. Organization IDs and membership IDs are opaque Better Auth strings; project IDs are UUIDs. Organization slugs are globally unique, generated from the name when the organization is created, and never shown; projects have no slug.

Every operation resolves the current session and canonical membership. The active organization stored in a session, route context, client filters and cached roles are not authorization. Queries explicitly scope project IDs to an organization. Removing an organization membership cascades its project grants; rejoining does not restore those grants.

The Start function middleware in `auth/private-operation.ts` resolves a verified session from the incoming request, sets private response headers and supplies trusted identity, request headers and server dependencies. Server functions call domain operations directly through `withActor`; `lib/operation-result.server.ts` maps expected failures into the public result contract. Middleware context is server-derived, not client-supplied identity or authorization. Unexpected failures retain their causes in server diagnostics and expose only a generic RPC error.

Provisioning and database-backed tests use `actorService` from `auth/actor.server.ts` with explicit auth dependencies and request headers. Each call resolves its own verified session before invoking a domain operation. Domain operations independently check canonical organization/project access; authenticating through middleware or a service does not grant access to a requested tenant.

`access.server.ts` owns membership lookup and effective permission decisions. `organizations.server.ts` handles organization reads and native Better Auth creation; `projects.server.ts` handles project and grant operations. These feature modules use Drizzle directly and receive server-resolved actors, not browser headers. Tenant predicates and access checks stay beside the operations they protect. Future telemetry handlers must use the same access decision before querying a sink.

### Create retries and form ownership

Project and execution creates require a caller-generated UUID `requestId`. Repeating a logical submission uses the same ID and validated semantic input. Request IDs have actor-specific namespaces. Within that namespace, `app.create_receipt` binds an ID to the operation and complete tenant/scope; changing the validated inputs or scope returns `CONFLICT` with reason `REQUEST_ID_REUSED`. The receipt and resource commit in one PostgreSQL transaction. Every attempt authorizes before and after receipt arbitration, including a waiter that becomes the winner after another transaction rolls back. Replay reconstructs the current authorized resource summary, with native `Date` values, rather than returning a cached private object. A missing resource does not permit a replacement create.

The browser offers one explicit same-submission retry after an uncertain project/execution create. It retains the original payload and request ID only in memory while the same actor and navigation still own the operation. Navigation, authentication changes and document freezing retire that retry. A completed same-actor acknowledgement survives fragment navigation; an identity change clears private result data. Reloading requires reviewing the authorized resource list; there is no persistent or offline mutation queue.

Name/role/grant setters express desired state but do not order competing writes: an old name X can overwrite a newer Y if sent later. They receive no new retry control or automatic retry. Client lifetime checks prevent stale feedback, field resets, refresh and navigation; they do not cancel committed writes or provide database concurrency control.

TanStack Form owns fields, parser-based validators and validation errors, including execution recordings, chart intervals and enrollment key creation. Successful submission explicitly parses values again to apply transformations; validation alone does not transform Form's values. Query tracks ordinary nonsecret write settlement, and Router continues to own route reads and refresh. A failed refresh after an acknowledged write stays a saved outcome and cannot unlock another create. `use-mutation-owner.ts` shares actor/navigation ownership with the dedicated invitation workflows. Authentication and one-time collector secrets do not use the ordinary mutation adapter or receipt cache.

Better Auth organization creation remains separate. Its native creation hooks and the current API call do not expose the shared application transaction needed for an atomic receipt. A lost response therefore retains the dedicated uncertain-create behavior, without automatic or same-key retry. Slug uniqueness is not proof that organization and owner creation completed together.

## Organization invitations

`src/organizations/invitation.functions.ts` wraps [Better Auth invitations](https://www.better-auth.com/docs/plugins/organization#invitations). Input and response types are defined in `invitation-contracts.ts`.

| Operation                                                   | Access                      |
| ----------------------------------------------------------- | --------------------------- |
| `createInvitations`, `resendInvitation`, `cancelInvitation` | Organization owner/admin    |
| `listInvitations`                                           | Organization member         |
| `inspectInvitation`, `acceptInvitation`, `rejectInvitation` | Matching verified recipient |

All operations require a verified session, including native endpoints. Only owners may invite owners. Invitations expire after three days; check expiry as well as status. Resending a live pending invitation preserves its role and personalized name/message; expired invitations receive a new link. Cancel and recreate an invitation to change its role.

`createInvitations` accepts one organization ID, 1–10 recipients and an optional shared message. Each recipient supplies a unique `clientId`, email address, organization role and optional `recipientName`. Client IDs correlate results with form rows; they are not authorization or retry tokens. The server validates the complete batch, normalized email uniqueness and owner-role permissions before creating any invitations.

The batch returns ordered `results` with `created`, `rejected` or `not-attempted` status for each recipient. Created results include the invitation summary; rejected results include an application error. Known recipient conflicts do not prevent subsequent recipients from being processed. An authorization or rate-limit failure stops further attempts. Native Better Auth calls retain per-recipient authorization, delivery behavior and shared throttling; batching does not multiply the send allowance. The batch is not an all-or-nothing database transaction. Unexpected failures reject the call and may leave some invitations created, so an unconfirmed request must not be retried automatically.

Email links open `/invitations/$invitationId`. Acceptance requires an explicit POST, creates a canonical membership and does not restore previous project grants. Invitations do not bypass closed registration.

Create/resend attempts are limited to ten per user per minute across HTTP and server calls. A successful response does not guarantee email delivery; use Resend to retry. Canceling or rejecting an invitation does not revoke an existing membership.

The form makes one batch request and refreshes Router-owned invitation data once. Rows and entered values stay intact during sending, refresh and the closing animation. Partial results mark successful rows read-only; subsequent submissions exclude those rows. Unknown responses and failed refreshes block blind resubmission until the current invitations have been checked. Refresh membership/session state after acceptance and preserve the local return URL through sign-in.

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
