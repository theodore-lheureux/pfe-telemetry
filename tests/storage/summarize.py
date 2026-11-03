#!/usr/bin/env python3
"""Summarize a completed storage experiment; retain measured samples separately."""

import argparse
import json
import math
from pathlib import Path
import re


def distribution(values):
    values = sorted(values)
    if not values:
        return None
    return {"n": len(values), **{
        f"p{p}": values[max(0, math.ceil(len(values) * p / 100) - 1)]
        for p in (50, 95, 99)
    }, "max": values[-1]}


def byte_size(value):
    match = re.fullmatch(r"([\d.]+)([a-zA-Z]+)", value.strip())
    units = {"B": 1, "kB": 1000, "MB": 1000**2, "GB": 1000**3,
             "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}
    return float(match[1]) * units[match[2]]


def summarize(events):
    assert events[-1]["kind"] == "complete", "Experiment did not complete"
    scenarios = []
    for start in (v for v in events if v["kind"] == "phase_start"):
        name = start["scenario"]
        end = next(v for v in events if v["kind"] == "phase_end" and v["scenario"] == name)
        selected = [v for v in events if v.get("scenario") == name]
        queries = [v for v in selected if v["kind"] == "query" and v["label"] in ("range", "aggregate", "rates", "freshness")]
        acks = [a for v in selected if v["kind"] == "ingestion" and start["time_ns"] <= v["time_ns"] <= end["time_ns"] for a in v["acks"]]
        ack_by_sequence = {a["sequence"]: a for a in acks}
        visibility = {}
        for query in queries:
            if query["label"] == "freshness" and query["result"]:
                sequence = int(query["result"][0]["latest"])
                ack = ack_by_sequence.get(sequence)
                if ack and query["end_ns"] >= ack["ack_ns"]:
                    visibility[sequence] = min(visibility.get(sequence, float("inf")), (query["end_ns"] - ack["ack_ns"]) / 1e6)
        resources = {}
        for event in selected:
            if event["kind"] != "resources":
                continue
            for sample in event["samples"]:
                role = sample["Name"].removeprefix(name + "-")
                measured = {
                    "cpu_percent": float(sample["CPUPerc"].rstrip("%")),
                    "memory_bytes": byte_size(sample["MemUsage"].split(" / ")[0]),
                    "block_read_bytes": byte_size(sample["BlockIO"].split(" / ")[0]),
                    "block_write_bytes": byte_size(sample["BlockIO"].split(" / ")[1]),
                }
                peak = resources.setdefault(role, {key: 0 for key in measured})
                for key, value in measured.items():
                    peak[key] = max(peak[key], value)
        scenarios.append({
            "name": name, "readers": start["readers"], "write": start["write"],
            "phase_s": (end["time_ns"] - start["time_ns"]) / 1e9,
            "accepted_rows": len(acks) * 192,
            "accepted_rows_per_s": (len(acks) - 1) * 192 / ((acks[-1]["ack_ns"] - acks[0]["ack_ns"]) / 1e9) if len(acks) > 1 else None,
            "ack_ms": distribution([a["ack_ms"] for a in acks]),
            "sampled_latest_ack_to_observation_ms": distribution(list(visibility.values())),
            "queries": {label: {
                "errors": sum(v["failed"] for v in queries if v["label"] == label),
                "elapsed_ms": distribution([v["elapsed_ms"] for v in queries if v["label"] == label]),
                "engine_ms": distribution([v["engine_ms"] for v in queries if v["label"] == label and v["engine_ms"] is not None]),
            } for label in ("range", "aggregate", "rates", "freshness")},
            "resource_peaks": resources,
        })
    return {"parameters": events[0], "scenarios": scenarios,
            "integrity": [v for v in events if v["kind"] == "integrity"],
            "recovery": [v for v in events if v["kind"] in ("resume", "recovery_pass")],
            "completed_ns": events[-1]["time_ns"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    events = [json.loads(line) for line in (args.directory / "events.jsonl").read_text().splitlines()]
    result = summarize(events)
    (args.directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
