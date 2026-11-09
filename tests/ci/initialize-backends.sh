#!/usr/bin/env bash
set -euo pipefail

[[ ${CI:-} == true && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]
[[ ${COMPOSE_PROJECT_NAME:-} == "recount-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:?}" ]]
[[ -n ${COMPOSE_FILE:?} && -n ${COMPOSE_ENV_FILES:?} && -n ${GITHUB_ENV:?} ]]
existing=$(docker compose ps --all --quiet)
[[ -z $existing ]] || { echo 'CI initialization requires a fresh job-owned project' >&2; exit 1; }

initialize() {
    local role=$1 key identity
    just --no-dotenv local init "$role"
    identity=$(just --no-dotenv --quiet local data-identity "$role")
    [[ $identity =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Initializer did not establish one concrete identity' >&2; exit 1; }
    key="RECOUNT_${role^^}_DATA_ID"
    export "$key=$identity"
    printf '%s=%s\n' "$key" "$identity" >> "$GITHUB_ENV"
}

initialize postgres
initialize kafka
docker compose up --no-build --no-recreate --no-deps --detach --wait --wait-timeout 180 postgres kafka
just --no-dotenv local topics-create
just --no-dotenv local topics-verify
just --no-dotenv local initialize-clickhouse-offsets
initialize clickhouse
just --no-dotenv local up
