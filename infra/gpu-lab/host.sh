#!/usr/bin/env bash
test "$(uname -m)" = x86_64
. /etc/os-release
test "$ID:$VERSION_ID" = ubuntu:22.04
test ! -e /.dockerenv
# Reading init's namespace link requires root.
test "$(readlink /proc/self/ns/pid)" = "$(sudo -n readlink /proc/1/ns/pid)" || { echo "Collector host must share the host PID namespace" >&2; exit 1; }
gpu_model=$(nvidia-smi --query-gpu=name --format=csv,noheader)
# Exact output matching also rejects more than one visible GPU.
case "$gpu_model" in
    "NVIDIA L4"|"Tesla T4"|"NVIDIA T4"|"NVIDIA A10") ;;
    *) echo "Expected exactly one NVIDIA L4, T4 or A10; observed: $gpu_model" >&2; exit 1 ;;
esac
