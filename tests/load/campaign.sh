#!/usr/bin/env bash
# Capacity and fault campaign on isolated allocations. See docs/clickhouse-evaluation.md for
# required settings; every command is appended to <run>/commands.log. On failure, background
# work and the main run's services stop, and the current sub-allocation is removed; the main
# allocation is kept for inspection until `recount-pipeline-load cleanup --run <run>`.
set -euo pipefail

run=${1:?usage: campaign.sh <absolute-run-directory> [phase...]}
shift
[[ "$run" == /* ]] || { echo 'Run directory must be absolute (k6 resolves paths from its script)' >&2; exit 1; }
phases=("$@")
if [[ ${#phases[@]} == 0 ]]; then
    phases=(prepare baseline step headroom workers k6 overload recovery soak structural authority)
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
tool=${RECOUNT_LOAD_BIN_DIR:?Set RECOUNT_LOAD_BIN_DIR to the directory with release binaries}/recount-pipeline-load
step_rates=${RECOUNT_LOAD_STEP_RATES:-10 25 50 100 150}
headroom_rates=${RECOUNT_LOAD_HEADROOM_RATES:-100 200 400 800}
soak_rate=${RECOUNT_LOAD_SOAK_RATE:-50}
soak_seconds=${RECOUNT_LOAD_SOAK_SECONDS:-1500}
mkdir -p "$run"
pids=()
current=""
toxiproxy=""

on_exit() {
    local status=$? pid
    [[ $status == 0 ]] && return
    trap - EXIT
    # Background entries are subshells; stop their children (the tool, k6) first.
    for pid in ${pids[@]+"${pids[@]}"} $toxiproxy; do
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
    done
    if [[ -n "$current" ]]; then
        "$tool" cleanup --run "$current" || true
    fi
    "$tool" stop --run "$run" ingestion-api || true
    "$tool" stop --run "$run" normalizer || true
    echo "campaign failed with status $status; remove the main allocation with: recount-pipeline-load cleanup --run $run" >&2
    exit "$status"
}
trap on_exit EXIT

# Remember a background job; `join` waits for each and fails if any failed.
track() { pids+=("$1"); }
join() {
    local pid
    for pid in ${pids[@]+"${pids[@]}"}; do
        wait "$pid"
    done
    pids=()
}

# Bash 3.2 compatible command record.
trace() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$run/commands.log"; }
load() {
    trace recount-pipeline-load "$@"
    "$tool" "$@"
}

# Concurrent reads of the given allocation: <run> <label> <duration> <rate>
queries() {
    trace "k6 clickhouse-queries.js run=$1 label=$2 duration=$3 rate=$4"
    mkdir -p "$1/phases/$2"
    RECOUNT_LOAD_QUERIES="$1/queries.json" RECOUNT_LOAD_K6_INPUTS="$1/k6-inputs.json" \
        RECOUNT_LOAD_CLICKHOUSE_URL="$RECOUNT_CLICKHOUSE_TEST_URL" RECOUNT_LOAD_DURATION="$3" \
        RECOUNT_LOAD_QUERY_RATE="$4" \
        k6 run --quiet --summary-export "$1/phases/$2/k6-queries.json" \
        "$root/tests/load/clickhouse-queries.js" >"$1/phases/$2/k6-queries.log" 2>&1
}

send() {
    local target=$1 label=$2
    shift 2
    load send --run "$target" --label "$label" "$@" >/dev/null
}

check() { load verify --run "$1" --label "$2" --wait 600 >"$1/phases/$2/verify.stdout.json"; }

release() {
    load cleanup --run "$1"
    current=""
}

# Allocation with services, k6 inputs and compiled web statements: <run> <prepare flags...>
allocate() {
    local target=$1
    shift
    if [[ "$target" != "$run" ]]; then
        current=$target
    fi
    load prepare --run "$target" "$@" >/dev/null
    load start --run "$target" ingestion-api
    load start --run "$target" normalizer
    load k6-inputs --run "$target"
    load protoset --out "$target/otlp.protoset"
    trace bun tests/load/queries.ts --allocation "$target/allocation.public.json"
    bun --no-env-file "$root/tests/load/queries.ts" --allocation "$target/allocation.public.json" --out "$target/queries.json"
}

phase_prepare() {
    # Shipped admission (1 in flight) and normalizer workers (2); 64 principals in 4 projects.
    allocate "$run" --projects 4 --direct-nodes 48 --linux-nodes 16
}

phase_baseline() {
    queries "$run" baseline 125s 2 &
    track $!
    send "$run" baseline --rate 10 --seconds 120
    join
    check "$run" baseline
}

phase_step() {
    for rate in $step_rates; do
        queries "$run" "step-$rate" 65s 4 &
        track $!
        send "$run" "step-$rate" --rate "$rate" --seconds 60
        join
        load drain --run "$run" --label "step-$rate" --timeout 600 >/dev/null
    done
    check "$run" step-"${step_rates##* }"
}

phase_headroom() {
    # Same pipeline with 8 admitted requests, to find the limit behind admission.
    local target="$run-headroom"
    allocate "$target" --projects 4 --direct-nodes 48 --linux-nodes 16 --ingestion-max-in-flight 8
    for rate in $headroom_rates; do
        queries "$target" "step-$rate" 65s 4 &
        track $!
        send "$target" "step-$rate" --rate "$rate" --seconds 60
        join
        load drain --run "$target" --label "step-$rate" --timeout 900 >/dev/null
    done
    check "$target" step-"${headroom_rates##* }"
    release "$target"
}

phase_workers() {
    # The 400 batches/s headroom step with eight normalizer workers instead of two.
    local target="$run-workers"
    allocate "$target" --projects 4 --direct-nodes 48 --linux-nodes 16 --ingestion-max-in-flight 8 \
        --normalizer-max-active 8
    queries "$target" step-400 65s 4 &
    track $!
    send "$target" step-400 --rate 400 --seconds 60
    join
    load drain --run "$target" --label step-400 --timeout 900 >/dev/null
    check "$target" step-400
    release "$target"
}

phase_k6() {
    load k6-inputs --run "$run"
    mkdir -p "$run/phases/k6-ramp"
    trace "k6 grpc-ramp.js label=k6-ramp points=16 stages=50/30s,200/90s,200/30s"
    RECOUNT_LOAD_K6_INPUTS="$run/k6-inputs.json" RECOUNT_LOAD_PROTOSET="$run/otlp.protoset" \
        RECOUNT_LOAD_LABEL=k6-ramp RECOUNT_LOAD_POINTS=16 \
        RECOUNT_LOAD_STAGES='[{"target":50,"duration":"30s"},{"target":200,"duration":"90s"},{"target":200,"duration":"30s"}]' \
        k6 run --quiet --console-output "$run/phases/k6-ramp/k6-console.log" \
        --summary-export "$run/phases/k6-ramp/k6-summary.json" "$root/tests/load/grpc-ramp.js" \
        >"$run/phases/k6-ramp/k6.log" 2>&1 || true
    load drain --run "$run" --label k6-ramp --timeout 600 >/dev/null
    check "$run" k6-ramp
}

phase_overload() {
    queries "$run" overload 65s 4 &
    track $!
    send "$run" overload --rate 1000 --seconds 60 --max-outstanding 256
    join
    load drain --run "$run" --label overload --timeout 600 >/dev/null
    check "$run" overload
}

phase_recovery() {
    send "$run" rec-normalizer --rate 50 --seconds 90 &
    track $!
    sleep 20
    load stop --run "$run" normalizer --kill
    sleep 30
    load start --run "$run" normalizer
    join
    load drain --run "$run" --label rec-normalizer --timeout 600 >/dev/null
    check "$run" rec-normalizer

    send "$run" rec-consumer --rate 50 --seconds 90 &
    track $!
    sleep 20
    load consumer --run "$run" pause
    sleep 30
    load consumer --run "$run" resume
    join
    load drain --run "$run" --label rec-consumer --timeout 600 >/dev/null
    check "$run" rec-consumer

    send "$run" rec-ingestion --rate 50 --seconds 60 --max-attempts 10 &
    track $!
    sleep 20
    load stop --run "$run" ingestion-api --kill
    sleep 5
    load start --run "$run" ingestion-api
    join
    load drain --run "$run" --label rec-ingestion --timeout 600 >/dev/null
    check "$run" rec-ingestion

    # Stored inserts whose offsets were not committed: replay them into new parts.
    load consumer --run "$run" pause
    load consumer --run "$run" rewind 5000
    load consumer --run "$run" resume
    mkdir -p "$run/phases/rec-replay"
    load drain --run "$run" --label rec-replay --timeout 600 >/dev/null
    check "$run" rec-replay

    # Lost responses: identical resends after the 2 s flush land in later insert blocks.
    send "$run" rec-resend --rate 50 --seconds 30 --resend-every 5 --resend-delay-ms 3000
    load drain --run "$run" --label rec-resend --timeout 600 >/dev/null
    check "$run" rec-resend

    # Delayed responses through Toxiproxy (400-2000 ms per chunk): client deadlines expire
    # after publication and identical retries follow.
    local api port proxy
    api=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ingestion_addr"])' "$run/allocation.json")
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
    proxy=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
    trace "toxiproxy latency=1200 jitter=800 downstream proxy=127.0.0.1:$proxy upstream=$api"
    toxiproxy-server -host 127.0.0.1 -port "$port" >"$run/logs/toxiproxy.log" 2>&1 &
    toxiproxy=$!
    sleep 1
    toxiproxy-cli --host "http://127.0.0.1:$port" create -l "127.0.0.1:$proxy" -u "$api" ingestion
    toxiproxy-cli --host "http://127.0.0.1:$port" toxic add -t latency -a latency=1200 -a jitter=800 -d ingestion
    send "$run" rec-toxiproxy --rate 20 --seconds 60 --timeout-ms 1000 --max-attempts 8 --connections 4 \
        --address "127.0.0.1:$proxy" --probe-interval-ms 0
    kill "$toxiproxy"
    wait "$toxiproxy" || true
    toxiproxy=""
    load drain --run "$run" --label rec-toxiproxy --timeout 600 >/dev/null
    check "$run" rec-toxiproxy

    # Live revocation of the last node under load; later phases exclude it.
    send "$run" rec-revocation --rate 20 --seconds 60 --probe-interval-ms 0 &
    track $!
    sleep 10
    load revoke --run "$run" 63 2>"$run/phases/rec-revocation/revoke.log"
    join
    # The admission path without Kafka publication: PERMISSION_DENIED after authentication.
    send "$run" auth-denied --rate 50 --seconds 30 --nodes 48 --foreign-resource --max-attempts 1 --probe-interval-ms 0
    check "$run" auth-denied
}

phase_soak() {
    queries "$run" soak "$((soak_seconds + 5))s" 2 &
    track $!
    send "$run" soak --rate "$soak_rate" --seconds "$soak_seconds" --nodes 63 --monitor-interval 15
    join
    load drain --run "$run" --label soak --timeout 600 >/dev/null
    check "$run" soak
}

phase_structural() {
    # Maximum-size requests (16,384 points, about 4 MB) over twelve partitions.
    local target="$run-structural"
    allocate "$target" --projects 1 --direct-nodes 4 --linux-nodes 1 --raw-partitions 12 \
        --normalized-partitions 12 --ingestion-max-in-flight 4
    send "$target" max-size --rate 1 --seconds 60 --nodes 4 --metrics 64 --points 256 \
        --series 16 --padding 160 --monitor-interval 2
    load drain --run "$target" --label max-size --timeout 900 >/dev/null
    check "$target" max-size
    release "$target"
}

phase_authority() {
    # 512 principals in 8 projects, accepted and denied: authority lookups must not follow
    # request rate. Then revocation of node 0 while it keeps sending. The one Linux node
    # only gives the query catalog a node chart.
    local target="$run-authority"
    allocate "$target" --projects 8 --direct-nodes 511 --linux-nodes 1 --ingestion-max-in-flight 8
    send "$target" auth-accepted --rate 200 --seconds 120 --metrics 1 --points 4 --probe-interval-ms 0
    send "$target" auth-denied --rate 200 --seconds 120 --metrics 1 --points 4 --foreign-resource \
        --max-attempts 1 --probe-interval-ms 0
    mkdir -p "$target/phases/auth-revoked"
    load revoke --run "$target" 0 2>"$target/phases/auth-revoked/revoke.log"
    send "$target" auth-revoked --rate 20 --seconds 45 --only-node 0 --max-attempts 1 --probe-interval-ms 0
    check "$target" auth-revoked
    release "$target"
}

for phase in "${phases[@]}"; do
    "phase_$phase"
done
