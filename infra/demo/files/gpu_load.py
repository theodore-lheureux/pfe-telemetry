"""Exercise selected DCGM profiling pipes with bounded bursts and idle periods."""

import argparse
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

from recount_demo_load import GPU_FIELDS, checkpoint

PROFILES = GPU_FIELDS


def tester():
    for name in ("dcgmproftester13", "dcgmproftester12", "dcgmproftester"):
        executable = shutil.which(name)
        if executable:
            return executable
    raise RuntimeError("The installed DCGM profiling tester is required")


def run(profile, job, duration, expires, output):
    if profile not in PROFILES or not re.fullmatch(r"load-[a-f0-9]{32}", job) or not 1 <= duration <= 300:
        raise ValueError("Invalid GPU job bounds")
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    allowed = min(duration, max(0, expires - time.time()))
    deadline = started + allowed
    result = {
        "job_id": job, "profile": profile, "shard": 0, "shards": 1,
        "state": "running", "completed_bursts": 0, "last_field": None,
        "elapsed_seconds": 0, "exit_code": None,
    }
    if allowed <= 0:
        result["state"] = "expired"
        checkpoint(output, result)
        return
    executable = tester()
    checkpoint(output, result)
    fields = PROFILES[profile]
    while not stopping and deadline - time.monotonic() >= 1:
        field = fields[result["completed_bursts"] % len(fields)]
        burst = min(5, int(deadline - time.monotonic()))
        result["last_field"] = field
        checkpoint(output, result)
        log = output.with_suffix(".dcgm.log")
        environment = {**os.environ, "RECOUNT_EXECUTION": job,
                       "RECOUNT_EXECUTION_NAME": profile + " demo job"}
        with log.open("ab") as stream:
            os.chmod(log, 0o600)
            process = subprocess.Popen(
                [executable, "--no-dcgm-validation", "-i", "0", "-t", str(field), "-d", str(burst)],
                stdout=stream, stderr=subprocess.STDOUT, env=environment, start_new_session=True,
            )
            try:
                stop_at = min(deadline, time.monotonic() + burst + 10)
                while process.poll() is None and not stopping and time.monotonic() < stop_at:
                    time.sleep(0.1)
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=3)
                result["exit_code"] = process.returncode
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
        if stopping:
            break
        if result["exit_code"] != 0:
            result["state"] = "interrupted" if time.monotonic() >= deadline else "failed"
            break
        result["completed_bursts"] += 1
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        checkpoint(output, result)
        idle_until = min(deadline, time.monotonic() + burst)
        while not stopping and time.monotonic() < idle_until:
            time.sleep(min(0.1, max(0, idle_until - time.monotonic())))
    if result["state"] == "running":
        result["state"] = "stopped" if stopping else "completed"
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    checkpoint(output, result)
    if result["state"] == "failed":
        raise RuntimeError("The DCGM profiling workload failed; inspect its private job log")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=tuple(PROFILES), required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--duration", type=int, required=True)
    parser.add_argument("--expires", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    run(arguments.profile, arguments.job, arguments.duration, arguments.expires, arguments.output)


if __name__ == "__main__":
    main()
