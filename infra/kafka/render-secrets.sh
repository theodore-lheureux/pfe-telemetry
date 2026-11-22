#!/bin/bash
set -euo pipefail
umask 077
destination=${1:?private destination required}
mkdir -p "$destination"
chmod 0700 "$destination"
work=$(mktemp -d "$destination/.render.XXXXXX")
trap 'rm -f "$work"/*; rmdir "$work"' EXIT
for user in broker admin ingestion-api normalizer clickhouse live kafka-exporter; do
    file="$destination/$user.password"
    if [[ ! -f $file ]]; then
        openssl rand -hex 32 > "$work/$user.password"
        mv "$work/$user.password" "$file"
    fi
    password=$(<"$file")
    [[ $password =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid Kafka credential file' >&2; exit 1; }
    printf 'security.protocol=SASL_PLAINTEXT\nsasl.mechanism=SCRAM-SHA-512\nsasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="%s" password="%s";\n' "$user" "$password" > "$work/$user.properties"
    if [[ $user == broker ]]; then
        printf 'KafkaServer { org.apache.kafka.common.security.scram.ScramLoginModule required username="broker" password="%s"; };\n' "$password" > "$work/broker.jaas"
    fi
    if [[ $user == clickhouse ]]; then
        printf '<clickhouse><kafka><security_protocol>sasl_plaintext</security_protocol><sasl_mechanisms>SCRAM-SHA-512</sasl_mechanisms><sasl_username>clickhouse</sasl_username><sasl_password>%s</sasl_password></kafka></clickhouse>\n' "$password" > "$work/clickhouse.xml"
    fi
done
for user in broker admin ingestion-api normalizer clickhouse live kafka-exporter; do
    printf '%s\nSCRAM-SHA-512=[name=%s,password=%s]\n' '--add-scram' "$user" "$(<"$destination/$user.password")"
done > "$work/format-scram.args"
# The directory is host-private; each non-root container gets only its own file.
chmod 0444 "$work"/* "$destination"/*.password
for generated in "$work"/*; do mv -f "$generated" "$destination/"; done
