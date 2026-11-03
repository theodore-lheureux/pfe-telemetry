# Repository guidance

## Documentation

- Use practical English, consistent terminology and no meta-commentary.
- Before creating, reviewing or substantially editing repository Markdown, load and follow the [documentation skill](.agents/skills/documentation/SKILL.md). If skill discovery is unavailable, read that file directly.

## Development stage

- The project is in early development and prototyping, with no production deployments.
- Make breaking changes directly. Do not keep old APIs, configuration aliases, schema readers or migration code for previous prototypes.
- Update affected callers, fixtures and documentation together. Recreate disposable test state when a format change requires it.
- Do not introduce separate version labels solely to distinguish earlier experiments. Use the current package version for instrumentation metadata.
- Keep support for current external protocols and integrations distinct from backward compatibility with our own prototypes.

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
- Check [Start's documentation](https://tanstack.com/start/latest/docs/framework/react/overview) against installed package APIs before applying rolling-documentation examples.

## Rust dependencies

- Check the registry for the latest stable release before adding or updating a dependency. Do not choose versions from memory or use prereleases without an explicit requirement.
- Use `cargo add`, `cargo remove` and `cargo update` to change dependencies and the lockfile. Do not edit dependency entries in `Cargo.toml` or `Cargo.lock` by hand.
- Preserve the required feature flags and target-specific dependency sections. Commit the generated `Cargo.lock` with dependency changes.
- Check existing dependencies for outdated versions during a dependency audit, including releases outside their current manifest requirements.
- Validate collector changes on Linux; macOS builds do not compile its Linux sampling and export paths.
