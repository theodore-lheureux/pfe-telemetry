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

## UI components

Add components from this directory:

```sh
cd apps/web
bun --bun run shadcn add input
```

`components.json` defines the theme and import aliases. Use the root Bun lockfile for dependency changes.
