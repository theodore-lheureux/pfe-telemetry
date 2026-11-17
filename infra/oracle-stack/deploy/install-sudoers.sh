#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $EUID == 0 ]] || { echo 'Run this reviewed bootstrap as root' >&2; exit 1; }
source_rule=${1:-"$(dirname "$0")/sudoers"}
destination=/etc/sudoers.d/recount-release
expected='ocarun ALL=(root) NOPASSWD: /usr/local/sbin/recount-release *'
[[ -f $source_rule && ! -L $source_rule && ! -L $destination ]]
printf '%s\n' "$expected" | cmp --silent "$source_rule" - || {
    echo 'Refusing a sudoers rule other than the reviewed receiver-only grant' >&2; exit 1;
}
getent passwd ocarun >/dev/null
# The absent receiver path must not become a root-code injection point.
for directory in /etc /etc/sudoers.d /usr /usr/local /usr/local/sbin; do
    [[ -d $directory && $(stat -Lc '%u' "$directory") == 0 ]]
    mode=$(stat -Lc '%a' "$directory")
    (( (8#$mode & 022) == 0 )) || {
        echo 'Receiver and sudoers parent directories must not be group/world writable' >&2; exit 1;
    }
done
if [[ -e /usr/local/sbin/recount-release ]]; then
    [[ -f /usr/local/sbin/recount-release && ! -L /usr/local/sbin/recount-release ]]
    [[ $(stat -c '%u' /usr/local/sbin/recount-release) == 0 ]]
    mode=$(stat -c '%a' /usr/local/sbin/recount-release)
    (( (8#$mode & 022) == 0 ))
fi
visudo -c >/dev/null
# sudo's includedir ignores dotted filenames until the validated rule is linked.
temporary=$(mktemp /etc/sudoers.d/.recount-release.XXXXXXXX)
created=false
cleanup() {
    local status=$?
    rm -f "$temporary"
    if [[ $status != 0 && $created == true ]]; then
        rm -f "$destination"
    fi
}
trap cleanup EXIT
install -o root -g root -m 0440 "$source_rule" "$temporary"
visudo -c -f "$temporary" >/dev/null
if [[ -e $destination ]]; then
    cmp --silent "$source_rule" "$destination" || {
        echo 'Existing receiver sudoers file differs; inspect it before replacing it' >&2; exit 1;
    }
    chown root:root "$destination"
    chmod 0440 "$destination"
else
    ln "$temporary" "$destination"
    created=true
fi
visudo -c
listing=$(sudo -n -u ocarun sudo -n -l)
mapfile -t rules < <(printf '%s\n' "$listing" | sed -n '/^[[:space:]]*(/s/^[[:space:]]*//p')
[[ ${#rules[@]} == 1 && ${rules[0]} == '(root) NOPASSWD: /usr/local/sbin/recount-release *' ]] || {
    echo 'ocarun has an unexpected sudo command set; no unrelated rules were changed' >&2; exit 1;
}
[[ $(stat -c '%u:%g:%a' "$destination") == 0:0:440 ]]
echo 'Reviewed sudoers rule installed and validated; ocarun may invoke only the receiver.'
if [[ ! -x /usr/local/sbin/recount-release ]]; then
    echo 'The receiver is not installed yet; complete the remaining host bootstrap before deployment.'
fi
