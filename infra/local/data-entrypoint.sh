#!/bin/sh
set -eu
role=${1:?data role required}
shift
fail() { echo "$role: $1" >&2; exit 1; }

case "$role" in
    postgres)
        directory=${PGDATA:-/var/lib/postgresql/18/docker}
        marker=$directory/PG_VERSION
        ;;
    kafka) directory=${KAFKA_LOG_DIRS:-/var/lib/kafka/data}; marker=$directory/meta.properties ;;
    clickhouse) directory=/var/lib/clickhouse; marker=$directory/uuid ;;
    *) fail 'unsupported data role' ;;
esac

if [ "${RECOUNT_INITIALIZE_ROLE:-}" = "$role" ]; then
    [ "${1:-}" != --identity ] || fail 'identity inspection is not initialization'
    [ ! -e "$marker" ] || fail 'refusing initialization of existing database identity'
    [ ! -d "$directory" ] || [ -z "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ] || fail 'refusing initialization of nonempty database directory'
    # This mode belongs only to an explicitly scoped, auto-removed one-off container.
    exec "$@"
fi

[ -s "$marker" ] || fail 'database identity is missing; initialization must be explicit'
case "$role" in
    postgres)
        [ "$(cat "$marker")" = 18 ] || fail 'current PostgreSQL major required'
        [ -s "$directory/global/pg_control" ] || fail 'PostgreSQL control file missing'
        [ -d "$directory/base" ] || fail 'PostgreSQL database content missing'
        [ -n "$(find "$directory/base" -mindepth 1 -print -quit)" ] || fail 'PostgreSQL database content empty'
        actual=$(LC_ALL=C pg_controldata "$directory" | sed -n 's/^Database system identifier: *//p')
        ;;
    kafka)
        [ -d "$directory/__cluster_metadata-0" ] || fail 'Kafka metadata log missing'
        [ -n "$(find "$directory/__cluster_metadata-0" -type f \( -name '*.log' -o -name '*.checkpoint' \) -size +0c -print -quit)" ] || fail 'Kafka metadata log content missing'
        actual=$(sed -n 's/^cluster.id=//p' "$marker")
        [ "$(sed -n 's/^node.id=//p' "$marker")" = 1 ] || fail 'unexpected Kafka node identity'
        ;;
    clickhouse)
        [ -s "$directory/metadata/telemetry/metric_points.sql" ] || fail 'current telemetry table metadata missing'
        [ -d "$directory/store" ] || fail 'ClickHouse database content missing'
        actual=$(cat "$marker")
        ;;
esac
[ -n "$actual" ] || fail 'database identity could not be read'
if [ "${1:-}" = --identity ]; then
    printf '%s\n' "$actual"
    exit 0
fi
[ -n "${RECOUNT_DATA_ID:-}" ] || fail 'expected database identity must be configured'
[ "$actual" = "$RECOUNT_DATA_ID" ] || fail 'database identity mismatch; refusing startup'
exec "$@"
