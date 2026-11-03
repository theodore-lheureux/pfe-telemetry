# Web application

TanStack Start with SSR, TanStack Query, React, TypeScript, Tailwind CSS, and shadcn/ui.

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

- `src/routes/`: file routes and the HTML document.
- `src/router.tsx`: router context and TanStack Query SSR integration.
- `src/components/ui/`: shadcn/ui components.
- `src/lib/utils.ts`: class name utility.
- `src/styles.css`: Tailwind imports and theme variables.

`getRouter` creates a QueryClient for each server request. The SSR integration supplies the provider and transfers cached data to the browser. Route loaders access it through `context.queryClient`. Keep query keys and functions together with `queryOptions`; choose freshness settings for each query.

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

Run `just db-migrate` before starting the application. For a new installation, enable registration to create the first account, then disable it if public registration is not wanted. Invitation-based account creation is added with organization administration; there is no administrator backdoor or default user.

SMTP delivery requires TLS with certificate validation. Delivery failures do not create a browser session or expose SMTP errors to the browser. Keep SMTP credentials out of source, client environment variables and logs. Templates and HTML/plain-text rendering live in [the transactional package](../../packages/transactional/README.md); the web application owns SMTP delivery. Run `just email-dev` to preview templates at `http://localhost:3002` without sending mail.

`/api/auth/$` mounts Better Auth's handler. The account route reads its identity once through `getCurrentUser` and shares it through route context. Private server functions must independently validate the current session and resource permissions; route guards are not authorization. Session lookups are database-backed without a cookie cache, so revocation takes effect on the next protected request. Authentication responses, identity reads and account HTML use `private, no-store`. Passkey sign-in and logout invalidate route state before typed navigation. Email verification follows Better Auth's HTTP redirect. Request limiting uses PostgreSQL so application instances share counters; production proxies must strip untrusted forwarding headers and supply the correct client IP. Origin and CSRF checks remain enabled.

Passkey registration and changes require authentication within the last ten minutes. HTTPS is required outside localhost; the passkey relying-party ID is the hostname in `BETTER_AUTH_URL`. Changing that hostname affects which passkeys can be used. Granular organization/project/execution permissions are separate from authentication and are not granted by an account session.

`src/db/auth-schema.ts` is application-maintained, including the membership constraints used by project access. Update it alongside Better Auth plugin/configuration changes, using the same Drizzle generate → review → migrate workflow as other application tables. Do not run Better Auth's separate migration command.

`just test-db` includes authentication regressions for registration controls, single-use/expired links, session revocation, origin checks, shared rate limits and recent-authentication enforcement.

## Organizations and projects

Verified users can create organizations through Better Auth. Projects are private by default, with explicit Viewer/Member/Admin memberships and organization owner/admin access. Start server functions provide scoped CRUD and project-grant operations; navigation and invitation email flows are separate features. See [organizations and project access](../../docs/application-access.md) for the policy, interfaces and database invariants.

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.
