set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

# Manage the local VMs, ingestion server, and monitoring.
mod env 'infra/test-environment/justfile'

# Ingest telemetry through Kafka and query ClickHouse.
mod telemetry 'infra/telemetry/justfile'

mod app 'infra/application/justfile'

default:
    @just --list

# Install the dependencies from the root lockfiles and create local settings
setup: config
    bun install --frozen-lockfile
    uv sync --locked
    cargo check --locked --workspace

# Create missing configuration files
config:
    @for directory in apps/web infra/test-environment infra/telemetry infra/application; do if [ ! -e "$directory/.env" ]; then cp "$directory/.env.example" "$directory/.env"; fi; done

dev *args:
    bun run dev "$@"

build:
    bun run build

typecheck:
    bun run typecheck

test-web:
    bun run --filter @pfe/web test

db-generate *args:
    bun run --filter @pfe/web db:generate "$@"

db-check:
    bun run --filter @pfe/web db:check

db-migrate:
    bun run --filter @pfe/web db:migrate

email-dev:
    bun run --filter @pfe/transactional dev

test-db:
    bun run --filter @pfe/web test:db

server:
    cargo run --locked -p pfe-server

check-web:
    bun --bun run biome check . --error-on-warnings
    bun run typecheck

check-docs:
    bun --bun run prettier --check '**/*.{md,yaml,yml}'
    just --fmt --check
    just --justfile infra/test-environment/justfile --fmt --check
    just --justfile infra/telemetry/justfile --fmt --check
    just --justfile infra/application/justfile --fmt --check

check-environment:
    ruby -c infra/test-environment/Vagrantfile
    uv run --locked ansible-playbook --syntax-check --inventory compute, infra/test-environment/ansible/*.yml
    docker compose --env-file infra/test-environment/.env.example --file infra/test-environment/compose.yaml config --quiet
    docker compose --env-file infra/telemetry/.env.example --file infra/telemetry/compose.yaml config --quiet
    POSTGRES_PASSWORD=configuration-check docker compose --env-file infra/application/.env.example --file infra/application/compose.yaml config --quiet

check-rust:
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings

check: check-web check-docs check-environment check-rust

lint:
    bun --bun run biome lint . --error-on-warnings
    ruby -c infra/test-environment/Vagrantfile
    cargo clippy --locked --workspace --all-targets -- -D warnings

test:
    cargo test --locked --workspace

format:
    bun --bun run biome format --write .
    bun --bun run prettier --write '**/*.{md,yaml,yml}'
    cargo fmt --all
    just --fmt
    just --justfile infra/test-environment/justfile --fmt
    just --justfile infra/telemetry/justfile --fmt
    just --justfile infra/application/justfile --fmt

format-check: check-docs
    bun --bun run biome format .
    cargo fmt --all -- --check

lint-fix:
    bun --bun run biome check --write . --error-on-warnings

hooks-install:
    bun run hooks:install
