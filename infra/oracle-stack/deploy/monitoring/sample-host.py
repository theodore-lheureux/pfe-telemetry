"""Publish a bounded, read-only snapshot of the ingestion host."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

PROJECT = "recount-ingestion"
CONTAINER = f"{PROJECT}-clickhouse-1"
POSTGRES = f"{PROJECT}-postgres-1"
CPU_SERVICES = ("ingestion-api", "normalizer", "kafka", "clickhouse")
TABLES = ("metric_points", "metric_series", "deliveries")
TABLE_LIST = ",".join(f"'{table}'" for table in TABLES)
PART_WINDOW_SECONDS = 120
CLICKHOUSE_EVENTS = {
    "SelectQuery": "select_queries_total",
    "FailedSelectQuery": "failed_select_queries_total",
    "SelectQueryTimeMicroseconds": "select_query_seconds_total",
}


def command(*args):
    return subprocess.check_output(args, text=True, timeout=3)


def cpu_metrics(service, pid):
    path = next(line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines()
                if line.startswith("0::"))
    group = Path("/sys/fs/cgroup") / path.lstrip("/")
    stats = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
    label = f'{{service="{service}"}}'
    yield f"recount_ingestion_container_cpu_seconds_total{label} {int(stats['usage_usec']) / 1e6}"
    if service == "clickhouse":
        for field, metric in (("nr_periods", "cpu_periods_total"),
                              ("nr_throttled", "cpu_throttled_periods_total")):
            yield f"recount_clickhouse_{metric} {int(stats[field])}"
        quota, period = (group / "cpu.max").read_text().split()
        if quota != "max":
            yield f"recount_clickhouse_cpu_limit_cores {int(quota) / int(period)}"


def containers():
    ids = command("docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={PROJECT}").split()
    if not ids:
        return {}
    rows = command("docker", "inspect", "--format", "{{.Name}}\t{{.State.Pid}}\t{{json .Mounts}}", *ids)
    return {name.lstrip("/"): (int(pid), json.loads(mounts))
            for name, pid, mounts in (line.split("\t") for line in rows.splitlines()) if int(pid) > 0}


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


def part_metrics():
    rows = clickhouse_query(
        "SELECT t.name, sumIf(l.rows,l.event_type='NewPart'), "
        "sumIf(l.read_rows,l.event_type='MergeParts'), "
        "sumIf(l.ProfileEvents['OSCPUVirtualTimeMicroseconds'],l.event_type='MergeParts') "
        "FROM system.tables AS t LEFT JOIN "
        "(SELECT table_uuid,event_type,rows,read_rows,ProfileEvents FROM system.part_log "
        f"WHERE event_date >= today()-1 AND event_time >= now()-{PART_WINDOW_SECONDS} "
        f"AND database='telemetry' AND table IN ({TABLE_LIST}) "
        "AND event_type IN ('NewPart','MergeParts') AND error=0) AS l ON t.uuid=l.table_uuid "
        f"WHERE t.database='telemetry' AND t.name IN ({TABLE_LIST}) GROUP BY t.name FORMAT TSV"
    )
    for table, inserted, merged, cpu_usec in (line.split("\t") for line in rows.splitlines()):
        label = f'{{table="{table}"}}'
        yield f"recount_clickhouse_new_rows_per_second{label} {int(inserted) / PART_WINDOW_SECONDS}"
        yield f"recount_clickhouse_merge_cpu_seconds_per_second{label} {int(cpu_usec) / (1e6 * PART_WINDOW_SECONDS)}"
        if int(inserted):
            yield f"recount_clickhouse_merge_rows_per_new_row{label} {int(merged) / int(inserted)}"


def active_part_metrics():
    rows = clickhouse_query(
        "SELECT t.name, countIf(p.active = 1) FROM system.tables AS t LEFT JOIN "
        f"(SELECT table, active FROM system.parts WHERE database='telemetry' AND table IN ({TABLE_LIST}) AND active) AS p "
        f"ON t.name=p.table WHERE t.database='telemetry' AND t.name IN ({TABLE_LIST}) GROUP BY t.name FORMAT TSV"
    )
    for table, parts in (line.split("\t") for line in rows.splitlines()):
        yield f'recount_clickhouse_active_parts{{table="{table}"}} {int(parts)}'


def active_node_metrics():
    count = command(
        "docker", "exec", "-e", "PGOPTIONS=-c statement_timeout=1000 -c default_transaction_read_only=on",
        POSTGRES, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "recount", "-d", "recount",
        "-c", "SELECT count(*) FROM ingestion.collector_node WHERE revoked_at IS NULL "
        "AND last_seen_at >= statement_timestamp() - interval '60 seconds'",
    )
    yield f"recount_ingestion_active_nodes {int(count)}"


def lineage_received_ns(data):
    """Read PointLineage.received_unix_nano (fixed64 field 4), not nested fields."""
    position = 0

    def varint():
        nonlocal position
        value = 0
        for shift in range(0, 70, 7):
            byte = data[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError("Invalid protobuf varint")

    try:
        while position < len(data):
            tag = varint()
            kind = tag & 7
            if tag == 33:
                if position + 8 > len(data):
                    break
                return int.from_bytes(data[position:position + 8], "little")
            if kind == 0:
                varint()
            elif kind == 1:
                position += 8
            elif kind == 2:
                length = varint()
                position += length
            elif kind == 5:
                position += 4
            else:
                break
    except IndexError:
        pass
    return None


def clickhouse_query(sql):
    return command("docker", "exec", CONTAINER, "clickhouse-client",
                   "--max_execution_time=2", "--max_threads=1", "--readonly=2", "--query", sql)


def freshness_metrics():
    # NewPart excludes background merges; only original parts still readable can
    # contribute. Bound both the candidate parts and the amount scanned.
    parts = clickhouse_query(
        "SELECT l.part_name, toUnixTimestamp64Nano(max(l.event_time_microseconds)) "
        "FROM system.part_log AS l INNER JOIN "
        "(SELECT name, uuid FROM system.tables WHERE database='telemetry' AND name='metric_points') AS t "
        "ON l.table_uuid=t.uuid "
        "WHERE l.event_date >= today()-1 AND l.event_time > now()-120 "
        "AND l.database='telemetry' AND l.table='metric_points' AND l.event_type='NewPart' "
        "AND l.error=0 "
        "AND l.part_name IN (SELECT name FROM system.parts WHERE database='telemetry' "
        "AND table='metric_points' AND active AND rows <= 50000) "
        "GROUP BY l.part_name ORDER BY max(l.event_time_microseconds) DESC LIMIT 4 FORMAT TSV"
    )
    inserted = {}
    for part, raw in (line.split("\t") for line in parts.splitlines()):
        if not re.fullmatch(r"[0-9]+(?:_[0-9]+){3,4}", part):
            raise ValueError("Unexpected telemetry part name")
        inserted[part] = int(raw)
    samples = []
    newest = 0
    if inserted:
        selected = ",".join(f"'{part}'" for part in inserted)
        points = clickhouse_query(
            "SELECT _part, hex(lineage) FROM telemetry.metric_points "
            f"PREWHERE _part IN ({selected}) AND cityHash64(sample_id) % 32 = 0 "
            "WHERE length(lineage) BETWEEN 1 AND 4096 LIMIT 8192 "
            "SETTINGS max_rows_to_read=220000,max_bytes_to_read=67108864,max_block_size=4096 FORMAT TSV"
        )
        for part, encoded in (line.split("\t") for line in points.splitlines()):
            received = lineage_received_ns(bytes.fromhex(encoded))
            written = inserted[part]
            if received and received <= written:
                samples.append((written - received) / 1e9)
                newest = max(newest, written)
    yield f"recount_ingestion_freshness_samples {len(samples)}"
    if samples:
        yield f"recount_ingestion_freshness_last_sample_timestamp_seconds {newest / 1e9}"
    if len(samples) >= 20:
        samples.sort()
        index = (95 * len(samples) + 99) // 100 - 1
        yield f"recount_ingestion_freshness_p95_seconds {samples[index]}"
        yield f"recount_ingestion_freshness_p95_samples {len(samples)}"
        yield f"recount_ingestion_freshness_p95_write_timestamp_seconds {newest / 1e9}"


def snapshot():
    lines = [f"recount_ingestion_host_sample_timestamp_seconds {int(time.time())}"]
    try:
        running = containers()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration):
        running = {}
    mounts = running.get(CONTAINER, (None, []))[1]
    data_path = next((mount["Source"] for mount in mounts if mount["Destination"] == "/var/lib/clickhouse"), None)
    for name, collect in (
        *(("cpu" if service == "clickhouse" else f"cpu_{service}",
           lambda service=service: cpu_metrics(service, running[f"{PROJECT}-{service}-1"][0]))
          for service in CPU_SERVICES),
        ("disk", lambda: disk_metrics(data_path) if data_path else ()),
        ("queries", query_metrics),
        ("part_log", part_metrics),
        ("active_parts", active_part_metrics),
        ("active_nodes", active_node_metrics),
        ("freshness", freshness_metrics),
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
