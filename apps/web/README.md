# Web application

TanStack Start with SSR, TanStack Query, TanStack Form, React, TypeScript, Tailwind CSS, and shadcn/ui.

## Development

Run these commands from the repository root with the Bun version in `.bun-version`:

```sh
bun install --frozen-lockfile
just config
just dev
```

Open the URL printed by Vite (port 3001 by default). Set `WEB_PORT` in `apps/web/.env` or use `just dev --port 3002` to change the port.

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
- `src/styles.css`: Tailwind imports and theme variables.

`getRouter` creates a QueryClient for each server request. The SSR integration supplies the provider and transfers cached data to the browser. Organization and project metadata use Router context, not Query. Router reads revalidate with blocking reloads, and inactive matches and preloads have zero retention. Future Query data should keep keys and functions together with `queryOptions` and choose explicit freshness settings.

Start's default server supports streaming SSR. Await authentication and other critical data before rendering; fetch slower secondary data without blocking the loader and render it under Suspense through the Query SSR integration. Current account routes do not have deferred data. Shared loading/error/not-found components provide route feedback, and the root document remains outside those boundaries through `shellComponent`. Verify that the production host and proxy preserve streamed responses before relying on progressive delivery.

TanStack Start server functions handle browser-facing reads and mutations. The Rust server handles collector ingestion.

## Application database

PostgreSQL stores transactional application data. Telemetry ingestion and analytical storage remain separate. The database client is lazy: building the web application does not require a running database or credentials.

### Start PostgreSQL locally

Run `just config`, generate a password with `openssl rand -hex 32`, and set it as `POSTGRES_PASSWORD` in `infra/application/.env`. Put the same password in `DATABASE_URL` in `apps/web/.env`:

```text
DATABASE_URL=postgresql://pfe:YOUR_GENERATED_PASSWORD@127.0.0.1:15432/pfe
DATABASE_POOL_MAX=10
```

Then run:

```sh
just app up
just db-migrate
just dev
```

`just app stop` preserves the database volume. The local PostgreSQL bootstrap account owns the database and is for development only. Production deployments must provision restricted runtime credentials separately from schema-management credentials. Configure transport security in the PostgreSQL connection URL for remote deployments; the client does not disable certificate verification.

`DATABASE_URL` is required only for database use and migrations. `DATABASE_POOL_MAX` accepts 1–100 connections and defaults to 10 **per application process**, including development module reloads. Connections wait at most five seconds, idle connections close after 30 seconds, and application statements have a 15-second timeout. Size the total pool budget across replicas against PostgreSQL's connection limit.

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
TEST_DATABASE_URL=postgresql://pfe:YOUR_GENERATED_PASSWORD@127.0.0.1:15432/pfe just test-db
```

The integration suite requires a PostgreSQL account with permission to create databases. It creates uniquely named temporary databases and removes only those databases afterward; it does not reset the database named in the URL. Tests cover fresh/repeated migrations, concurrent migration jobs, and recovery after failed DDL. CI runs the suite against PostgreSQL. Do not use production credentials for tests.

## Authentication and email

Better Auth provides PostgreSQL-backed sessions, passkeys and email magic links. Password authentication is disabled. New users verify their email through a five-minute, single-use link, then add passkeys from `/account`. Email links also support sign-in and recovery when passkeys are lost. Recovery proves mailbox access; it does not automatically remove existing passkeys or other sessions. Account settings provide both actions.

Set these server-only values in `apps/web/.env` before using authentication:

| Setting              | Value                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | At least 32 random characters; generate with `openssl rand -hex 32`. Keep stable across restarts and replicas.             |
| `BETTER_AUTH_URL`    | Public application origin, such as `https://telemetry.example.com`. Use `http://localhost:3001` locally.                   |
| `AUTH_ALLOW_SIGN_UP` | Explicitly `true` or `false`. With `false`, existing users can sign in but unknown email addresses cannot create accounts. |
| `SMTP_HOST`          | SMTP server; `smtp.resend.com` for Resend.                                                                                 |
| `SMTP_PORT`          | `465` for implicit TLS, or the provider's STARTTLS port, commonly `587`.                                                   |
| `SMTP_USER`          | SMTP username; `resend` for Resend.                                                                                        |
| `SMTP_PASSWORD`      | SMTP credential supplied by the email provider.                                                                            |
| `EMAIL_FROM`         | A sender address on a domain verified with the provider.                                                                   |

Run `just db-migrate` before starting the application. For a new installation, enable registration to create the first account, then disable it if public registration is not wanted. Organization invitations do not bypass closed registration; an unknown invited user still needs registration enabled to create an account. There is no administrator backdoor or default user.

SMTP delivery requires TLS with certificate validation. Delivery failures do not create a browser session or expose SMTP errors to the browser. Keep SMTP credentials out of source, client environment variables and logs. Templates and HTML/plain-text rendering live in [the transactional package](../../packages/transactional/README.md); the web application owns SMTP delivery. Run `just email-dev` to preview templates at `http://localhost:3002` without sending mail.

