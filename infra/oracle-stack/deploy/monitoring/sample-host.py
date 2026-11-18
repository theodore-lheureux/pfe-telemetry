"""Publish a bounded, read-only snapshot of ClickHouse and its data device."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

CONTAINER = "recount-ingestion-clickhouse-1"
CLICKHOUSE_EVENTS = {
    "SelectQuery": "select_queries_total",
    "FailedSelectQuery": "failed_select_queries_total",
    "SelectQueryTimeMicroseconds": "select_query_seconds_total",
}


def command(*args):
    return subprocess.check_output(args, text=True, timeout=4)


def cpu_metrics(pid):
    path = next(line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines()
                if line.startswith("0::"))
    group = Path("/sys/fs/cgroup") / path.lstrip("/")
    stats = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
    for field, metric in (("nr_periods", "cpu_periods_total"),
                          ("nr_throttled", "cpu_throttled_periods_total")):
        yield f"recount_clickhouse_{metric} {int(stats[field])}"
    yield f"recount_clickhouse_cpu_seconds_total {int(stats['usage_usec']) / 1e6}"
    quota, period = (group / "cpu.max").read_text().split()
    if quota != "max":
        yield f"recount_clickhouse_cpu_limit_cores {int(quota) / int(period)}"


def disk_metrics(data_path):
    device = Path(data_path).stat().st_dev
    for line in Path("/proc/diskstats").read_text().splitlines():
        major, minor, _, *values = line.split()
        if (int(major), int(minor)) == (os.major(device), os.minor(device)):
            yield f"recount_data_device_reads_total {int(values[0])}"
            yield f"recount_data_device_read_seconds_total {int(values[3]) / 1000}"
            yield f"recount_data_device_writes_total {int(values[4])}"
            yield f"recount_data_device_write_seconds_total {int(values[7]) / 1000}"
            return
    raise ValueError("ClickHouse mount device is not present in diskstats")


def query_metrics():
    rows = command("docker", "exec", CONTAINER, "clickhouse-client", "--readonly=1",
                   "--query", "SELECT event,value FROM system.events WHERE event IN "
                   "('SelectQuery','FailedSelectQuery','SelectQueryTimeMicroseconds') FORMAT TSV")
    values = {name: int(raw) for name, raw in (line.split("\t") for line in rows.splitlines())}
    for event, name in CLICKHOUSE_EVENTS.items():
        if event in values:
            value = values[event]
            if event.endswith("Microseconds"):
                value /= 1e6
            yield f"recount_clickhouse_{name} {value}"


def point_metrics():
    value = command(
        "docker", "exec", CONTAINER, "clickhouse-client", "--max_execution_time=2",
        "--readonly=1", "--query", "SELECT sum(rows) FROM system.part_log "
        "WHERE event_date >= today()-1 AND event_time >= now()-120 "
        "AND database='telemetry' AND table='metric_points' AND event_type='NewPart'",
    )
    yield f"recount_clickhouse_points_written_per_second {int(value) / 120}"


def snapshot():
    lines = [f"recount_ingestion_host_sample_timestamp_seconds {int(time.time())}"]
    try:
        pid = int(command("docker", "inspect", "--format", "{{.State.Pid}}", CONTAINER))
        if pid < 1:
            raise ValueError("ClickHouse is not running")
        mounts = json.loads(command("docker", "inspect", "--format", "{{json .Mounts}}", CONTAINER))
        data_path = next(mount["Source"] for mount in mounts if mount["Destination"] == "/var/lib/clickhouse")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration):
        pid, data_path = None, None
    for name, collect in (
        ("cpu", lambda: cpu_metrics(pid) if pid else ()),
        ("disk", lambda: disk_metrics(data_path) if data_path else ()),
        ("queries", query_metrics),
        ("points", point_metrics),
    ):
        try:
            values = list(collect())
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration):
            values = []
        lines.append(f'recount_ingestion_host_source_up{{source="{name}"}} {int(bool(values))}')
        lines.extend(values)
    return "\n".join(lines) + "\n"


def main():
    output = Path("/var/lib/recount/monitoring/metrics")
    descriptor, temporary = tempfile.mkstemp(prefix=".metrics-", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w") as file:
            file.write(snapshot())
            os.fchmod(file.fileno(), 0o644)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
