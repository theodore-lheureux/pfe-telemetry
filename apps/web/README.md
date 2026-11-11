# Web application

TanStack Start with SSR, TanStack Query, TanStack Form, React, TypeScript, Tailwind CSS, and shadcn/ui.

## Development

Run these commands from the repository root with the Bun version in `.bun-version`:

```sh
bun install --frozen-lockfile
just config
just dev
```

Open the URL printed by Vite (port 3001 by default). Set `RECOUNT_WEB_PORT` in `apps/web/.env` or use `just dev --port 3002` to change the port.

```sh
just check-web
just build
```

## Structure

- `src/routes/`: directory-based file routes, `route.tsx` layouts and the root HTML document.
- `src/router.tsx`: router context and TanStack Query SSR integration.
- `src/components/ui/`: shadcn/ui components.
- `src/components/app-form.tsx`: shared TanStack Form fields composed with shadcn Field labels, descriptions and errors.
- `src/lib/utils.ts`: class name utility.
- `src/styles.css`: application styles and the approved `src/tide-core.css` theme import.

`getRouter` creates a QueryClient for each server request. The SSR integration supplies the provider and transfers cached data to the browser. Organization and project metadata use Router context, not Query. Router reads revalidate with blocking reloads, and inactive matches and preloads have zero retention. Future Query data should keep keys and functions together with `queryOptions` and choose explicit freshness settings.

Start's default server supports streaming SSR. Await authentication and other critical data before rendering; fetch slower secondary data without blocking the loader and render it under Suspense through the Query SSR integration. Current account routes do not have deferred data. Shared loading/error/not-found components provide route feedback, and the root document remains outside those boundaries through `shellComponent`. Verify that the production host and proxy preserve streamed responses before relying on progressive delivery.

TanStack Start server functions handle browser-facing reads and mutations. The Rust ingestion API handles collector submissions.

