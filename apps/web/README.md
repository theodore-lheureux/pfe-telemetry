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

Passkey registration and changes require authentication within the last ten minutes. HTTPS is required outside localhost; the passkey relying-party ID is the hostname in `BETTER_AUTH_URL`. Changing that hostname affects which passkeys can be used. Granular organization/project/execution permissions are separate from authentication and are not granted by an account session.

`src/db/auth-schema.ts` is application-maintained, including the membership constraints used by project access. Update it alongside Better Auth plugin/configuration changes, using the same Drizzle generate → review → migrate workflow as other application tables. Do not run Better Auth's separate migration command.

`just test-db` includes authentication regressions for registration controls, single-use/expired codes, session revocation, origin checks, shared rate limits and recent-authentication enforcement. Actor fixtures use trusted server APIs and explicitly drain captured mail; HTTP throttle/privacy tests remain separate.

## Organizations and projects

Sign in at `/login`, then choose or create an organization at `/`. Verified users can create organizations through Better Auth. Projects are private by default, with explicit viewer/member/admin memberships and organization owner/admin access. Start server functions provide scoped CRUD, project grants and native organization invitation operations. Invitation emails use the existing SMTP settings and link to `/invitations/$invitationId`, where verified recipients explicitly accept or reject. See [organizations and project access](../../docs/application-access.md) for invitation contracts, permissions, resend behavior and database invariants.

Routes use stable organization and project IDs, not editable names or slugs:

| Route                                                                        | Purpose                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `/organizations/new`                                                         | Create an organization                                    |
| `/organizations/$organizationId`                                             | Visible projects and project creation link                |
| `/organizations/$organizationId/projects/new`                                | Create a private project as organization owner/admin      |
| `/organizations/$organizationId/settings`                                    | Read-only organization metadata                           |
| `/organizations/$organizationId/members`                                     | Native membership and invitation administration           |
| `/organizations/$organizationId/projects/$projectId/executions`              | Authorized execution list and recording creation          |
| `/organizations/$organizationId/projects/$projectId/executions/$executionId` | Recorded source/host interval and node telemetry          |
| `/organizations/$organizationId/projects/$projectId/settings`                | Project metadata; effective admins can rename the project |
| `/organizations/$organizationId/projects/$projectId/settings/members`        | Explicit project grants for effective admins              |
| `/organizations/$organizationId/projects/$projectId/settings/credentials`    | Collector credential lifecycle and setup                  |

The project base URL redirects to its execution page. Organization and project switchers use native selects with explicit switch buttons. Parent `beforeLoad` reads refresh canonical access when navigating between child pages. Failed or revoked reads do not become empty project lists; inaccessible resources return the same not-found page. Successful mutations invalidate Router-owned metadata so names and switchers refresh together.

Organization renaming and deletion are not exposed by these pages. Member administration uses native Better Auth memberships; project grants do not reduce implicit organization owner/admin access. Follow [collector setup](../../docs/collector-setup.md) to enroll a source and safely rotate its token.

### Test workspace navigation

```sh
cd apps/web
bunx playwright install chromium
TEST_DATABASE_URL=postgresql://recount:YOUR_TEST_PASSWORD@127.0.0.1:15439/recount bun run test:browser
```

Browser tests create a unique disposable database per test, apply the committed Drizzle migrations and start a private server on port 3554 plus the worker's parallel index. Set `RECOUNT_BROWSER_PORT` to choose another base port; reserve consecutive ports when using multiple workers. Build first and set `RECOUNT_BROWSER_BUILT=true` to run Nitro's generated `.output/server/index.mjs` instead of development mode; built tests do not use Vite preview. Each test closes its browser context before draining the application and attaches numeric setup/teardown timings as `workspace-timings`. Sign-in codes are captured in memory; invitation recovery cases use a failing loopback-only SMTP endpoint, never real delivery. The suite covers onboarding, forms, roles, mutation refresh, tenant switching, revocation, invitation decisions, one-time secrets and execution recordings. Artifacts are written under the operating system's temporary `opencode/recount/browser` directory, outside the repository. Use only a disposable PostgreSQL test account with database-creation permission.

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.

Recount uses the Tide Core light and dark tokens with system Helvetica fallbacks. The root shell reads `recount_theme` for SSR and renders `data-variant="core"` with `data-theme="tide"` or `"tide-dark"`. Footer controls retain localized labels and confirmation behavior; mode changes preserve active forms and one-time tokens. Brand assets and their clearspace guide are in `public/brand`.

Login leads with email and keeps an explicit passkey option. Modern browsers can offer saved passkeys through conditional autofill; manual sign-in uses the supported WebAuthn conversion helper on browsers without native JSON conversion. Capability detection does not establish that a matching passkey exists. Options requests and native ceremonies are cancellable. Submitted verification is not aborted by navigation: ownership, authoritative session reconciliation and private-cache clearing survive the Login component. Recovery requires a new, fresh server session relative to the pre-submit baseline; an existing same-email session is not reauthentication.

## Execution analytics

Apply the committed Drizzle migrations for execution metadata, then configure the read-only ClickHouse endpoint and password from `.env.example`. Follow [local stack setup](../../infra/README.md) and [execution/query semantics](../../docs/execution-telemetry.md). No Python query runtime or local analytical files are required.

For daily iteration, run the Bun reader tests and standard Node Playwright runner on the host against the reused backend. Use explicitly allocated test credentials and isolated database/project namespaces. The separate Linux-container collector-to-browser gate requires host-built `recount-collector`, `recount-ingestion-api` and `recount-normalizer` Linux binaries matching Docker's architecture. It never invokes a container compiler or a direct storage writer.

Follow the [execution gate configuration](../../docs/execution-telemetry.md#reader-configuration-and-checks) before enabling `RECOUNT_PIPELINE_TEST=true`. Allocate the topics, networks, native consumer and restricted database access explicitly. Any restart check must target only the allocated disposable ClickHouse container, never a shared service. When Playwright runs in Docker, its Docker CLI/socket and nested bind mounts must resolve to the same absolute host paths. The gate intercepts authentication email and cleans up only its own application containers and random database. Use a unique Playwright `--output` directory when other agents run browser tests.
