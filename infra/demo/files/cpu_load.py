"""Run one bounded shard of a synthetic distributed CPU job."""

import argparse
import hashlib
import math
from pathlib import Path
import random
import signal
import struct
import time

from recount_demo_load import CPU_PROFILES, checkpoint

PROFILES = CPU_PROFILES


def prime(number):
    if number < 2:
        return False
    if number % 2 == 0:
        return number == 2
    return all(number % divisor for divisor in range(3, math.isqrt(number) + 1, 2))


def batch(profile, block, seed, width=256):
    if profile not in PROFILES or block < 0 or not 1 <= width <= 4096:
        raise ValueError("Invalid CPU work block")
    result = {"operations": width, "matches": 0, "checksum": 0}
    start = block * width
    if profile == "cpu-primes":
        for number in range(start + 2, start + width + 2):
            if prime(number):
                result["matches"] += 1
                result["checksum"] += number
        return result
    if profile == "cpu-pi":
        generator = random.Random(int.from_bytes(seed, "big") ^ block)
        for _ in range(width):
            x, y = generator.random(), generator.random()
            result["matches"] += x * x + y * y <= 1
        return result
    for nonce in range(start, start + width):
        digest = hashlib.sha256(seed + struct.pack(">Q", nonce)).digest()
        result["matches"] += digest[0] == 0
        result["checksum"] ^= int.from_bytes(digest[:8], "big")
    return result


def combine(profile, partials):
    result = {"operations": 0, "matches": 0, "checksum": 0}
    for item in partials:
        result["operations"] += item["operations"]
        result["matches"] += item["matches"]
        if profile == "cpu-hash":
            result["checksum"] ^= item["checksum"]
        else:
            result["checksum"] += item["checksum"]
    return result


def run(profile, job, shard, shards, duration, expires, output):
    if profile not in PROFILES or not 0 <= shard < shards <= 200 or not 1 <= duration <= 300:
        raise ValueError("Invalid CPU job bounds")
    if not job.startswith("load-") or len(job) != 37:
        raise ValueError("Invalid load job ID")
    seed = bytes.fromhex(job[5:])
    if len(seed) != 16:
        raise ValueError("Invalid load job seed")
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    allowed = min(duration, max(0, expires - time.time()))
    deadline = started + allowed
    counters = {"operations": 0, "matches": 0, "checksum": 0}
    completed_blocks = 0
    next_checkpoint = started
    result = {
        "job_id": job, "profile": profile, "shard": shard, "shards": shards,
        "state": "running", "completed_blocks": 0, "operations": 0,
        "matches": 0, "checksum": "0", "elapsed_seconds": 0,
    }
    while not stopping and time.monotonic() < deadline:
        frame_start = time.monotonic()
        busy_until = min(frame_start + 0.05, deadline)
        while not stopping and time.monotonic() < busy_until:
            block = shard + completed_blocks * shards
            counters = combine(profile, [counters, batch(profile, block, seed)])
            completed_blocks += 1
        now = time.monotonic()
        if now >= next_checkpoint:
            result.update(
                completed_blocks=completed_blocks, operations=counters["operations"],
                matches=counters["matches"], checksum=str(counters["checksum"]),
                elapsed_seconds=round(now - started, 3),
            )
            checkpoint(output, result)
            next_checkpoint = now + 1
        time.sleep(max(0, min(frame_start + 0.1, deadline) - time.monotonic()))
    result.update(
        state="stopped" if stopping else "completed",
        completed_blocks=completed_blocks, operations=counters["operations"],
        matches=counters["matches"], checksum=str(counters["checksum"]),
        elapsed_seconds=round(time.monotonic() - started, 3),
    )
    if allowed <= 0:
        result["state"] = "expired"
    checkpoint(output, result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--duration", type=int, required=True)
    parser.add_argument("--expires", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    run(arguments.profile, arguments.job, arguments.shard, arguments.shards,
        arguments.duration, arguments.expires, arguments.output)


if __name__ == "__main__":
    main()
