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

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.
