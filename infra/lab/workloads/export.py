#!/usr/bin/env python3
"""Export execution-scoped evidence from the existing ClickHouse service."""

import argparse
from collections import defaultdict
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess


EXPECTED_BEHAVIOR = {
    "cpu": "One busy CPU worker, small resident set and negligible disk I/O.",
    "memory": "128 MiB worker allocation plus process overhead; write64 also consumes CPU.",
    "io": "Increasing direct-write byte counter with negligible reads.",
    "distributed": "CPU time grows on both nodes under one scheduler-derived execution key.",
}


def summarize(points):
    series = defaultdict(list)
    rss = defaultdict(int)
    for point in points:
        segment = dict(point["attributes"]).get("/recount.counter.segment_id")
        series[(point["source_id"], point["series_id"], segment)].append(point)
        if point["metric_name"] == "recount.process.memory.rss":
            rss[(point["source_id"], point["time_unix_milli"])] += int(point["int_value"])
    counters = defaultdict(int)
    counters_by_node = defaultdict(lambda: defaultdict(int))
    intervals = defaultdict(list)
    for values in series.values():
        first, last = values[0], values[-1]
        if first["metric_name"] not in ["process.cpu.time", "process.disk.io"]:
            continue
        if any(row["temporality"] != 2 or row["monotonic"] != 1 for row in values):
            raise ValueError("Expected cumulative monotonic process counters")
        numbers = [
            float(row["double_value"]) if row["double_value"] is not None else int(row["int_value"])
            for row in values
        ]
        if any(b < a for a, b in zip(numbers, numbers[1:])):
            raise ValueError("Counter decreased inside a segment")
        attributes = dict(first["attributes"])
        direction = attributes.get("/disk.io.direction", "")
        key = first["metric_name"] + (f":{direction}" if direction else "")
        counters[key] += numbers[-1] - numbers[0]
        counters_by_node[first["source_id"]][key] += numbers[-1] - numbers[0]
        intervals[first["source_id"]].append(
            (int(first["time_unix_milli"]), int(last["time_unix_milli"]))
        )
    return {
        "point_count": len(points),
        "metric_names": sorted({row["metric_name"] for row in points}),
        "scope_versions": sorted({row["scope_version"] for row in points}),
        "sampled_counter_deltas": dict(sorted(counters.items())),
        "sampled_counter_deltas_by_node": {
            node: dict(sorted(values.items()))
            for node, values in sorted(counters_by_node.items())
        },
        "peak_process_rss_sum_bytes_by_node": {
            node: max(value for (source, _), value in rss.items() if source == node)
            for node in sorted({key[0] for key in rss})
        },
        "counter_sample_span_seconds_by_node": {
            node: (max(end for _, end in spans) - min(start for start, _ in spans)) / 1e3
            for node, spans in sorted(intervals.items())
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--project", required=True)
    parser.add_argument("--deployed-commit", required=True)
    parser.add_argument("--offline", action="store_true", help="Recompute from saved facts and points")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    summaries = []
    for category in ["cpu", "memory", "io", "distributed"]:
        runs = [json.loads(path.read_text()) for path in sorted((args.directory / category).glob("*/run.json"))]
        if not runs or any(run["returncode"] != 0 for run in runs):
            raise ValueError(f"{category}: missing or failed workload")
        key = runs[0]["execution_key"]
        if any(run["execution_key"] != key for run in runs):
            raise ValueError("Distributed tasks did not share one key")

        def query(filename):
            return subprocess.check_output([
                "docker", "exec", os.environ["RECOUNT_CLICKHOUSE_CONTAINER"], "clickhouse-client",
                "--readonly=1", "--max_execution_time=30",
                "--max_memory_usage=268435456", "--max_result_rows=100000",
                "--result_overflow_mode=throw",
                f"--param_project={args.project}", f"--param_execution={key}",
                f"--param_start={min(run['started_unix_nano'] for run in runs) - 2_000_000_000}",
                f"--param_end={max(run['ended_unix_nano'] for run in runs) + 2_000_000_000}",
                "--query", (source / filename).read_text(),
            ], text=True)

        destination = args.directory / category
        participants_text = (
            (destination / "participants.jsonl").read_text() if args.offline else query("participants.sql")
        )
        participants = [json.loads(line) for line in participants_text.splitlines()]
        live = [fact for fact in participants if not fact["retracted"]]
        expected_nodes = 2 if category == "distributed" else 1
        if len({fact["node_id"] for fact in live}) != expected_nodes:
            raise ValueError(f"{category}: expected {expected_nodes} nodes")
        if not live or any(fact["ended_unix_nano"] is None for fact in live):
            raise ValueError(f"{category}: wait for closed facts before exporting")
        points_text = (
            gzip.decompress((destination / "points.jsonl.gz").read_bytes()).decode()
            if args.offline else query("points.sql")
        )
        points = [json.loads(line) for line in points_text.splitlines()]
        if not points:
            raise ValueError(f"{category}: no associated points")
        (destination / "participants.jsonl").write_text(participants_text)
        (destination / "points.jsonl.gz").write_bytes(gzip.compress(points_text.encode(), mtime=0))
        summaries.append({
            "category": category,
            "expected_behavior": EXPECTED_BEHAVIOR[category],
            "execution_key": key,
            "node_count": expected_nodes,
            "participant_count": sum(fact["kind"] == 1 for fact in live),
            "membership_count": sum(fact["kind"] == 2 for fact in live),
            "environment_variables": sorted({fact["environment_variable"] for fact in live}),
            **summarize(points),
        })
    manifest = {
        "project_id": args.project,
        "deployed_commit": args.deployed_commit,
        "workloads": summaries,
        "sha256": {
            str(path.relative_to(args.directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(args.directory.rglob("*"))
            if path.is_file() and path.name != "manifest.json"
        },
    }
    (args.directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(summaries, indent=2))


if __name__ == "__main__":
    main()
