#!/bin/bash
set -euo pipefail

[[ "${RECOUNT_CONFIRM_EMPTY_CLICKHOUSE_GROUP:-}" == recount-clickhouse ]] || { echo 'Explicit fresh-group confirmation required' >&2; exit 1; }
bootstrap=${RECOUNT_KAFKA_BOOTSTRAP:?}
normalized=${RECOUNT_NORMALIZED_TOPIC:?}
late=${RECOUNT_LATE_TOPIC:?}
partitions=${RECOUNT_NORMALIZED_PARTITIONS:?}
participant_topic=${RECOUNT_PARTICIPANT_TOPIC:-recount.participants}
participant_partitions=${RECOUNT_PARTICIPANT_PARTITIONS:-3}
tool=/opt/kafka/bin
for count in "$partitions" "$participant_partitions"; do
    [[ "$count" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid partition count' >&2; exit 1; }
done
groups=$("$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --list)
for group in recount-clickhouse recount-clickhouse-late recount-clickhouse-participants; do
    if grep -Fxq "$group" <<< "$groups"; then
        echo "Group $group already exists; refusing to overwrite any recovery offsets" >&2
        exit 1
    fi
done

seed() {
    local group=$1 topic=$2 partitions=$3 offsets description verified partition
    # Offset zero, not earliest: if retention has already removed records, fail closed.
    offsets=$("$tool/kafka-get-offsets.sh" --bootstrap-server "$bootstrap" --topic "$topic" --time earliest)
    [[ $(wc -l <<< "$offsets" | tr -d ' ') == "$partitions" ]] || { echo 'Unexpected partition metadata' >&2; exit 1; }
    while IFS=: read -r name partition offset; do
        [[ "$name" == "$topic" && "$offset" == 0 ]] || { echo 'Topic has a retention gap; refusing initialization' >&2; exit 1; }
    done <<< "$offsets"
    "$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --group "$group" --topic "$topic" --reset-offsets --to-offset 0 --execute
    description=$("$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --group "$group" --describe)
    verified=$(awk -v group="$group" -v topic="$topic" '$1 == group && $2 == topic && $4 == "0" {print $3}' <<< "$description" | sort -nu)
    [[ $(wc -l <<< "$verified" | tr -d ' ') == "$partitions" ]] || { echo 'Offset seed was partial or unconfirmed; inspect manually before any retry' >&2; exit 1; }
    for ((partition=0; partition<partitions; partition++)); do
        grep -Fxq "$partition" <<< "$verified" || { echo 'Offset seed has missing partition; inspect manually' >&2; exit 1; }
    done
}

seed recount-clickhouse "$normalized" "$partitions"
seed recount-clickhouse-late "$late" "$partitions"
seed recount-clickhouse-participants "$participant_topic" "$participant_partitions"
