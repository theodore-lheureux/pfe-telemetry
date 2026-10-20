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

## Rust dependencies

- Check the registry for the latest stable release before adding or updating a dependency. Do not choose versions from memory or use prereleases without an explicit requirement.
- Use `cargo add`, `cargo remove` and `cargo update` to change dependencies and the lockfile. Do not edit dependency entries in `Cargo.toml` or `Cargo.lock` by hand.
- Preserve the required feature flags and target-specific dependency sections. Commit the generated `Cargo.lock` with dependency changes.
- Check existing dependencies for outdated versions during a dependency audit, including releases outside their current manifest requirements.
- Validate collector changes on Linux; macOS builds do not compile its Linux sampling and export paths.
