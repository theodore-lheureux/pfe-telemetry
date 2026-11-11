#!/bin/bash
set -euo pipefail

mode=${1:?usage: init-topics.sh create|create-live|verify}
[[ $# == 1 && ( "$mode" == create || "$mode" == create-live || "$mode" == verify ) ]] || { echo 'Expected create, create-live or verify' >&2; exit 1; }
live_only=false
if [[ "$mode" == create-live ]]; then live_only=true; mode=create; fi

bootstrap=${RECOUNT_KAFKA_BOOTSTRAP:?}
raw=${RECOUNT_RAW_TOPIC:?}
normalized=${RECOUNT_NORMALIZED_TOPIC:?}
live=${RECOUNT_LIVE_TOPIC:-recount.metrics.live}
export RECOUNT_LIVE_PARTITIONS=${RECOUNT_LIVE_PARTITIONS:-8}
export RECOUNT_LIVE_RETENTION_MS=${RECOUNT_LIVE_RETENTION_MS:-300000}
export RECOUNT_LIVE_RETENTION_BYTES=${RECOUNT_LIVE_RETENTION_BYTES:-16777216}
export RECOUNT_LIVE_SEGMENT_BYTES=${RECOUNT_LIVE_SEGMENT_BYTES:-1048576}
export RECOUNT_LIVE_SEGMENT_MS=${RECOUNT_LIVE_SEGMENT_MS:-60000}
export RECOUNT_LIVE_BROKER_MAX_BYTES=${RECOUNT_LIVE_BROKER_MAX_BYTES:-65536}
tool=/opt/kafka/bin

for value in "$raw" "$normalized" "$live"; do
    [[ "$value" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Invalid topic name' >&2; exit 1; }
done
[[ "$raw" != "$normalized" ]] || { echo 'Topics must differ' >&2; exit 1; }
[[ "$live" != "$raw" && "$live" != "$normalized" ]] || { echo 'Live topic must be separate' >&2; exit 1; }
for name in RECOUNT_LIVE_PARTITIONS RECOUNT_LIVE_RETENTION_MS RECOUNT_LIVE_RETENTION_BYTES RECOUNT_LIVE_SEGMENT_BYTES RECOUNT_LIVE_SEGMENT_MS RECOUNT_LIVE_BROKER_MAX_BYTES; do
    [[ "${!name}" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid positive bound: $name" >&2; exit 1; }
done
(( RECOUNT_LIVE_PARTITIONS <= 256 && RECOUNT_LIVE_BROKER_MAX_BYTES >= 65536 )) || { echo 'Invalid Live partition or record bounds' >&2; exit 1; }
for name in RECOUNT_RAW_PARTITIONS RECOUNT_NORMALIZED_PARTITIONS RECOUNT_RAW_RETENTION_MS RECOUNT_NORMALIZED_RETENTION_MS RECOUNT_RAW_RETENTION_BYTES RECOUNT_NORMALIZED_RETENTION_BYTES RECOUNT_RAW_SEGMENT_BYTES RECOUNT_NORMALIZED_SEGMENT_BYTES RECOUNT_RAW_SEGMENT_MS RECOUNT_NORMALIZED_SEGMENT_MS RECOUNT_RAW_BROKER_MAX_BYTES RECOUNT_NORMALIZED_BROKER_MAX_BYTES RECOUNT_BROKER_MESSAGE_BYTES RECOUNT_BROKER_FETCH_BYTES; do
    [[ "${!name}" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid positive bound: $name" >&2; exit 1; }
done
(( RECOUNT_BROKER_MESSAGE_BYTES >= RECOUNT_RAW_BROKER_MAX_BYTES && RECOUNT_BROKER_MESSAGE_BYTES >= RECOUNT_NORMALIZED_BROKER_MAX_BYTES && RECOUNT_BROKER_FETCH_BYTES >= RECOUNT_BROKER_MESSAGE_BYTES )) || { echo 'Incoherent broker/record/fetch bounds' >&2; exit 1; }

ensure_topic() {
    local topic=$1 count=$2 prefix=$3 name description actual settings
    local -a config=()
    for setting in retention.ms:RETENTION_MS retention.bytes:RETENTION_BYTES segment.bytes:SEGMENT_BYTES segment.ms:SEGMENT_MS max.message.bytes:BROKER_MAX_BYTES; do
        name="${prefix}_${setting#*:}"
        config+=(--config "${setting%%:*}=${!name}")
    done
    config+=(--config cleanup.policy=delete --config min.insync.replicas=1 --config unclean.leader.election.enable=false)
    if [[ "$mode" == create ]]; then
        "$tool/kafka-topics.sh" --bootstrap-server "$bootstrap" --create --topic "$topic" --partitions "$count" --replication-factor 1 "${config[@]}"
    fi
    description=$("$tool/kafka-topics.sh" --bootstrap-server "$bootstrap" --describe --topic "$topic")
    actual=$(sed -nE 's/.*PartitionCount: ([0-9]+).*/\1/p' <<< "$description")
    [[ "$actual" == "$count" ]] || { echo "Partition mismatch for $topic; no automatic resize" >&2; exit 1; }
    settings=$("$tool/kafka-configs.sh" --bootstrap-server "$bootstrap" --entity-type topics --entity-name "$topic" --describe)
    for ((i=1; i<${#config[@]}; i+=2)); do
        grep -Fq -- " ${config[$i]} " <<< " ${settings//,/ } " || { echo "Topic configuration mismatch for $topic: ${config[$i]%%=*}" >&2; exit 1; }
    done
    echo "Verified $topic ($actual partitions)"
}

if [[ "$live_only" == false ]]; then
    ensure_topic "$raw" "$RECOUNT_RAW_PARTITIONS" RECOUNT_RAW
    ensure_topic "$normalized" "$RECOUNT_NORMALIZED_PARTITIONS" RECOUNT_NORMALIZED
fi
ensure_topic "$live" "$RECOUNT_LIVE_PARTITIONS" RECOUNT_LIVE
