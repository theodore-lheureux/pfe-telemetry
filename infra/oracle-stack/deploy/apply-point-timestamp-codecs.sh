#!/usr/bin/env bash
set -euo pipefail

[[ $EUID == 0 && $# == 1 ]] || {
    echo 'Usage (as root): apply-point-timestamp-codecs.sh /opt/recount/releases/RELEASE_ID' >&2
    exit 2
}
release=$1
[[ $release =~ ^/opt/recount/releases/[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
[[ $(cat "$release/release") == "${release##*/}" ]]
(cd "$release/backend" && sha256sum --check --status ../backend.SHA256SUMS)

container=recount-ingestion-clickhouse-1
docker exec -i "$container" sh -ec \
    'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery' \
    < "$release/backend/schema/point-timestamp-codecs.sql"
actual=$(docker exec "$container" sh -ec \
    'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"' \
    sh "SELECT name, compression_codec FROM system.columns WHERE database='telemetry' AND table='metric_points' AND name IN ('time_unix_milli','raw_offset') ORDER BY name FORMAT TSVRaw")
printf '%s\n' "$actual"
expected=$(printf 'raw_offset\tCODEC(DoubleDelta, LZ4)\ntime_unix_milli\tCODEC(DoubleDelta, LZ4)')
[[ $actual == "$expected" ]]
