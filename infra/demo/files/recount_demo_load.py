"""Write small synthetic-load checkpoints without exposing partial JSON."""

import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

CPU_PROFILES = ("cpu-hash", "cpu-primes", "cpu-pi")
GPU_FIELDS = {
    "gpu-fp32": (1007,), "gpu-tensor": (1004,),
    "gpu-memory": (1005,), "gpu-mixed": (1007, 1004, 1005),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def plan(nodes, lab, project, cloud, profile, duration):
    require(re.fullmatch(r"[a-z][a-z0-9-]{0,23}", lab or ""), "Invalid load lab")
    require(re.fullmatch(r"[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}", project or ""), "Invalid load project")
    require(cloud in {"aws-cpu", "gcp-gpu"}, "Invalid load fleet")
    profiles = CPU_PROFILES if cloud == "aws-cpu" else GPU_FIELDS
    require(profile in profiles, "Choose a profile for the selected fleet")
    require(re.fullmatch(r"[1-9][0-9]{0,2}", str(duration)) and 1 <= int(duration) <= 300,
            "Load duration must be 1–300 seconds")
    require(2 <= len(nodes) <= 200 if cloud == "aws-cpu" else len(nodes) == 1,
            "Distributed CPU jobs need at least two nodes; GPU jobs need one")
    ordered = sorted(nodes, key=lambda node: node["name"])
    require(len({node["name"] for node in ordered}) == len(ordered), "Duplicate load node")
    require(all(node["lab_id"] == lab and node["cloud"] == cloud for node in ordered), "Unrelated load node")
    deadlines = [dt.datetime.fromisoformat(node["expires"].replace("Z", "+00:00")) for node in ordered]
    require(all(deadline.tzinfo is not None for deadline in deadlines), "VM expiry must include its timezone")
    expires = min(deadline.timestamp() for deadline in deadlines) - 15
    remaining = int(expires - time.time())
    require(remaining >= 30, "Too little VM lifetime remains for a load")
    return {
        "job_id": "load-" + uuid.uuid4().hex, "lab_id": lab, "project_id": project,
        "cloud": cloud, "profile": profile, "duration_seconds": min(int(duration), remaining),
        "expires_epoch": int(expires),
        "nodes": [{"name": node["name"], "instance_id": node["instance_id"], "shard": index}
                  for index, node in enumerate(ordered)],
    }


def integer(value, maximum=10**10):
    require(isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum,
            "Invalid load counter")
    return value


def summary(job, reports):
    require(re.fullmatch(r"load-[a-f0-9]{32}", job.get("job_id", "")), "Invalid recorded load job")
    expected = {node["name"]: node for node in job["nodes"]}
    require(len(expected) == len(job["nodes"]) and 1 <= len(expected) <= 200, "Invalid recorded load nodes")
    indexed = {report["name"]: report for report in reports}
    require(len(indexed) == len(reports) and set(indexed) <= set(expected), "Unrelated load report")
    cpu = job["profile"] in CPU_PROFILES
    require(cpu or job["profile"] in GPU_FIELDS, "Invalid recorded load profile")
    totals = {"operations": 0, "matches": 0, "checksum": 0}
    nodes = []
    for name, node in expected.items():
        report = indexed.get(name, {})
        value = report.get("result")
        if value is None:
            state = "missing"
            if report.get("service_state") == "failed":
                state = "failed"
            elif report.get("active", False):
                state = "starting"
            nodes.append({"name": name, "state": state})
            continue
        require(value.get("job_id") == job["job_id"] and value.get("profile") == job["profile"] and
                value.get("shard") == node["shard"] and value.get("shards") == len(expected),
                "The load report belongs to another job or shard")
        state = value.get("state")
        require(state in {"running", "completed", "stopped", "expired", "failed", "interrupted"}, "Invalid load state")
        elapsed = value.get("elapsed_seconds")
        require(isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool) and
                math.isfinite(elapsed) and 0 <= elapsed <= 330,
                "Invalid load elapsed time")
        if state == "running" and not report.get("active", False):
            state = "interrupted"
        public = {"name": name, "state": state, "elapsed_seconds": elapsed}
        if cpu:
            operations, matches = integer(value.get("operations")), integer(value.get("matches"))
            require(matches <= operations and re.fullmatch(r"[0-9]{1,80}", value.get("checksum", "")),
                    "Invalid CPU result")
            checksum = int(value["checksum"])
            if job["profile"] == "cpu-hash":
                require(checksum < 2**64, "Invalid hash reduction")
                totals["checksum"] ^= checksum
            else:
                totals["checksum"] += checksum
            totals["operations"] += operations
            totals["matches"] += matches
            public.update(operations=operations, matches=matches)
        else:
            bursts = integer(value.get("completed_bursts"), 1000)
            require(value.get("last_field") in {*GPU_FIELDS[job["profile"]], None}, "Invalid GPU profiling pipe")
            exit_code = value.get("exit_code")
            require(exit_code is None or (isinstance(exit_code, int) and not isinstance(exit_code, bool)
                                         and -128 <= exit_code <= 255), "Invalid GPU exit status")
            public.update(completed_bursts=bursts, last_field=value.get("last_field"), exit_code=exit_code)
        nodes.append(public)
    states = {node["state"] for node in nodes}
    state = "partial"
    if states == {"completed"}:
        state = "completed"
    elif "failed" in states:
        state = "failed"
    elif states & {"running", "starting"}:
        state = "running"
    elif states == {"stopped"}:
        state = "stopped"
    public = {key: job[key] for key in ("job_id", "lab_id", "project_id", "cloud", "profile", "duration_seconds")}
    public.update(state=state, nodes=nodes)
    if cpu:
        public["reduction"] = {
            "operations": totals["operations"], "matches": totals["matches"],
            "checksum": str(totals["checksum"]),
        }
        if job["profile"] == "cpu-pi" and totals["operations"]:
            public["reduction"]["pi_estimate"] = 4 * totals["matches"] / totals["operations"]
    return public


def checkpoint(path, value):
    path = Path(path)
    if path.is_symlink() or not path.parent.is_dir():
        raise ValueError("The job output must be in its existing private directory")
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
