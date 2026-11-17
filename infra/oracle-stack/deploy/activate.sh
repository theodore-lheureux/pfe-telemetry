#!/usr/bin/env bash
set -euo pipefail

[[ $EUID == 0 && $# == 1 ]] || exit 2
directory=$1
[[ $directory =~ ^/opt/recount/releases/[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 2
[[ ! -e /opt/recount/current || -L /opt/recount/current ]]
cd "$directory"
bash "$directory/check-storage.sh"
# Backend/schema changes require their own reviewed maintenance operation.
cmp backend.SHA256SUMS /opt/recount/backend.SHA256SUMS
(
    cd /opt/recount/backend
    sha256sum --check --status ../backend.SHA256SUMS
)
cmp migrations.sha256 /etc/recount/approved-migrations.sha256
[[ -f /etc/recount/ingestion.env && $(stat -c '%a:%u' /etc/recount/ingestion.env) == 600:0 ]]
export COMPOSE_PROJECT_NAME=recount-ingestion
export COMPOSE_ENV_FILES="/etc/recount/ingestion.env,$directory/images.env"
export COMPOSE_FILE="/opt/recount/backend/infra/local/compose.yaml:/opt/recount/backend/infra/local/data.binds.yaml:$directory/compose.apps.yaml:$directory/compose.release.yaml"
bun --no-env-file /opt/recount/backend/infra/local/data.ts start
docker compose config --quiet
docker compose run --rm --no-deps kafka-topics verify
docker image load --input images.tar.gz
docker compose up --no-build --no-deps --pull never --detach --wait --wait-timeout 180 ingestion-api normalizer live web
ln -sfn "$directory" /opt/recount/current
printf 'Activated ingestion release %s\n' "$(cat release)"
