# Recount

Monorepo for the distributed execution telemetry project.

The [Final project plan](https://app.notion.com/p/3df859f630f78055b042e69a3ad6558b) defines the requirements.

See [architecture](docs/architecture.md), the [telemetry point contract](docs/telemetry-point-contract.md), [ingestion API design](docs/ingestion-server.md), [broker options](docs/broker-options.md), [serialization](docs/serialization.md), and [ingestion and reliability](docs/ingestion-and-reliability.md) for the design and validation scenarios.

## Repository layout

```text
apps/
  web/                  TanStack Start web application with SSR
  landing/              Astro landing site and Starlight documentation for recount.cloud
  collector/            Linux procfs collector with persistent OTLP export
  ingestion-api/        Authenticated OTLP/gRPC admission and raw Kafka publication
  normalizer/           Raw Kafka to analytical Protobuf normalization
packages/
  i18n/                 Shared English/French catalogs and locale helpers
  transactional/        React Email templates, rendering, and previews
crates/                 Shared Rust libraries
docs/                   Architecture, serialization, and reliability considerations
infra/
  local/                Reusable backends and optional packaged applications
  clickhouse/           Native Kafka source, materialized view and point-table DDL
  kafka/                Current topic initialization
  lab/                  Optional Vagrant VMs, Grafana, and workload playbooks
tests/                  Cross-component validation scenarios
```

## Development setup

Application development needs [Bun](https://bun.sh/) 1.4.2 (pinned in `.bun-version`), [just](https://just.systems/) 1.58.0 and [Rust through rustup](https://www.rust-lang.org/tools/install), pinned in `rust-toolchain.toml`. Host builds of the ingestion API and normalizer also need Make and a C/C++ compiler for librdkafka. Docker Compose supplies reusable PostgreSQL/Kafka/ClickHouse backends. Host Node runs Playwright. Optional lab work additionally needs uv 0.12.23, Vagrant and VirtualBox; `just lab setup` installs its locked Ansible dependencies. See [runtime preparation](infra/README.md#prepare-runtime-artifacts).

On Windows, follow the [Windows setup guide](docs/windows-setup.md) instead. The test environment runs from Ubuntu on WSL2 because Ansible does not run on native Windows.

```sh
just setup
```

This installs locked Bun dependencies and Lefthook's Git hooks, fetches locked Cargo dependencies, and copies missing `.env` files for the web application and local backends. It preserves existing files and does not compile applications, initialize data or install VM tooling. Use `just hooks-install` to reinstall hooks in a checkout.

Bun manages TypeScript workspaces and shared web tooling; Cargo manages Rust packages. uv manages Ansible for the optional lab. Use the root lockfiles; do not create component lockfiles.

## Run components

```sh
just build
just typecheck
```

See [the web README](apps/web/README.md) for SSR, email-code/passkey authentication, EN/FR development and configuration. The [ingestion API reference](apps/ingestion-api/README.md) covers authenticated OTLP and health checks; the [normalizer reference](apps/normalizer/README.md) covers Kafka processing and recovery.

For daily iteration, reuse one PostgreSQL/Kafka/ClickHouse Compose instance and run Playwright with host Node, the web application with native Bun, and ingestion/normalization natively where supported. Keep Linux collectors in containers or existing VMs. Docker packaging and Linux checks are final validation gates, not the default test retry loop. Follow the [local stack guide](infra/README.md), including its identity, mount and image/schema checks. Normal startup must not reset consumer offsets or incompatible state. Once that instance is prepared:

```sh
just local up
just local status
just local stop
```

```sh
just lab setup
just lab up
just lab verify
just lab stop
```

`just lab` lists optional lab commands. Its ignored `infra/lab/.env` selects VM resources, ports and any existing `VAGRANT_DOTFILE_PATH`. Inspect existing VM UUIDs, metadata and collector bindings before any lifecycle operation; the source rename does not move or recreate them. VirtualBox preferences control new VM storage. See [the lab guide](infra/lab/README.md). Start an ingestion API separately before lab connectivity verification; monitoring does not provide one. The web application authorizes [execution recordings and node-context queries](docs/execution-telemetry.md).

After `just lab up`, [Grafana](http://localhost:3003/d/node-exporter-full/node-exporter-full) displays Linux metrics from the VMs using Alloy, Prometheus and the prebuilt Node Exporter Full dashboard.

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

The push hook runs TypeScript checking when web or shared package files change and Clippy when Rust files or manifests change.

```sh
just check
just format
just lint-fix
```

`format` formats repository files; `lint-fix` applies safe Biome fixes. Format the Vagrantfile manually. Just delegates to native tools and canonical package scripts, without Bun-to-Just wrapper loops. `just check` does not require Ansible or Vagrant; use `just lab syntax` for those checks. Use `just --list` for component commands.

`just test` runs ordinary native Cargo/Bun tests without live-service setup. Select real-service leaves with `just test-integration db`, `telemetry`, `authority` or `normalizer`, forwarding their native selectors. `just test-browser` uses standard host Node and native Bun fixtures. Linux-artifact, packaged-runtime and destructive recovery gates are separately named `test-linux`, `test-runtime` and `test-recovery`; inspect `tests/justfile` for their required allocations. Native browser tests reuse backends while isolating private databases and contexts. Compile artifacts on the host, never inside Docker. The [point contract](docs/telemetry-point-contract.md) and [native-ingestion guide](infra/README.md#validate-native-ingestion) distinguish fixtures from actual Kafka/ClickHouse failure checks. No fixture pass establishes fleet capacity; Linux collector, VM and Windows behavior need their own platform checks.

## Adding components

Add TypeScript applications or packages to the root Bun workspace. Add Rust packages to the root Cargo workspace and inherit the workspace edition, version, and lint settings. Put shared Rust libraries under `crates`.

Unit tests belong to the component they exercise. Cross-component tests and performance experiments belong under `tests`; optional machine provisioning belongs under `infra/lab`.