The [Nitro Vite integration](https://nitro.build/examples/vite-ssr-tss-react) generates `.output/server` and `.output/public` using its [Bun preset](https://nitro.build/deploy/runtimes/bun). Run `bun run --cwd apps/web start` after building; production does not use Vite preview. This integration pins Nitro **3.0.261103-rc**, a release candidate, alongside Start 1.168.60, Vite 8.3.2 and Bun 1.4.2. Start owns SSR, request locale, authentication and typed server functions; Nitro owns HTTP hosting and static serving.

Production uses standard `NITRO_HOST` and `NITRO_PORT` controls (defaults `0.0.0.0` and `3000` in the image); `RECOUNT_WEB_PORT` selects only Vite's development port. `src/hosting/options.ts` uses Nitro's public server-entry options for a 60-second Bun idle timeout and a 15-second graceful drain. The SSR entry registers the [Nitro close hook](https://nitro.build/docs/plugins#graceful-shutdown) from the same module graph as application requests, drains owned email work, then closes PostgreSQL and ClickHouse clients. Cleanup failure sets a nonzero exit status. Compose provides 60 seconds before forced termination.

Build and packaging validation reject public-root symlinks, escaping symlinks, hidden/configuration/source-map/TypeScript inputs and root HTML that could replace the application entry. Nested public HTML such as the brand gallery remains supported. Nitro serves the immutable public artifact without an application-owned request-path inventory. Hashed `/assets/` responses retain one-year immutable caching and `nosniff`; other public assets use Nitro's ETag/Last-Modified behavior without the old explicit `max-age=0, must-revalidate` header. Dynamic Start responses remain private and non-cacheable.

Vite bundles the owned i18n and transactional packages into the server build. Better Auth stays external during the Start build to preserve dependency-local Zod resolution; Nitro then bundles it and traces the remaining runtime dependencies into `.output/server/node_modules`. Package only `.output`, not the source workspace or root dependency tree. The current traced dependency is pure-JavaScript `tslib`; native dependencies introduced later require a Linux build matching the selected target architecture.

## Application database

PostgreSQL stores transactional application data. Telemetry ingestion and analytical storage remain separate. The database client is lazy: building the web application does not require a running database or credentials.

### Start PostgreSQL locally

Follow the [local stack setup](../../infra/README.md) to explicitly initialize the selected disposable PostgreSQL instance. Keep its password in `infra/local/.env` and put the matching loopback URL in `apps/web/.env`:

```text
DATABASE_URL=postgresql://recount:YOUR_GENERATED_PASSWORD@127.0.0.1:15432/recount
RECOUNT_DATABASE_POOL_MAX=10
```

With the initialized database running, apply the reviewed Drizzle migrations before starting the web application:

```sh
just db-migrate
just dev
```

`just local stop` preserves database volumes. Normal startup requires the selected database identity; it does not initialize replacement data when a mount is absent or empty. The local PostgreSQL bootstrap account owns the database and is for development only. Other deployments must provision restricted runtime credentials separately from schema-management credentials. Configure transport security in the PostgreSQL connection URL for remote deployments; the client does not disable certificate verification.

`DATABASE_URL` is required only for database use and migrations. `RECOUNT_DATABASE_POOL_MAX` accepts 1–100 connections and defaults to 10 **per application process**, including development module reloads. Connections wait at most five seconds, idle connections close after 30 seconds, and application statements have a 15-second timeout. Size the total pool budget across replicas against PostgreSQL's connection limit.

Import `getDatabase` from `src/db/client.server.ts` only inside server code. It returns a shared Drizzle client. `closeDatabase` drains the pool during controlled shutdown. The `.server.ts` boundary is enforced by TanStack Start in development and builds; route loaders are not inherently server-only.

### Change the schema

Define application tables through `appSchema` in `src/db/schema.ts`, then generate and review SQL:

```sh
just db-generate --name=describe_change
just db-check
just db-migrate
```

Commit the schema, generated SQL, snapshots and migration journal together. The initial migration creates the `app` namespace; authentication and domain tables are added with their features. Do not edit applied migrations or run schema push against deployed databases.

Drizzle is the sole migration authority for application tables, including those used from Rust. Use the same ordered migration directory and runner rather than a second Rust migration history. Run migrations once as a deployment step before application traffic, not per request or automatically from every web replica. The runner serializes concurrent jobs with a PostgreSQL advisory lock, uses Drizzle's migration transaction/history, and closes its dedicated connection. Migration statements have a 60-second timeout and lock acquisition a 10-second timeout. Large future migrations may need a deliberately revised execution policy.

### Test database changes

```sh
just test-web
TEST_DATABASE_URL=postgresql://recount:YOUR_GENERATED_PASSWORD@127.0.0.1:15432/recount just test-db
```

The integration suite requires a PostgreSQL account with permission to create databases. It creates uniquely named temporary databases and removes only those databases afterward; it does not reset the database named in the URL. Tests cover fresh/repeated migrations, concurrent migration jobs, and recovery after failed DDL. CI runs the suite against PostgreSQL. Do not use production credentials for tests.

## Authentication and email

Better Auth provides PostgreSQL-backed sessions, passkeys and six-digit email codes. Password authentication is disabled. Codes expire after five minutes, are stored hashed and allow three attempts. Registration follows `RECOUNT_AUTH_ALLOW_SIGN_UP`; closed-registration requests receive the same public acknowledgement for known and unknown addresses. Recovery proves mailbox access; it does not automatically remove existing passkeys or other sessions. Account settings provide both actions.

Set these server-only values in `apps/web/.env` before using authentication:

| Setting                      | Value                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`         | At least 32 random characters; generate with `openssl rand -hex 32`. Keep stable across restarts and replicas.             |
| `BETTER_AUTH_URL`            | Public application origin, such as `https://telemetry.example.com`. Use `http://localhost:3001` locally.                   |
| `RECOUNT_AUTH_ALLOW_SIGN_UP` | Explicitly `true` or `false`. With `false`, existing users can sign in but unknown email addresses cannot create accounts. |
| `SMTP_HOST`                  | SMTP server; `smtp.resend.com` for Resend.                                                                                 |
| `SMTP_PORT`                  | `465` for implicit TLS, or the provider's STARTTLS port, commonly `587`.                                                   |
| `SMTP_USER`                  | SMTP username; `resend` for Resend.                                                                                        |
| `SMTP_PASSWORD`              | SMTP credential supplied by the email provider.                                                                            |
| `EMAIL_FROM`                 | A sender address on a domain verified with the provider.                                                                   |

Run `just db-migrate` before starting the application. For a new installation, enable registration to create the first account, then disable it if public registration is not wanted. Organization invitations do not bypass closed registration; an unknown invited user still needs registration enabled to create an account. There is no administrator backdoor or default user.

SMTP delivery requires TLS with certificate validation. Delivery failures do not create a browser session or expose SMTP errors to the browser. Keep SMTP credentials out of source, client environment variables and logs. Templates and HTML/plain-text rendering live in [the transactional package](../../packages/transactional/README.md); the web application owns SMTP delivery. Run `just email-dev` to preview templates at `http://localhost:3002` without sending mail.

Code delivery runs through Better Auth's background-task handler so HTTP responses do not wait for SMTP. The process owns pending deliveries; Vite development/restart and preview shutdown hooks drain the same registry, with a 30-second shutdown bound. Test factories expose `auth.emailDelivery.drain()`. A successful request acknowledges acceptance, not inbox delivery. This is graceful-process handling, not durable delivery after a crash or forced termination; other hosts must integrate the exported drain lifecycle before shutdown.

Authentication uses Better Auth and TanStack Start's standard error handling and logging. Failed session lookups remain errors rather than signed-out results. Dependency diagnostics may contain sensitive details; restrict access to logs and do not add email codes, code hashes, session tokens or SMTP credentials to diagnostics.

`/api/auth/$` mounts Better Auth's handler. The pathless `_app` route reads identity through `getCurrentUser` and shares it with account and workspace routes through context. Private server functions must independently validate the current session and resource permissions; route guards are not authorization. Session lookups are database-backed without a cookie cache, so revocation takes effect on the next protected request. Authentication responses, identity reads and private HTML use `private, no-store`. Email-code and passkey sign-in and logout clear private identity caches, then invalidate route state before typed navigation. Request limiting uses PostgreSQL so application instances share counters; production proxies must strip untrusted forwarding headers and supply the correct client IP. Origin and CSRF checks remain enabled.

Changing passkeys, 2FA or active sessions requires authentication within the last ten minutes. Viewing active sessions only requires a valid verified session and returns a token-free projection. Sensitive actions use the shared `useStepUpAuthentication` popup before submitting; server-side freshness and authorization checks remain authoritative. HTTPS is required outside localhost; the passkey relying-party ID is the hostname in `BETTER_AUTH_URL`. Changing that hostname affects which passkeys can be used. Granular organization/project/execution permissions are separate from authentication and are not granted by an account session.

`/api/reauthentication` binds verification to the currently signed-in account and delegates credential checks to Better Auth. A user-verified passkey completes verification directly. Email codes require the authenticator or a recovery code when 2FA is enabled. The existing browser session stays valid while a challenge is pending; only successful complete verification delivers a fresh session cookie. Tokens never enter the popup response body. Navigation, cancellation or an account change cannot resume a pending sensitive action, and uncertain verification is reconciled rather than automatically retried.

`src/db/auth-schema.ts` is application-maintained, including the membership constraints used by project access. Update it alongside Better Auth plugin/configuration changes, using the same Drizzle generate → review → migrate workflow as other application tables. Do not run Better Auth's separate migration command.

`just test-db` includes authentication regressions for registration controls, single-use/expired codes, session revocation, origin checks, shared rate limits and recent-authentication enforcement. Actor fixtures use trusted server APIs and explicitly drain captured mail; HTTP throttle/privacy tests remain separate.

## Organizations and projects

Sign in at `/login`; `/` restores the last authorized project, or shows onboarding when no project is accessible. Verified users can create organizations through Better Auth. Projects are private by default, with explicit viewer/member/admin memberships and organization owner/admin access. Start server functions provide scoped CRUD, project grants and native organization invitation operations. Invitation emails use the existing SMTP settings and link to `/invitations/$invitationId`, where verified recipients explicitly accept or reject. See [organizations and project access](../../docs/application-access.md) for invitation contracts, permissions, resend behavior and database invariants.

Routes use stable organization and project IDs, not editable names or slugs:

| Route                                                                        | Purpose                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `/organizations/new`                                                         | Organization onboarding                             |
| `/organizations/$organizationId`                                             | Last authorized project, or project onboarding      |
| `/organizations/$organizationId/projects/new`                                | Project onboarding for organization owners/admins   |
| `/settings?section=SECTION&organizationId=ORG&projectId=PROJECT`             | Scoped account, organization and project settings   |
| `/organizations/$organizationId/projects/$projectId/executions`              | Authorized execution list and recording creation    |
| `/organizations/$organizationId/projects/$projectId/activity`                | Individual stored metric points                     |
| `/organizations/$organizationId/projects/$projectId/activity/live`           | Accepted raw telemetry packets                      |
| `/organizations/$organizationId/projects/$projectId/executions/$executionId` | Recorded source/host interval and node telemetry    |
| `/invitations/$invitationId`                                                 | Explicit invitation review, acceptance or rejection |

Organization and project selectors use searchable menus with selected-item checkmarks, organization roles and creation actions at the end of each list. Header plus buttons and list creation actions open the same top-aligned popup without navigating away. The project section's invitation action opens the shared organization invitation popup. Creating a resource preserves the current selection; choosing a different resource changes it explicitly.

A bounded per-account cookie remembers the last organization and each recently used project. This cookie is an untrusted preference, never an authorization source. Workspace reads recheck canonical memberships and project grants before restoring selection. Revoked preferences fall back to an accessible project; an explicitly inaccessible URL remains not-found. Settings retain project context even when an optional scope is absent from the URL. Successful mutations invalidate Router-owned metadata so names and selectors refresh together.

Organization owners and admins can rename their organization in settings. Destructive organization/project deletion remains unavailable pending safe cross-store cleanup. Member administration uses native Better Auth memberships; project grants do not reduce implicit organization owner/admin access. Follow [collector setup](../../docs/collector-setup.md) to enroll a source and safely rotate its token.

### Test workspace navigation

```sh
cd apps/web
bunx playwright install chromium
TEST_DATABASE_URL=postgresql://recount:YOUR_TEST_PASSWORD@127.0.0.1:15439/recount bun run test:browser
```

Browser tests create a unique disposable database per test, apply the committed Drizzle migrations and start a private server on port 3554 plus the worker's parallel index. Set `RECOUNT_BROWSER_PORT` to choose another base port; reserve consecutive ports when using multiple workers. Build first and set `RECOUNT_BROWSER_BUILT=true` to run Nitro's generated `.output/server/index.mjs` instead of development mode; built tests do not use Vite preview. Each test closes its browser context before draining the application and attaches numeric setup/teardown timings as `workspace-timings`. Sign-in codes are captured in memory; invitation recovery cases use a failing loopback-only SMTP endpoint, never real delivery. The suite covers onboarding, forms, roles, mutation refresh, tenant switching, revocation, invitation decisions, one-time secrets and execution recordings. Artifacts are written under the operating system's temporary `opencode/recount/browser` directory, outside the repository. Use only a disposable PostgreSQL test account with database-creation permission.

## Activity

Activity has two project-authorized views. Explorer reads individual points from ClickHouse, with a fixed one-hour interval and 100-row keyset pages; it does not aggregate or downsample. Expanded rows show measurement values, typed attributes, resources, instrumentation, connection diagnostics, provenance and the stored JSON representation. Decimal strings preserve 64-bit integers; JSON integration encodes binary values as base64 and sample/stream IDs as hexadecimal.

Live uses native `EventSource` and the authenticated `/api/activity/live` server route. The web application connects to the internal `RECOUNT_LIVE_GATEWAY_URL` using `RECOUNT_LIVE_GATEWAY_SECRET` (at least 32 random characters). The gateway alone receives server-only `RECOUNT_ACTIVITY_KAFKA_BROKERS`, `RECOUNT_RAW_TOPIC`, `RECOUNT_LIVE_TOPIC` (default `recount.metrics.live`) and `RECOUNT_LIVE_PARTITIONS` (default 8). Native development runs `bun run --cwd apps/web live` alongside the web application; configure matching gateway settings and provision the topic first. Missing Live configuration does not disable Explorer.

Ingestion publishes a small `LiveNotification` only after Kafka confirms the raw packet. Notifications contain summary counts, bounded node identities/timestamps and the raw partition/offset, never the OTLP payload or network inventory. SHA-256 of the project ID, using the first four bytes as a big-endian integer modulo the fixed partition count, selects its shard. The gateway shares one ephemeral Kafka reader per active shard across viewers and web instances, never commits offsets, and never joins normalizer or storage groups. Empty shards have no reader. Each connection starts at its shard's current high watermark, including when joining an active reader. Reconnects start fresh and intentionally skip the disconnected interval; SSE event IDs and replay cursors are not used.

The gateway keeps active subscriptions and bounded transport buffers, not packet history. The browser retains at most 100 summaries from the last five minutes. Counts cover this connection's retained summaries, not a global fleet audit, and may be lower bounds. Recently reporting nodes require both recent receipt and a measurement timestamp within the last minute, with 30 seconds of future-clock tolerance. Sender clocks affect freshness, and queued old data does not establish that a node is online. Slow clients disconnect instead of growing an unbounded queue. Ten-second heartbeats keep idle streams active and trigger canonical session/project checks.

All list and detail operations independently recheck canonical project access before reading either store. Packet inspection fetches the referenced raw Kafka record on demand, checks its trusted project and packet ID, and works after gateway/web restarts until raw retention removes it. Reads target one partition/offset, are concurrency-limited and never cache full packets in the gateway. Cache keys include the account and project, and account changes clear private Query data. Pause freezes only the displayed snapshot; SSE, collection and ingestion continue. Availability failures do not erase a paused snapshot, but explicit access/session failures hide it. Filters remain disabled; reload, pagination, column visibility, inspection and copying work without a general query engine.

Deploy one shared gateway for the web replicas. Additional independent gateways duplicate shard reads; dividing shard ownership requires explicit connection routing rather than joining them to one consumer group. The internal endpoint has no public port in Compose. Notification publication continues without viewers and uses a separate bounded producer/queue. It is best effort: queue pressure, notification failures or gateway outages cannot reject confirmed raw telemetry. Live is not an exhaustive delivery audit. Notification retention defaults to five minutes/16 MiB per partition; cleanup is asynchronous. Project creation never provisions topics. Run `just local live-topic-create` once to add the notification topic to an existing stack without changing raw/analytical topics. The gateway verifies the exact shard count on startup; do not resize it underneath producers/readers.

The JSON inspector uses `react-json-view-lite` with Tide/shadcn theme tokens and keyboard-accessible expansion. Large payload previews are explicitly truncated. The full interface inventory is available on recent raw packets; stored point lineage contains compact connection and matching-interface context rather than every interface. Reported network addresses are diagnostics, not enrollment or authentication evidence.

Vite and web checks generate server-side codecs from the current shared Rust descriptors and the pinned OpenTelemetry descriptor set. Generation requires the host Rust toolchain, uses the invoking Cargo build configuration and caches only immutable descriptor inputs. Generated files are ignored; no Rust compiler runs in the web image. The build also bundles the standalone gateway into `.output/live/index.mjs`; both processes use the same runtime image. Active streams and Kafka clients close with their owning process.

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.

Use `TimeDisplay` from `components/time-display.tsx` for UI timestamps, with `full`, `compact` or `relative` presentation. Its keyboard-, touch- and hover-accessible popover compares the same instant in the device zone, selected project zone, UTC and Unix seconds, with per-value copying. The settings link opens that project's Customization page at the time-zone control. Without a selected project, project conversion and settings are omitted. The root provider resolves the device zone after hydration; the application shell supplies the authorized project context.

`TimeDisplayRange` renders execution intervals without flattening interactive timestamps into translation strings. Telemetry's raw nanosecond values retain their original label and exact Unix precision; formatted calendar conversions use millisecond precision. Durations, editable time inputs, CSV output and email timestamps remain in their own formats. The main content box owns the desktop sidebar boundary; its left edge highlights for hover, drag and keyboard focus without a second sidebar border.

Recount uses the Tide Core light and dark tokens with system Helvetica fallbacks. The root shell reads `recount_theme` for SSR and renders `data-variant="core"` with `data-theme="tide"` or `"tide-dark"`. Footer controls retain localized labels and confirmation behavior; mode changes preserve active forms and one-time tokens. Brand assets and their clearspace guide are in `public/brand`.

Login leads with email and keeps an explicit passkey option. Modern browsers can offer saved passkeys through conditional autofill; manual sign-in uses the supported WebAuthn conversion helper on browsers without native JSON conversion. Capability detection does not establish that a matching passkey exists. Options requests and native ceremonies are cancellable. Submitted verification is not aborted by navigation: ownership, authoritative session reconciliation and private-cache clearing survive the Login component. Recovery requires a new, fresh server session relative to the pre-submit baseline; an existing same-email session is not reauthentication.

## Execution analytics

Apply the committed Drizzle migrations for execution metadata, then configure the read-only ClickHouse endpoint and password from `.env.example`. Follow [local stack setup](../../infra/README.md) and [execution/query semantics](../../docs/execution-telemetry.md). No Python query runtime or local analytical files are required.

For daily iteration, run the Bun reader tests and standard Node Playwright runner on the host against the reused backend. Use explicitly allocated test credentials and isolated database/project namespaces. The separate Linux-container collector-to-browser gate requires host-built `recount-collector`, `recount-ingestion-api` and `recount-normalizer` Linux binaries matching Docker's architecture. It never invokes a container compiler or a direct storage writer.

Follow the [execution gate configuration](../../docs/execution-telemetry.md#reader-configuration-and-checks) before enabling `RECOUNT_PIPELINE_TEST=true`. Allocate the topics, networks, native consumer and restricted database access explicitly. Any restart check must target only the allocated disposable ClickHouse container, never a shared service. When Playwright runs in Docker, its Docker CLI/socket and nested bind mounts must resolve to the same absolute host paths. The gate intercepts authentication email and cleans up only its own application containers and random database. Use a unique Playwright `--output` directory when other agents run browser tests.
