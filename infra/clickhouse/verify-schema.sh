#!/bin/sh
set -eu
cd /etc/recount-schema
cmp SHA256SUMS /usr/share/recount-schema/SHA256SUMS
sha256sum --check --status /usr/share/recount-schema/SHA256SUMS
[ "$(cat output-rows)" = "${RECOUNT_NORMALIZER_OUTPUT_ROWS-$(cat default-output-rows)}" ]
[ "$(cat normalized-broker-max-bytes)" = "${RECOUNT_NORMALIZED_BROKER_MAX_BYTES-$(cat default-normalized-broker-max-bytes)}" ]
[ "$(cat kafka-receive-bytes)" = "${RECOUNT_KAFKA_RECEIVE_BYTES-$(cat default-kafka-receive-bytes)}" ]
cmp native-transport.xml /etc/clickhouse-server/config.d/native-transport.xml
cmp schemas/recount.proto /etc/clickhouse-server/format_schemas/recount.proto
clickhouse-client --version | grep -Fq '26.8.34.13'
