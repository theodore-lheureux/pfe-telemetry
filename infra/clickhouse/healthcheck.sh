#!/bin/sh
set -eu
sh /docker-entrypoint-initdb.d/00-verify-schema.sh
# Inserts write the contract's columns; computed MATERIALIZED columns are not part of it.
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'metric_points' AND default_kind != 'MATERIALIZED' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-columns.tsv)
[ "$actual" = "$expected" ]
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'metric_series' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-series-columns.tsv)
[ "$actual" = "$expected" ]
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'metric_streams' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-stream-columns.tsv)
[ "$actual" = "$expected" ]
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'deliveries' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-delivery-columns.tsv)
[ "$actual" = "$expected" ]
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'delivery_contexts' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-delivery-context-columns.tsv)
[ "$actual" = "$expected" ]
actual=$(clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query "SELECT name, type FROM system.columns WHERE database = 'telemetry' AND table = 'execution_participants' ORDER BY position FORMAT TSVRaw")
expected=$(cat /etc/recount-schema/expected-participant-columns.tsv)
[ "$actual" = "$expected" ]
clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query 'SELECT count() FROM telemetry.metric_points WHERE 0' >/dev/null
clickhouse-client --user telemetry_reader --password "$CLICKHOUSE_READER_PASSWORD" --query 'SELECT count() FROM telemetry.execution_participants WHERE 0' >/dev/null
