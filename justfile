set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

# Reusable backends and explicit packaged-runtime operations.
mod local 'infra/local/justfile'

# Optional Linux VMs, workloads and monitoring.
mod lab 'infra/lab/justfile'

default:
    @just --list

# Install locked application dependencies and missing ignored configuration only.
setup: config
    bun install --frozen-lockfile
    cargo fetch --locked

config:
    @for directory in apps/web infra/local; do if [ ! -e "$directory/.env" ] && [ ! -L "$directory/.env" ]; then (umask 077; set -C; cat "$directory/.env.example" > "$directory/.env"); fi; done

# Native Bun web development; arguments are forwarded to Vite.
dev *args:
    bun run --filter @recount/web dev "$@"

# Build the web application and landing site; Rust packages use Cargo directly.
build:
    bun run --filter @recount/web build
    bun run --filter @recount/landing build

# Astro landing site and documentation; arguments are forwarded to Astro.
landing-dev *args:
    bun run --filter @recount/landing dev "$@"

# Check, build and deploy the landing site to Cloudflare Workers.
landing-deploy:
    bun run --filter @recount/landing deploy

typecheck:
    bun run typecheck

db-generate *args:
    bun run --filter @recount/web db:generate "$@"

db-check:
    bun run --filter @recount/web db:check

db-migrate:
    bun run --filter @recount/web db:migrate

email-dev:
    bun run --filter @recount/transactional dev

# Run a command in this checkout's reused Linux build container, for Linux-only crates.
# Example: just linux cargo test --locked -p recount-collector
linux *args:
    @docker compose --progress quiet --file infra/linux-build/compose.yaml --project-name "recount-linux-build-$(basename "$PWD")" up --detach --wait build
    @docker compose --file infra/linux-build/compose.yaml --project-name "recount-linux-build-$(basename "$PWD")" exec build "$@"

# Native ingestion API; use flags or exported service-specific environment.
ingestion-api *args:
    cargo run --locked -p recount-ingestion-api -- "$@"

# Native normalizer; options precede the optional bootstrap subcommand.
normalizer *args:
    cargo run --locked -p recount-normalizer -- "$@"

# Ordinary host-compatible tests, without live-service or image setup.
test:
    cargo test --locked --workspace --all-targets
    bun run --filter @recount/web test
    just --justfile tests/justfile portable

# Select a dependency-specific leaf; native test-tool arguments remain available.
test-integration +args:
    just --justfile tests/justfile "$@"

# Standard host Node Playwright with native Bun application fixtures.
test-browser *args:
    just --justfile tests/justfile browser "$@"

test-linux *args:
    just --justfile tests/justfile linux "$@"

test-runtime *args:
    just --justfile tests/justfile runtime "$@"

test-recovery *args:
    just --justfile tests/justfile recovery "$@"

check-web:
    bun --bun run biome check . --error-on-warnings
    bun run typecheck

check-docs:
    bun --bun run prettier --check '**/*.{md,yaml,yml}'
    just check-justfiles

check-justfiles:
    just --fmt --check
    just --justfile infra/local/justfile --fmt --check
    just --justfile infra/lab/justfile --fmt --check
    just --justfile tests/justfile --fmt --check

check-local:
    #!/usr/bin/env bash
    set -euo pipefail
    # Synthetic values render configuration only; these commands never start services.
    export RECOUNT_COLLECTOR_SIGNING_KEY=compose-validation-only
    export RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS=compose-validation-only
    export RECOUNT_LIVE_GATEWAY_SECRET=compose-validation-only
    docker compose --env-file infra/local/.env.example --file infra/local/compose.yaml config --quiet
    docker compose --env-file infra/local/.env.example --file infra/local/compose.yaml --file infra/local/compose.apps.yaml config --quiet
    docker compose --env-file infra/local/.env.example --file infra/local/compose.yaml --file infra/local/compose.apps.yaml --file infra/local/compose.watch.yaml config --quiet
    just --justfile tests/justfile portable
    just check-tooling-types

check-tooling-types:
    bun --no-env-file apps/web/scripts/compile-telemetry.ts
    bun run i18n:compile
    bun --no-env-file run tsc --project infra/local/tsconfig.json
    bun --no-env-file run tsc --project tests/tsconfig.json

check-rust:
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings

check: check-web check-docs check-local check-rust

lint:
    bun --bun run biome lint . --error-on-warnings
    cargo clippy --locked --workspace --all-targets -- -D warnings

format:
    bun --bun run biome format --write .
    bun --bun run prettier --write '**/*.{md,yaml,yml}'
    cargo fmt --all
    just --fmt
    just --justfile infra/local/justfile --fmt
    just --justfile infra/lab/justfile --fmt
    just --justfile tests/justfile --fmt

format-check: check-docs
    bun --bun run biome format .
    cargo fmt --all -- --check

lint-fix:
    bun --bun run biome check --write . --error-on-warnings

hooks-install:
    bun run hooks:install
