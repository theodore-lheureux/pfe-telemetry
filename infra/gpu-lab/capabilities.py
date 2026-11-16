"""Expected profiling coverage from the host's dcgmi profile -l output."""

import argparse
import json
from pathlib import Path
import re

PROFILING = {
    1001: ("recount.gpu.engine.activity", {}),
    1002: ("recount.gpu.sm.activity", {}),
    1003: ("recount.gpu.sm.occupancy", {}),
    1004: ("recount.gpu.pipe.activity", {"/gpu.pipe": "tensor"}),
    1005: ("recount.gpu.dram.activity", {}),
    1006: ("recount.gpu.pipe.activity", {"/gpu.pipe": "fp64"}),
    1007: ("recount.gpu.pipe.activity", {"/gpu.pipe": "fp32"}),
    1008: ("recount.gpu.pipe.activity", {"/gpu.pipe": "fp16"}),
    1009: ("recount.gpu.pcie.throughput", {"/gpu.io.direction": "tx"}),
    1010: ("recount.gpu.pcie.throughput", {"/gpu.io.direction": "rx"}),
    1011: ("recount.gpu.nvlink.throughput", {"/gpu.io.direction": "tx"}),
    1012: ("recount.gpu.nvlink.throughput", {"/gpu.io.direction": "rx"}),
}
PIPES = {1004: "tensor", 1006: "fp64", 1007: "fp32", 1008: "fp16"}


def parse_capabilities(text):
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    offered = sorted(set(map(int, re.findall(r"\b(?:100[1-9]|101[0-2])\b", text))))
    loads = sorted(set(offered) & set(PIPES))
    if not loads:
        raise ValueError("dcgmi profile -l did not offer a supported compute-pipe load field")
    return {
        "offered_fields": offered,
        "unavailable_fields": sorted(set(PROFILING) - set(offered)),
        "load_fields": loads,
        "supported_pipes": [PIPES[field] for field in loads],
        "unsupported_pipes": [name for field, name in PIPES.items() if field not in offered],
    }


def matches(point, field, status=False):
    metric, dimensions = PROFILING[field]
    attributes = dict(point["attributes"])
    if status:
        if point["metric_name"] != "recount.collection.read.status":
            return False
        if attributes.get("/recount.metric.name") != metric:
            return False
    elif point["metric_name"] != metric:
        return False
    return all(attributes.get(key) == value for key, value in dimensions.items())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.output.open("x") as file:
        json.dump(parse_capabilities(args.log.read_text()), file, indent=2)
        file.write("\n")
