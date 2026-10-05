# PFE Telemetry

Monorepo for the distributed execution telemetry project.

The [Final project plan](https://app.notion.com/p/3df859f630f78055b042e69a3ad6558b) defines the requirements.

See [architecture](docs/architecture.md), [ingestion server](docs/ingestion-server.md), [broker options](docs/broker-options.md), [serialization](docs/serialization.md), and [ingestion and reliability](docs/ingestion-and-reliability.md) for the design and validation scenarios.

## Repository layout

```text
apps/
  web/                  TanStack Start web application with SSR
  collector/            Rust collector scaffold
  server/               Tonic OTLP ingestion server
crates/                 Shared Rust libraries
docs/                   Architecture, serialization, and reliability considerations
infra/
  test-environment/     Vagrant VMs, ingestion server, Grafana, and workload playbooks
tests/                  Cross-component validation scenarios
```

## Development setup

All contributors need [Bun](https://bun.sh/) 1.4.2 (pinned in `.bun-version`), [just](https://just.systems/) 1.58.0, [uv](https://docs.astral.sh/uv/getting-started/installation/) 0.12.23, and [Rust through rustup](https://www.rust-lang.org/tools/install). The Rust toolchain is pinned in `rust-toolchain.toml`. uv installs the Python version pinned in `.python-version` for Ansible.

```sh
just setup
```

This installs locked dependencies, installs Lefthook's Git hooks, checks the Rust workspace, and copies missing `.env` files from the component examples. It preserves existing `.env` files. Hooks use the locked Lefthook dependency through Bun. Use `just hooks-install` to reinstall hooks in a checkout.

Bun manages the web workspace and shared web tooling. Cargo manages Rust packages. uv manages Ansible for the test environment. Use the root lockfiles; do not create component lockfiles.

## Run components

```sh
just dev
just build
just typecheck
just server
```

See [the web README](apps/web/README.md) for development and configuration and [the server README](apps/server/README.md) for the OTLP receiver and health checks.

```sh
just env up
just env verify
just env stop
```

`just env` lists the environment commands and loads the optional, ignored `infra/test-environment/.env`. Use that file for VM resource settings and ports. VirtualBox preferences control VM storage. `apps/web/.env` controls the web development port (3001 by default). See [the test environment README](infra/test-environment/README.md) for VM prerequisites, networking, and cleanup. The web application runs independently of the environment; telemetry queries are not implemented.

After `just env up`, [Grafana](http://localhost:3003/d/node-exporter-full/node-exporter-full) displays live Linux metrics from both VMs using Alloy, Prometheus, and the prebuilt Node Exporter Full dashboard.

## Checks and formatting

| Files                 | Commit checks                            | Formatter              |
| --------------------- | ---------------------------------------- | ---------------------- |
| TypeScript, JSON, CSS | Biome lint, import order, and formatting | Biome                  |
| Markdown and YAML     | Prettier formatting                      | Prettier               |
| Rust                  | Cargo workspace formatting               | rustfmt                |
| Vagrantfile           | Ruby syntax                              | Manual Ruby formatting |
| Ansible playbooks     | Syntax and YAML formatting               | Prettier               |
| justfile              | Formatting                               | just                   |

The commit hook selects checks by staged file type. Rust formatting checks the entire Cargo workspace. Hooks read the working tree without modifying or staging files, so unstaged edits in a partially staged file can produce a diagnostic. Generated routes, build artifacts, dependencies, and VM state are excluded.

The push hook runs web type checking when web files change and Clippy when Rust files or manifests change.

```sh
just check
just test
just format
just lint-fix
```

`format` formats repository files. `lint-fix` applies safe Biome fixes. Format the Vagrantfile manually. Repository lint and format commands are defined in the justfile; the root Bun scripts delegate to them. Use `just --list` for component checks and commands.

CI checks formatting, linting, the web build, Rust tests, Ansible syntax, and Compose configuration. It caches Bun downloads, Cargo dependencies, and uv packages. VM provisioning and connectivity checks run locally.

## Adding components

Add TypeScript applications or packages to the root Bun workspace. Add Rust packages to the root Cargo workspace and inherit the workspace edition, version, and lint settings. Put shared Rust libraries under `crates`.

Unit tests belong to the component they exercise. Cross-component tests and performance experiments belong under `tests`; machine provisioning belongs under `infra/test-environment`.
