#!/usr/bin/env bash
set -euo pipefail

mode=${1:?expected create or verify}
[[ $# == 1 && ( $mode == create || $mode == verify ) ]]
bootstrap=${RECOUNT_KAFKA_BOOTSTRAP:?}
properties=${RECOUNT_KAFKA_ADMIN_PROPERTIES:-/run/recount-kafka/admin.properties}
[[ -s $properties ]] || { echo 'Kafka administrator configuration is missing' >&2; exit 1; }
acl=(/opt/kafka/bin/kafka-acls.sh --bootstrap-server "$bootstrap" --command-config "$properties")
raw=${RECOUNT_RAW_TOPIC:?}
normalized=${RECOUNT_NORMALIZED_TOPIC:?}
late=${RECOUNT_LATE_TOPIC:?}
dead=${RECOUNT_DEAD_LETTER_TOPIC:-recount.metrics.dead-letter}
participants=${RECOUNT_PARTICIPANT_TOPIC:-recount.participants}
live=${RECOUNT_LIVE_TOPIC:-recount.metrics.live}
normalizer=${RECOUNT_NORMALIZER_GROUP:-recount-normalizer}
recent_group=${RECOUNT_CLICKHOUSE_GROUP:-recount-clickhouse}
late_group=${RECOUNT_CLICKHOUSE_LATE_GROUP:-recount-clickhouse-late}
dead_group=recount-clickhouse-dead-letter
participant_group=${RECOUNT_CLICKHOUSE_PARTICIPANT_GROUP:-recount-clickhouse-participants}

work=$(mktemp -d)
trap 'rm -f "$work/expected" "$work/list" "$work/actual"; rmdir "$work"' EXIT
touch "$work/expected"

rule() {
    local user=$1 kind=$2 pattern=$3 name=$4 operation=$5
    [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid Kafka ACL resource' >&2; exit 1; }
    local canonical=${operation^^}
    [[ $operation != DescribeConfigs ]] || canonical=DESCRIBE_CONFIGS
    printf '%s\t%s\t%s\tUser:%s\t%s\t*\tALLOW\n' "${kind^^}" "${pattern^^}" "$name" "$user" "$canonical" >> "$work/expected"
    if [[ $mode == create ]]; then
        "${acl[@]}" --add --allow-principal "User:$user" --operation "$operation" \
            --resource-pattern-type "$pattern" "--$kind" "$name" >/dev/null
    fi
}

for topic in "$raw" "$participants" "$live"; do rule ingestion-api topic literal "$topic" Write; done
for topic in "$raw" "$participants"; do rule ingestion-api topic literal "$topic" DescribeConfigs; done
rule normalizer topic literal "$raw" Read
for topic in "$normalized" "$late" "$dead"; do rule normalizer topic literal "$topic" Write; done
for topic in "$raw" "$normalized"; do rule normalizer topic literal "$topic" DescribeConfigs; done
rule normalizer group literal "$normalizer" Read
for topic in "$normalized" "$late" "$dead" "$participants"; do rule clickhouse topic literal "$topic" Read; done
for group in "$recent_group" "$late_group" "$dead_group" "$participant_group"; do
    rule clickhouse group literal "$group" Read
done
for topic in "$raw" "$live"; do
    rule live topic literal "$topic" Read
    hash=$(printf '%s' "$topic" | sha256sum)
    rule live group prefixed "recount-reader-${hash:0:12}-" Read
done
for topic in "$raw" "$normalized" "$late" "$dead" "$participants"; do
    rule kafka-exporter topic literal "$topic" Describe
done
for group in "$normalizer" "$recent_group" "$late_group" "$dead_group" "$participant_group"; do
    rule kafka-exporter group literal "$group" Describe
done

"${acl[@]}" --list > "$work/list"
awk '
  /ResourcePattern\(resourceType=/ {
    line=$0
    sub(/^.*ResourcePattern\(resourceType=/,"",line); sub(/\).*$/,"",line)
    split(line,a,", "); kind=a[1]; sub(/^name=/,"",a[2]); name=a[2]
    sub(/^patternType=/,"",a[3]); pattern=a[3]; next
  }
  /principal=/ {
    line=$0
    sub(/^.*principal=/,"",line); sub(/\).*$/,"",line)
    split(line,a,", "); sub(/^host=/,"",a[2]); sub(/^operation=/,"",a[3])
    sub(/^permissionType=/,"",a[4])
    print kind "\t" pattern "\t" name "\t" a[1] "\t" a[3] "\t" a[2] "\t" a[4]
  }
' "$work/list" | LC_ALL=C sort -u > "$work/actual"
LC_ALL=C sort -u -o "$work/expected" "$work/expected"
diff -u "$work/expected" "$work/actual"
