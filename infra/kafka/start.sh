#!/bin/bash
set -euo pipefail
umask 077
secrets=/run/recount-kafka
export KAFKA_OPTS=-Djava.security.auth.login.config=$secrets/broker.jaas
if [[ ${RECOUNT_INITIALIZE_ROLE:-} == kafka ]]; then
    work=$(mktemp -d)
    trap 'rm -f "$work/server.properties" "$work/format.args"; rmdir "$work"' EXIT
    cat > "$work/server.properties" <<EOF
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
controller.listener.names=CONTROLLER
listeners=CONTROLLER://127.0.0.1:9093,SASL_PLAINTEXT://:9092
advertised.listeners=SASL_PLAINTEXT://kafka:9092
listener.security.protocol.map=CONTROLLER:PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT
inter.broker.listener.name=SASL_PLAINTEXT
log.dirs=${KAFKA_LOG_DIRS:?}
EOF
    {
        printf '%s\n' '-cp' '/opt/kafka/libs/*' 'kafka.tools.StorageTool'
        printf 'format\n--cluster-id\n%s\n--config\n%s\n' "${CLUSTER_ID:?}" "$work/server.properties"
        cat "$secrets/format-scram.args"
    } > "$work/format.args"
    java "@$work/format.args" >/dev/null 2>&1 || { echo 'Kafka SCRAM storage initialization failed' >&2; exit 1; }
    rm -f "$work/server.properties" "$work/format.args"
    rmdir "$work"
    trap - EXIT
else
    export CLUSTER_ID=${RECOUNT_DATA_ID:?}
fi
exec /etc/kafka/docker/run
