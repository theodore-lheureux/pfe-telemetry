#!/usr/bin/env python3
"""Bounded workload payload shared by standalone and Slurm launches."""

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("category", choices=["cpu", "memory", "io", "distributed"])
    parser.add_argument("seconds", type=int)
    parser.add_argument("seed", type=int)
    args = parser.parse_args()
    if not 1 <= args.seed < 2**32:
        parser.error("seed must be between 1 and 4294967295")
    if not 30 <= args.seconds <= 120:
        parser.error("seconds must be between 30 and 120")
    directory = Path(__file__).resolve().parent
    output = directory / "tool-result.json"
    command = [
        "stress-ng", "--keep-name", "--seed", str(args.seed), "--timeout", f"{args.seconds}s",
        "--metrics-brief", "--yaml", str(directory / "tool-result.yaml"),
    ]
    if args.category in ["cpu", "distributed"]:
        command += ["--cpu", "1", "--cpu-method", "sqrt"]
    elif args.category == "memory":
        command += ["--vm", "1", "--vm-bytes", "128M", "--vm-keep", "--vm-method", "write64"]
    else:
        command = [
            "fio", "--output-format=json", f"--output={output}",
            f"--directory={directory}", f"--runtime={args.seconds}", "--size=64M",
            "--numjobs=1", "--randrepeat=1", f"--randseed={args.seed}",
            str(directory / "sequential-write.fio"),
        ]
    tool = command[0]
    result = {
        "category": args.category,
        "execution_key": os.environ.get("RECOUNT_EXECUTION") or f"slurm:{os.environ['SLURM_JOB_ID']}",
        "seed": args.seed,
        "duration_seconds": args.seconds,
        "command": command,
        "node": {
            "hostname": socket.gethostname(),
            "logical_cpus": os.cpu_count(),
            "kernel": os.uname().release,
            "architecture": os.uname().machine,
            "memory_total_bytes": os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"),
        },
        "versions": {
            name: subprocess.check_output([name, "--version"], text=True).strip()
            for name in [tool, "recount", "srun"]
        },
        "slurm_rank": os.environ.get("SLURM_PROCID"),
        "started_unix_nano": time.time_ns(),
    }
    process = subprocess.run(command, capture_output=True, text=True, timeout=args.seconds + 45)
    result.update({
        "ended_unix_nano": time.time_ns(),
        "returncode": process.returncode,
        "stdout": process.stdout,
        "stderr": process.stderr,
    })
    (directory / "run.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"execution_key": result["execution_key"], "hostname": socket.gethostname()}), flush=True)
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
