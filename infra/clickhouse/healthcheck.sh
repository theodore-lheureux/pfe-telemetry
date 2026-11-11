#!/bin/sh
set -eu
sh /docker-entrypoint-initdb.d/00-verify-schema.sh
# Inserts write the contract's columns; computed MATERIALIZED columns are not part of it.
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'metric_points' AND default_kind != 'MATERIALIZED' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-columns.tsv)
[ "$actual" = "$expected" ]
clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query 'SELECT count() FROM telemetry.metric_points WHERE 0' >/dev/null
