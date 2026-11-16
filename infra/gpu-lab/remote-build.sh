#!/usr/bin/env bash
set -euo pipefail
umask 077
directory=$1
archive_sha256=$2
test "$(id -u)" != 0
. "$(dirname "${BASH_SOURCE[0]}")/host.sh"
cd "$directory"
available_kib=$(df -Pk . | awk 'NR == 2 {print $4}')
test "$available_kib" -ge 20971520
printf '%s  source.tar.gz\n' "$archive_sha256" | sha256sum --check --strict

sudo -n apt-get update
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get --yes --no-install-recommends install \
    build-essential pkg-config ca-certificates curl python3
# Keep toolchains and all Cargo artifacts inside this owned lab directory.
export CARGO_HOME="$directory/cargo"
export RUSTUP_HOME="$directory/rustup"
export CARGO_TARGET_DIR="$directory/target"
export PYTHONDONTWRITEBYTECODE=1
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init \
    -o rustup-init
printf '%s  rustup-init\n' \
    20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c \
    | sha256sum --check --strict
chmod 700 rustup-init
./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.99.0
export PATH="$CARGO_HOME/bin:$PATH"
python3 source/infra/gpu-lab/build.py --snapshot "$directory/snapshot.json" \
    --output "$directory/bin"
"$directory/bin/recount-collector" --version
"$directory/bin/recount" --version