`/api/auth/$` mounts Better Auth's handler. The pathless `_app` route reads identity through `getCurrentUser` and shares it with account and workspace routes through context. Private server functions must independently validate the current session and resource permissions; route guards are not authorization. Session lookups are database-backed without a cookie cache, so revocation takes effect on the next protected request. Authentication responses, identity reads and private HTML use `private, no-store`. Passkey sign-in and logout clear Query and inactive Router caches, then invalidate active route state before typed navigation. Email verification follows Better Auth's HTTP redirect. Request limiting uses PostgreSQL so application instances share counters; production proxies must strip untrusted forwarding headers and supply the correct client IP. Origin and CSRF checks remain enabled.

Passkey registration and changes require authentication within the last ten minutes. HTTPS is required outside localhost; the passkey relying-party ID is the hostname in `BETTER_AUTH_URL`. Changing that hostname affects which passkeys can be used. Granular organization/project/execution permissions are separate from authentication and are not granted by an account session.

`src/db/auth-schema.ts` is application-maintained, including the membership constraints used by project access. Update it alongside Better Auth plugin/configuration changes, using the same Drizzle generate → review → migrate workflow as other application tables. Do not run Better Auth's separate migration command.

`just test-db` includes authentication regressions for registration controls, single-use/expired links, session revocation, origin checks, shared rate limits and recent-authentication enforcement.

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
| `/organizations/$organizationId/projects/$projectId/executions`              | Empty execution shell; telemetry reads are not connected  |
| `/organizations/$organizationId/projects/$projectId/executions/$executionId` | Not-found placeholder for execution details               |
| `/organizations/$organizationId/projects/$projectId/settings`                | Project metadata; effective admins can rename the project |
| `/organizations/$organizationId/projects/$projectId/settings/members`        | Explicit project grants for effective admins              |
| `/organizations/$organizationId/projects/$projectId/settings/credentials`    | Collector credential lifecycle and setup                  |

The project base URL redirects to its execution page. Organization and project switchers use native selects with explicit switch buttons. Parent `beforeLoad` reads refresh canonical access when navigating between child pages. Failed or revoked reads do not become empty project lists; inaccessible resources return the same not-found page. Successful mutations invalidate Router-owned metadata so names and switchers refresh together.

Organization renaming and deletion are not exposed by these pages. Member administration uses native Better Auth memberships; project grants do not reduce implicit organization owner/admin access. Follow [collector setup](../../docs/collector-setup.md) to enroll a source and safely rotate its token.

### Test workspace navigation

```sh
cd apps/web
bunx playwright install chromium
TEST_DATABASE_URL=postgresql://pfe:YOUR_TEST_PASSWORD@127.0.0.1:15439/pfe bun run test:browser
```

Browser tests create a unique disposable database per test, apply the committed Drizzle migrations and start a private server on port 3554. Set `PFE_BROWSER_PORT` to use another available port. Build first and set `PFE_BROWSER_BUILT=true` to test the built SSR output instead of development mode. Sign-in links are captured in memory; invitation recovery cases use a failing loopback-only SMTP endpoint, never real delivery. The suite covers onboarding, forms, roles, mutation refresh, tenant switching, revocation, invitation decisions, one-time secrets and the empty execution shell. Artifacts are written under the operating system's temporary `opencode/pfe-overnight/pfe54-browser` directory, outside the repository. Use only a disposable PostgreSQL test account with database-creation permission.

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.

## Execution analytics

Apply the committed Drizzle migrations for execution metadata, then configure the read-only ClickHouse endpoint and password from `.env.example`. Follow [local telemetry setup](../../infra/telemetry/README.md) and [execution/query semantics](../../docs/execution-telemetry.md). No Python query runtime or local analytical files are required.

With disposable ClickHouse credentials, run `bun run --cwd apps/web test:telemetry`. The optional collector-to-browser test uses an isolated stack and built Linux binaries. Build its toolchain image from the repository root:

```sh
docker build --file apps/server/Dockerfile --target integration --tag pfe-telemetry-rust-integration:local .
```

Set `PFE_PIPELINE_TEST=true`, `PFE_BROWSER_PORT` to a free port, `TEST_DATABASE_URL`, and the three `TELEMETRY_CLICKHOUSE_*` test settings, then run `bun run --cwd apps/web test:browser execution-pipeline.spec.ts`. Its default test network/cache/image names are in the test; override the `PFE_PIPELINE_*` settings for another isolated setup, including `PFE_PIPELINE_DATABASE_NETWORK`, `PFE_PIPELINE_DATABASE_HOST` and `PFE_PIPELINE_DATABASE_PORT` for the isolated PostgreSQL service. Mount the worktree and an independent build cache into that image and run `cargo build --locked --workspace --bins` first, explicitly setting `CARGO_TARGET_DIR=/pfe20-target` with the same cache selected by `PFE_PIPELINE_TARGET_VOLUME`. The test intercepts authentication email and removes only its own containers and random database. Use a unique Playwright `--output` directory when other agents run browser tests.
