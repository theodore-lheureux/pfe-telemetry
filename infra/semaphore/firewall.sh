#!/bin/sh
set -eu
subnet="${1:?Select the dedicated demo IPv4 /24}"
python3 - "$subnet" <<'PY'
import ipaddress
import sys
network = ipaddress.ip_network(sys.argv[1], strict=True)
if network.version != 4 or network.prefixlen != 24 or not network.is_private:
    raise SystemExit("Select a dedicated private IPv4 /24")
PY

# Only source-scoped jumps enter these owned chains. Never flush Docker or INPUT.
ipt() { iptables --wait 10 "$@"; }
ensure() {
    table_chain="$1"
    shift
    ipt -C "$table_chain" "$@" 2>/dev/null || ipt -A "$table_chain" "$@"
}
ipt -n -L DOCKER-USER >/dev/null
ipt -n -L RECOUNT_DEMO_FWD >/dev/null 2>&1 || ipt -N RECOUNT_DEMO_FWD
ipt -n -L RECOUNT_DEMO_HOST >/dev/null 2>&1 || ipt -N RECOUNT_DEMO_HOST
ensure RECOUNT_DEMO_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ensure RECOUNT_DEMO_FWD -d "$subnet" -j RETURN
for destination in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 100.64.0.0/10; do
    ensure RECOUNT_DEMO_FWD -d "$destination" -j REJECT
done
ensure RECOUNT_DEMO_FWD -j RETURN
ensure RECOUNT_DEMO_HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ensure RECOUNT_DEMO_HOST -j REJECT
ipt -C DOCKER-USER -s "$subnet" -j RECOUNT_DEMO_FWD 2>/dev/null ||
    ipt -I DOCKER-USER 1 -s "$subnet" -j RECOUNT_DEMO_FWD
ipt -C INPUT -s "$subnet" -j RECOUNT_DEMO_HOST 2>/dev/null ||
    ipt -I INPUT 1 -s "$subnet" -j RECOUNT_DEMO_HOST
