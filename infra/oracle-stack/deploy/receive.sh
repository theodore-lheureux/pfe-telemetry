#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID == 0 && $# == 3 ]] || exit 2
release=$1 arch=$2 digest=$3
[[ $release =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ && $arch =~ ^(arm64|amd64)$ && $digest =~ ^[a-f0-9]{64}$ ]] || exit 2
case "$arch:$(uname -m)" in
    amd64:x86_64|arm64:aarch64) ;;
    *) echo 'Release architecture does not match this VM' >&2; exit 1 ;;
esac
exec 9>/opt/recount/deploy.lock
flock -n 9
repository=$(cat /etc/recount/repository)
[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
directory="/opt/recount/releases/$release"
[[ ! -e $directory ]] || { echo 'Release already staged; inspect it before retrying' >&2; exit 1; }
read -r total available < <(df --output=size,avail -B1 /opt/recount | tail -1)
[[ $available -ge $((total * 3 / 10 + 8589934592)) ]] || {
    echo 'Staging needs 8 GiB free in addition to a 30% filesystem reserve' >&2; exit 1;
}
mkdir "$directory"
archive="$directory/release.tar.gz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 600 \
    --max-filesize 2147483648 \
    "https://github.com/$repository/releases/download/release-$release/recount-stack-$arch.tar.gz" \
    --output "$archive"
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status
tar --extract --gzip --no-same-owner --file "$archive" --directory "$directory"
[[ $(cat "$directory/release") == "$release" && $(cat "$directory/arch") == "$arch" ]]
bash "$directory/activate.sh" "$directory"
