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
web_overlay=/etc/recount/web.local.yaml
if [[ -e $web_overlay || -L $web_overlay ]]; then
    [[ ! -L $web_overlay && -f $web_overlay && $(stat -c '%a:%u' "$web_overlay") == 600:0 ]]
    export COMPOSE_FILE="$COMPOSE_FILE:$web_overlay"
fi
bun --no-env-file /opt/recount/backend/infra/local/data.ts start
docker compose config --quiet
normalizer_replicas=$(docker compose config --format json | python3 -c \
    'import json, sys; print(json.load(sys.stdin)["services"]["normalizer"]["deploy"]["replicas"])')
[[ $normalizer_replicas =~ ^[1-9][0-9]*$ ]]
docker compose run --rm --no-deps kafka-topics verify
monitoring=(env -u COMPOSE_ENV_FILES docker compose --project-name recount-ingestion-monitoring --env-file /dev/null -f "$directory/monitoring/compose.yaml")
install -d -m 0755 /var/lib/recount/monitoring
"${monitoring[@]}" config --quiet
"${monitoring[@]}" up --no-build --detach --wait --wait-timeout 120
docker image load --input images.tar.zst
docker compose up --no-build --no-deps --pull never --detach --wait --wait-timeout 180 ingestion-api normalizer live web
running_normalizers=$(docker compose ps --status running --quiet normalizer)
[[ -n $running_normalizers && $(wc -l <<< "$running_normalizers") -eq $normalizer_replicas ]] || {
    echo "Expected $normalizer_replicas running normalizer replicas after activation." >&2
    exit 1
}
ln -sfn "$directory" /opt/recount/current
install -m 0644 "$directory/monitoring/recount-ingestion-sample.service" "$directory/monitoring/recount-ingestion-sample.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now recount-ingestion-sample.timer
# Rollback re-runs an earlier deploy job, which uploads its own archive, so older
# releases and their images are not kept on the host.
release=$(cat release)
for old in /opt/recount/releases/*; do
    [[ $old == "$directory" ]] || rm -rf "$old"
done
docker image ls --format '{{.Repository}}:{{.Tag}}' |
    grep -E '^recount-(ingestion-api|normalizer|web):' |
    { grep -v ":$release\$" || true; } |
    xargs -r docker image rm >/dev/null
printf 'Activated ingestion release %s\n' "$release"
