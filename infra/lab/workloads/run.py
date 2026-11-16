#!/usr/bin/env python3
"""Run labelled workloads on existing VMs without changing their configuration."""

import argparse
import base64
import gzip
import json
import os
from pathlib import Path
import re
import shlex
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_id", help="Unique ID; reuse would join existing executions")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", args.run_id):
        parser.error("run_id must contain 1-64 lowercase letters, digits or hyphens")
    if not 1 <= args.seed < 2**32:
        parser.error("seed must be between 1 and 4294967295")
    if not 30 <= args.seconds <= 120:
        parser.error("seconds must be between 30 and 120")
    checkout = Path(os.environ["RECOUNT_LAB_CHECKOUT"]).resolve()
    if not os.environ.get("VAGRANT_DOTFILE_PATH"):
        parser.error("Export the existing VAGRANT_DOTFILE_PATH before running")
    args.output.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).resolve().parent
    profile = source.parent / "ansible/files/sequential-write.fio"

    def ssh(node, command):
        process = subprocess.run(
            ["just", "lab", "vagrant", "ssh", node, "-c", command],
            cwd=checkout, text=True, capture_output=True, timeout=args.seconds + 150,
            check=True,
        )
        return process.stdout

    status = subprocess.check_output(
        ["just", "lab", "vagrant", "status", "--machine-readable"], cwd=checkout, text=True,
    )
    for node in ["node1", "node2"]:
        if f",{node},state,running" not in status:
            raise RuntimeError(f"{node} is not running; inspect it before resuming")
    preflight = {
        node: ssh(
            node,
            "set -e; hostname; systemctl is-active recount-collector; "
            'sha256sum "$(command -v recount-collector)" "$(command -v recount)"; '
            "sinfo -N -h; squeue -h",
        )
        for node in ["node1", "node2"]
    }
    (args.output / "preflight.json").write_text(json.dumps(preflight, indent=2) + "\n")
    launches = []
    for category in ["cpu", "memory", "io", "distributed"]:
        directory = f"/var/tmp/recount-workloads-{args.run_id}-{category}"
        nodes = ["node1", "node2"] if category == "distributed" else ["node1"]
        for node in nodes:
            install = f"set -e; umask 077; mkdir {shlex.quote(directory)}"
            for name, path in [("guest.py", source / "guest.py"), ("sequential-write.fio", profile)]:
                payload = base64.b64encode(path.read_bytes()).decode()
                install += f"; printf %s {payload} | base64 -d > {shlex.quote(directory + '/' + name)}"
            ssh(node, install)
        payload = ["python3", f"{directory}/guest.py", category, str(args.seconds), str(args.seed)]
        if category == "distributed":
            command = [
                "srun", f"--job-name={args.run_id}", "--nodes=2", "--ntasks=2",
                "--ntasks-per-node=1", "--cpus-per-task=1", "--mem=192M",
                "--time=00:03:00", "--immediate=30", "--mpi=none", *payload,
            ]
        else:
            command = [
                "recount", "run", "--execution", f"run:{args.run_id}-{category}",
                "--name", f"Workload {category}", "--version", "0.1.0",
                "--param", f"category={category}", "--param", f"seed={args.seed}",
                "--param", f"duration_seconds={args.seconds}", "--", *payload,
            ]
        transcript = ssh("node1", shlex.join(command))
        launches.append({"category": category, "command": command, "stdout": transcript})
        for node in nodes:
            destination = args.output / category / node
            destination.mkdir(parents=True)
            for filename in ["run.json", "tool-result.json" if category == "io" else "tool-result.yaml"]:
                text = ssh(node, f"cat {shlex.quote(directory + '/' + filename)}")
                if filename.startswith("tool-result."):
                    (destination / (filename + ".gz")).write_bytes(gzip.compress(text.encode(), mtime=0))
                else:
                    (destination / filename).write_text(text)
        (args.output / "launches.json").write_text(json.dumps(launches, indent=2) + "\n")
        print(f"{category}: complete", flush=True)


if __name__ == "__main__":
    main()
