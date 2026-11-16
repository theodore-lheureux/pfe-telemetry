#!/usr/bin/env bash
set -euo pipefail

[[ $EUID == 0 ]]
[[ $(stat -c '%a:%u' /etc/recount/data-mount) == 600:0 ]]
mapfile -t selection < /etc/recount/data-mount
[[ ${#selection[@]} == 2 && ${selection[0]} == /* && ${selection[1]} =~ ^[a-fA-F0-9-]+$ ]]
directory=${selection[0]}
uuid=${selection[1]}
[[ $(findmnt --mountpoint "$directory" --noheadings --output UUID) == "$uuid" ]] || {
    echo 'Expected data filesystem is not mounted; refusing boot-disk fallback' >&2; exit 1;
}
