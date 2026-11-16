#!/usr/bin/env bash
set -euo pipefail
umask 077
directory=$1
execution=$2
cd "$directory"
test "$(id -u)" = 0
. "$directory/host.sh"
./recount-collector --version
./recount --version
nvidia-smi -q > hardware.log
cuda=$(sed -En 's/^CUDA Version[ :]+([0-9]+)[.].*/\1/p' hardware.log)
[[ "$cuda" =~ ^(12|13)$ ]]

curl --fail --silent --show-error --location \
    https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb \
    -o cuda-keyring.deb
dpkg -i cuda-keyring.deb
apt-get update
packages=("datacenter-gpu-manager-4-cuda$cuda" datacenter-gpu-manager-4-proprietary
    "datacenter-gpu-manager-4-proprietary-cuda$cuda")
# A fresh lab must not replace its preinstalled driver or remove existing packages.
apt-get --simulate --no-install-recommends install "${packages[@]}" > packages-plan.log
if grep -Eq '^(Remv |Inst (nvidia-driver|cuda-drivers|linux-image|libnvidia-compute))' packages-plan.log; then
    echo "DCGM installation would modify the driver; inspect packages-plan.log" >&2
    exit 1
fi
DEBIAN_FRONTEND=noninteractive apt-get --yes --no-install-recommends install "${packages[@]}"
dpkg-query -W 'datacenter-gpu-manager*' > packages.log
ldconfig
proftester=$(command -v "dcgmproftester$cuda")
systemctl start nvidia-dcgm
dcgmi discovery -l > discovery.log
dcgmi profile -l > capabilities.log
python3 capabilities.py capabilities.log capabilities.json
read -r -a fields <<< "$(python3 -c 'import json; print(*json.load(open("capabilities.json"))["load_fields"])')"

collector=
cleanup() {
    if [[ -n "$collector" ]]; then
        kill -INT "$collector" 2>/dev/null || true
        wait "$collector" || true
    fi
    if [[ -f node/node.json ]]; then
        cp node/node.json node.json
    fi
    rm -f enrollment.key
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
printf '{"heartbeat_interval_seconds":5}\n' > participants.json
./recount-collector --visibility host --interval-ms 1000 \
    --endpoint http://127.0.0.1:43170 \
    --enrollment-url http://127.0.0.1:30070 \
    --enrollment-key-file "$directory/enrollment.key" \
    --participants-config "$directory/participants.json" \
    --state-directory "$directory/node" --queue-directory "$directory/queue" \
    > collector.log 2>&1 &
collector=$!
for ((attempt=0; attempt<60; attempt++)); do
    kill -0 "$collector"
    [[ ! -f node/node.json ]] || break
    sleep 1
done
test -f node/node.json
rm -f enrollment.key
sleep 10
cat > load.sh <<'LOAD'
#!/usr/bin/env bash
set -euo pipefail
tester=$1
shift
for field in "$@"; do
    printf '%s %s start\n' "$(date --iso-8601=ns)" "$field" >> phases.log
    "$tester" --no-dcgm-validation -i 0 -t "$field" -d 30 > "load-$field.log" 2>&1
    printf '%s %s end\n' "$(date --iso-8601=ns)" "$field" >> phases.log
    sleep 5
done
LOAD
./recount run --execution "$execution" --name "NVIDIA GPU validation" \
    --param "device=$gpu_model" -- bash "$directory/load.sh" "$proftester" "${fields[@]}"
# Let final membership observations and queued telemetry reach the local stack.
sleep 15
kill -0 "$collector"
