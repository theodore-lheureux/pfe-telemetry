#!/usr/bin/env bash
set -euo pipefail

[[ $EUID == 0 && $# == 1 ]] || {
    echo 'Usage (as root): apply-activity-series.sh /opt/recount/releases/RELEASE_ID' >&2
    exit 2
}
release=$1
[[ $release =~ ^/opt/recount/releases/[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]
[[ $(cat "$release/release") == "${release##*/}" ]]
(cd "$release/backend" && sha256sum --check --status ../backend.SHA256SUMS)

ch() {
    docker exec -i recount-ingestion-clickhouse-1 sh -ec \
        'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery'
}
schema="$release/backend/schema/metric-schema.sql"
ddl=$(sed -n \
    -e '/^CREATE TABLE IF NOT EXISTS telemetry\.activity_series$/,/;$/p' \
    -e '/^CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry\.activity_series_by_source$/,/;$/p' \
    -e '/^CREATE TABLE IF NOT EXISTS telemetry\.activity_receipts$/,/;$/p' \
    -e '/^CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry\.activity_receipts_by_time$/,/;$/p' \
    "$schema")
[[ $ddl == *'TO telemetry.activity_series AS'* && $ddl == *'host_name SimpleAggregateFunction'* &&
   $ddl == *'TO telemetry.activity_receipts AS'* ]]
printf '%s\n' "$ddl" | ch

# Track completion against the target table UUID, not the release ID.
backfill() {
    local target=$1 marker=$2 uuid
    uuid=$(printf '%s\n' "SELECT uuid FROM system.tables WHERE database='telemetry' AND name='$target'" | ch)
    [[ $uuid =~ ^[a-f0-9-]{36}$ ]]
    if [[ -f $marker && $(cat "$marker") == "$uuid" ]]; then
        return
    fi
    ch
    umask 077
    printf '%s\n' "$uuid" > "$marker.tmp"
    mv "$marker.tmp" "$marker"
}

backfill activity_series /opt/recount/backend/.activity-series-backfill <<'SQL'
INSERT INTO telemetry.activity_series
    (project_id, source_id, series_id, metric_name, resource_id, host_id,
     resource_kind, metric_kind, unit, scope_name, scope_version,
     first_seen_unix_milli, last_seen_unix_milli)
SELECT project_id, source_id, series_id, metric_name, resource_id, host_id,
       toUInt8(resource_kind), toUInt8(metric_kind), unit, scope_name, scope_version,
       first_seen_unix_milli, last_seen_unix_milli
FROM telemetry.metric_series
SETTINGS max_threads=1, max_insert_threads=1;
SQL

backfill activity_receipts /opt/recount/backend/.activity-receipts-backfill <<'SQL'
INSERT INTO telemetry.activity_receipts
    (project_id, received_unix_nano, source_id, raw_partition, raw_offset,
     min_event_unix_milli, max_event_unix_milli)
SELECT project_id, received_unix_nano, source_id, raw_partition, raw_offset,
       min_event_unix_milli, max_event_unix_milli
FROM telemetry.deliveries
SETTINGS max_threads=1, max_insert_threads=1;
SQL
