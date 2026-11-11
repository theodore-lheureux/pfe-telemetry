# Repository guidance

## Documentation

- Use practical English, consistent terminology and no meta-commentary.
- Before creating, reviewing or substantially editing repository Markdown, load and follow the [documentation skill](.agents/skills/documentation/SKILL.md). If skill discovery is unavailable, read that file directly.

## Development stage

- The project is in early development and prototyping, with no production deployments or real customers.
- Make breaking changes directly. Do not keep old APIs, configuration aliases, schema readers or migration code for previous prototypes.
- Every collector, ingestion, broker, storage and application boundary supports only its current data schema. Change affected producers, consumers, fixtures and documentation together; do not add dual reads/writes, format negotiation, backfills or conversion tools for discarded prototype schemas.
- Recreate incompatible disposable databases, broker topics, collector queues and fixtures instead of migrating their contents. Scope any cleanup to explicitly identified project/test state; never silently reset data on startup or delete unrelated state.
- Do not introduce separate version labels solely to distinguish earlier experiments. Use the current package version for instrumentation metadata.
- Keep support for current external protocols and integrations distinct from backward compatibility with our own prototypes.

## Iteration and test strategy

- Reuse one initialized Compose stack for PostgreSQL, Kafka and ClickHouse across development and test runs. Do not rebuild or recreate infrastructure for each retry.
- Run Playwright with the host's standard Node runner and the web application natively with Bun. Run the ingestion API and normalizer natively where supported; keep Linux collector sampling in reused Linux containers or existing VMs.
- Isolate tests with disposable databases, browser contexts, projects and explicit topic/group namespaces as needed. Preserve tenant/session isolation; do not reset shared checkpoints or data to make a test pass.
- Build host-supported crates and the web application on the host. Build, lint and test Linux-only code, such as the collector's sampling and export paths, in the reused Linux build container with named volumes for the Cargo registry and Linux target directory; do not recreate it per run or install a cross-toolchain for this loop.
- Treat Docker packaging, production-image smoke checks and the full pipeline as final validation gates rather than the default iteration loop. Release artifacts come from CI's native Linux runners.
- Optimize measured setup/teardown and parsing overhead, not coverage. Cache only immutable build metadata, close browser contexts and owned application resources, and keep security assertions and functional timeouts intact. Increase parallelism only after checking ports and resource pressure.
- Remove only identified obsolete project containers when cleanup is authorized. Preserve volumes, images, networks, unrelated services and user state unless their removal is explicitly requested; never use a global prune as test cleanup.
- Keep shared tooling, CI and documentation independent of a contributor's machine. Put absolute paths, disk/mount layouts, local network allocations and tool installation paths in ignored local configuration. Use Docker named volumes by default and select artifact architecture from the build target, not the developer's CPU.

## Frontend

- Prefer appropriate shadcn/ui components using the existing `apps/web/components.json` configuration. When a needed component is missing, add it with the shadcn CLI instead of hand-building an equivalent; the shadcn MCP server configured in `.mcp.json` and `opencode.json` searches the registry and its examples. Keep native form semantics, typed Router links and accessible async confirmation behavior.
- Before writing a component or helper, look for an existing one across the web application and extend or share it rather than duplicating it. Split pages into focused components and hooks; a file that mixes several views, data loading and table definitions should be divided.
- Support English and French throughout the UI and transactional emails with shared compiled catalogs and locale-aware formatting. Resolve locale per request; pass email locale explicitly. Keep technical identifiers, commands and protocol values unchanged.
- Position form dialogs near the top of the viewport, with responsive width and scrollable content. Avoid repeating the same information in the title, description, field label and action: simple single-field dialogs need one clear title, an accessible field label (visually hidden when redundant), and concise Cancel/Save actions. Add descriptions only when they explain a constraint or consequence.
- Build dialog buttons with `DialogActions` or `AlertDialogActions` from `apps/web/src/components/dialog-actions.tsx`: an outline cancel comes first and the confirming action last. Stack alternative full-width actions with `ActionStack`, and keep a field's label and input in their own group. Biome rejects hand-built dialog footers.

## Naming

- Use Recount for product names, `recount` for owned package/binary/protocol namespaces and `RECOUNT_` for product-specific environment controls. Prefer descriptive role names such as ingestion API, normalizer, collector and web application over generic server or storage worker.
- Rename owned identifiers and their producers, consumers, fixtures, configuration and documentation together. Keep no old-name aliases. Preserve standard external protocol identifiers, valid external issue/repository references and Git history; do not invent replacement URLs or rename external resources as a source-code cleanup.

