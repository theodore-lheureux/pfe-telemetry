#!/bin/bash
set -euo pipefail

mode=${1:?usage: init-topics.sh create|create-live|verify}
[[ $# == 1 && ( "$mode" == create || "$mode" == create-live || "$mode" == verify ) ]] || { echo 'Expected create, create-live or verify' >&2; exit 1; }
live_only=false
if [[ "$mode" == create-live ]]; then live_only=true; mode=create; fi

bootstrap=${RECOUNT_KAFKA_BOOTSTRAP:?}
raw=${RECOUNT_RAW_TOPIC:?}
normalized=${RECOUNT_NORMALIZED_TOPIC:?}
late=${RECOUNT_LATE_TOPIC:?}
live=${RECOUNT_LIVE_TOPIC:-recount.metrics.live}
participants=${RECOUNT_PARTICIPANT_TOPIC:-recount.participants}
export RECOUNT_LIVE_PARTITIONS=${RECOUNT_LIVE_PARTITIONS:-8}
export RECOUNT_LIVE_RETENTION_MS=${RECOUNT_LIVE_RETENTION_MS:-300000}
export RECOUNT_LIVE_RETENTION_BYTES=${RECOUNT_LIVE_RETENTION_BYTES:-16777216}
export RECOUNT_LIVE_SEGMENT_BYTES=${RECOUNT_LIVE_SEGMENT_BYTES:-1048576}
export RECOUNT_LIVE_SEGMENT_MS=${RECOUNT_LIVE_SEGMENT_MS:-60000}
export RECOUNT_LIVE_BROKER_MAX_BYTES=${RECOUNT_LIVE_BROKER_MAX_BYTES:-65536}
export RECOUNT_PARTICIPANT_PARTITIONS=${RECOUNT_PARTICIPANT_PARTITIONS:-3}
tool=/opt/kafka/bin

for value in "$raw" "$normalized" "$late" "$live" "$participants"; do
    [[ "$value" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Invalid topic name' >&2; exit 1; }
done
[[ "$raw" != "$normalized" && "$late" != "$raw" && "$late" != "$normalized" ]] || { echo 'Topics must differ' >&2; exit 1; }
[[ "$live" != "$raw" && "$live" != "$normalized" && "$live" != "$late" ]] || { echo 'Live topic must be separate' >&2; exit 1; }
[[ "$participants" != "$raw" && "$participants" != "$normalized" && "$participants" != "$late" && "$participants" != "$live" ]] || { echo 'Participant topic must be separate' >&2; exit 1; }
for prefix in RAW NORMALIZED LATE PARTICIPANT LIVE; do
    for suffix in RETENTION_MS RETENTION_BYTES SEGMENT_BYTES SEGMENT_MS BROKER_MAX_BYTES; do
        name="RECOUNT_${prefix}_${suffix}"
        [[ "${!name:-}" =~ ^[1-9][0-9]{0,14}$ ]] || { echo "Invalid positive bound: $name" >&2; exit 1; }
    done
done
for name in RECOUNT_RAW_PARTITIONS RECOUNT_NORMALIZED_PARTITIONS RECOUNT_PARTICIPANT_PARTITIONS RECOUNT_LIVE_PARTITIONS RECOUNT_BROKER_MESSAGE_BYTES RECOUNT_BROKER_FETCH_BYTES; do
    [[ "${!name}" =~ ^[1-9][0-9]{0,14}$ ]] || { echo "Invalid positive bound: $name" >&2; exit 1; }
done
for prefix in RAW NORMALIZED LATE PARTICIPANT LIVE; do
    segment="RECOUNT_${prefix}_SEGMENT_BYTES"
    record="RECOUNT_${prefix}_BROKER_MAX_BYTES"
    (( ${!segment} >= 1048576 && ${!segment} <= 2147483647 && ${!segment} >= ${!record} && RECOUNT_BROKER_MESSAGE_BYTES >= ${!record} )) || { echo "Incoherent segment/broker/record bounds: $prefix" >&2; exit 1; }
done
(( RECOUNT_LIVE_BROKER_MAX_BYTES >= 65536 )) || { echo 'Invalid Live record bound' >&2; exit 1; }
(( RECOUNT_BROKER_MESSAGE_BYTES >= RECOUNT_RAW_BROKER_MAX_BYTES && RECOUNT_BROKER_MESSAGE_BYTES >= RECOUNT_NORMALIZED_BROKER_MAX_BYTES && RECOUNT_BROKER_FETCH_BYTES >= RECOUNT_BROKER_MESSAGE_BYTES )) || { echo 'Incoherent broker/record/fetch bounds' >&2; exit 1; }
(( RECOUNT_RAW_PARTITIONS <= 4096 && RECOUNT_NORMALIZED_PARTITIONS <= 4096 && RECOUNT_PARTICIPANT_PARTITIONS <= 4096 && RECOUNT_LIVE_PARTITIONS <= 256 )) || { echo 'Invalid partition bounds' >&2; exit 1; }
status=0

ensure_topic() {
    local topic=$1 count=$2 prefix=$3 compression=${4:-producer} name description actual settings found
    local -a config=()
    for setting in retention.ms:RETENTION_MS retention.bytes:RETENTION_BYTES segment.bytes:SEGMENT_BYTES segment.ms:SEGMENT_MS max.message.bytes:BROKER_MAX_BYTES; do
        name="${prefix}_${setting#*:}"
        config+=(--config "${setting%%:*}=${!name}")
    done
    config+=(--config cleanup.policy=delete --config min.insync.replicas=1 --config unclean.leader.election.enable=false)
    # Producers send this codec, so matching batches are stored without recompression.
    config+=(--config "compression.type=$compression")
    if [[ "$mode" == create ]]; then
        "$tool/kafka-topics.sh" --bootstrap-server "$bootstrap" --create --topic "$topic" --partitions "$count" --replication-factor 1 "${config[@]}"
    fi
    description=$("$tool/kafka-topics.sh" --bootstrap-server "$bootstrap" --describe --topic "$topic")
    actual=$(sed -nE 's/.*PartitionCount: ([0-9]+).*/\1/p' <<< "$description")
    [[ "$actual" == "$count" ]] || { echo "Partition mismatch for $topic; no automatic resize" >&2; exit 1; }
    grep -Eq 'ReplicationFactor: 1([[:space:]]|$)' <<< "$description" || { echo "Replication mismatch for $topic" >&2; exit 1; }
    settings=$("$tool/kafka-configs.sh" --bootstrap-server "$bootstrap" --entity-type topics --entity-name "$topic" --describe --all)
    # Only effective values, never a matching inherited value in the synonyms field.
    settings=$(awk '{for(i=1;i<=NF;i++) {if($i ~ /^synonyms=/) break; print $i}}' <<< "$settings" | tr ',' '\n')
    local mismatch=false
    for ((i=1; i<${#config[@]}; i+=2)); do
        if ! grep -Fxq -- "${config[$i]}" <<< "$settings"; then
            found=$(grep -F -- "${config[$i]%%=*}=" <<< "$settings" || true)
            echo "Topic configuration mismatch for $topic: expected ${config[$i]}, effective ${found:-missing}" >&2
            status=1
            mismatch=true
        fi
    done
    if [[ "$mismatch" == false ]]; then echo "Verified $topic ($actual partitions)"; fi
}

if [[ "$live_only" == false ]]; then
    ensure_topic "$raw" "$RECOUNT_RAW_PARTITIONS" RECOUNT_RAW zstd
    ensure_topic "$normalized" "$RECOUNT_NORMALIZED_PARTITIONS" RECOUNT_NORMALIZED zstd
    # The normalizer routes a point to the same partition index on either topic.
    ensure_topic "$late" "$RECOUNT_NORMALIZED_PARTITIONS" RECOUNT_LATE zstd
    ensure_topic "$participants" "$RECOUNT_PARTICIPANT_PARTITIONS" RECOUNT_PARTICIPANT zstd
fi
ensure_topic "$live" "$RECOUNT_LIVE_PARTITIONS" RECOUNT_LIVE
exit "$status"
