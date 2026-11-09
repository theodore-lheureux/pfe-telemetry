#!/bin/bash
set -euo pipefail

[[ "${RECOUNT_CONFIRM_EMPTY_CLICKHOUSE_GROUP:-}" == recount-clickhouse ]] || { echo 'Explicit fresh-group confirmation required' >&2; exit 1; }
bootstrap=${RECOUNT_KAFKA_BOOTSTRAP:?}
topic=${RECOUNT_NORMALIZED_TOPIC:?}
tool=/opt/kafka/bin
groups=$("$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --list)
if grep -Fxq recount-clickhouse <<< "$groups"; then
    echo 'Group already exists; refusing to overwrite any recovery offsets' >&2
    exit 1
fi
# Offset zero, not earliest: if retention has already removed records, fail closed.
offsets=$("$tool/kafka-get-offsets.sh" --bootstrap-server "$bootstrap" --topic "$topic" --time earliest)
[[ $(wc -l <<< "$offsets" | tr -d ' ') == "${RECOUNT_NORMALIZED_PARTITIONS:?}" ]] || { echo 'Unexpected partition metadata' >&2; exit 1; }
while IFS=: read -r name partition offset; do
    [[ "$name" == "$topic" && "$offset" == 0 ]] || { echo 'Topic has a retention gap; refusing initialization' >&2; exit 1; }
done <<< "$offsets"
"$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --group recount-clickhouse --topic "$topic" --reset-offsets --to-offset 0 --execute
description=$("$tool/kafka-consumer-groups.sh" --bootstrap-server "$bootstrap" --group recount-clickhouse --describe)
verified=$(awk -v topic="$topic" '$1 == "recount-clickhouse" && $2 == topic && $4 == "0" {print $3}' <<< "$description" | sort -nu)
[[ $(wc -l <<< "$verified" | tr -d ' ') == "$RECOUNT_NORMALIZED_PARTITIONS" ]] || { echo 'Offset seed was partial or unconfirmed; inspect manually before any retry' >&2; exit 1; }
for ((partition=0; partition<RECOUNT_NORMALIZED_PARTITIONS; partition++)); do
    grep -Fxq "$partition" <<< "$verified" || { echo 'Offset seed has missing partition; inspect manually' >&2; exit 1; }
done