## Agent coordination

- Use separate linked worktrees for implementation agents so their changes remain isolated. Keep personal launcher and pane-management preferences in local instructions.
- Use regular subagents for reviews when needed. Present each ticket's changes in Plannotator for approval before committing; do not push or merge without authorization.

## Comments and tests

- Comment only non-obvious intent, constraints or safety requirements. Do not restate names, standard tool behavior or implementation steps.
- Retain tests that protect application behavior, security boundaries or failure-prone integration logic. Avoid redundant cases and tests of dependency internals; exploratory checks need not remain in the repository.

## TanStack Start

- Route loaders and components are isomorphic. Put privileged reads and mutations in server functions or server routes, with credentials and database access in `.server.ts` modules.
- Share UI identity through route context instead of repeating session RPCs. Independently authorize every private server operation; route context and `beforeLoad` guards are not access-control boundaries.
- Use typed Router navigation and invalidate the owner of changed state: Router context/loaders, Query data or Better Auth stores. Clear private Query data on account changes when such data exists. Keep protocol redirects and raw HTTP responses in HTTP handlers; use redirects, ordinary errors or typed results for application RPCs.
- Create a QueryClient inside `getRouter`, never at module scope. The SSR integration supplies its provider, hydration and streaming; do not duplicate them. Process-wide database pools must not hold request-specific session data.
- Await authentication, authorization and critical page data. Defer only secondary data under Suspense, with handled query rejections and explicit freshness settings. Do not add artificial streaming examples to product routes. Verify streaming through the production host/proxy.
- Keep the HTML document in the root `shellComponent` so shared pending/error/not-found UI retains the document shell. Add shared helpers, middleware or protected layouts when repeated use justifies them, not preemptively.
- Preserve `Date` values in internal application RPC responses using Start's native serialization. Convert to ISO strings only at text or JSON integration boundaries, such as URLs, HTML attributes and worker payloads.
- Check [Start's documentation](https://tanstack.com/start/latest/docs/framework/react/overview) against installed package APIs before applying rolling-documentation examples.

## Database schemas

- Auth and application Drizzle schemas are application-maintained. Update auth configuration and tables together; Drizzle owns the generate → review → migrate workflow and committed migration history.
- Drizzle schema initialization and committed migration history are not prototype compatibility layers. Do not add data-preserving upgrade/backfill paths for discarded prototypes; unpublished experimental migrations may be regenerated before commit, with affected disposable databases recreated.
- Preserve application constraints when adding or upgrading Better Auth plugins; do not automatically regenerate the auth schema or introduce a second migration runner.

## Access control

- Follow [organization and project access](docs/application-access.md). Projects are private except for explicit project members and organization owners/admins; project read access includes all executions.
- Use Better Auth's canonical memberships. Preserve tenant-qualified keys and the transactional owner guard when changing schemas; the guard counter is not an authorization source.

## Rust imports

- Keep `use` declarations at the top of their enclosing module. Put test-only imports in the test module and preserve platform gates. Use local imports only when narrower scope provides a clear benefit; prefer descriptive aliases for conflicting names.

## Rust dependencies

- Check the registry for the latest stable release before adding or updating a dependency. Do not choose versions from memory or use prereleases without an explicit requirement.
- Use `cargo add`, `cargo remove` and `cargo update` to change dependencies and the lockfile. Do not edit dependency entries in `Cargo.toml` or `Cargo.lock` by hand.
- Preserve the required feature flags and target-specific dependency sections. Commit the generated `Cargo.lock` with dependency changes.
- Check existing dependencies for outdated versions during a dependency audit, including releases outside their current manifest requirements.
- Validate collector changes on Linux; macOS builds do not compile its Linux sampling and export paths.

## Local build configuration

- Preserve ignored `.cargo/config.toml` and explicit `CARGO_TARGET_DIR` settings. Shared code and CI must not prescribe or overwrite a machine-local cache path.
- Use `cargo metadata --no-deps --format-version 1` or Cargo's compiler-artifact JSON to discover outputs rather than assuming `target/`. Cross-build configuration belongs to the invoking environment.
- Do not run `cargo clean` or delete build caches without permission; other checkouts may use them.
