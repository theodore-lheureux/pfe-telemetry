"""Send success-only heartbeats for the Oracle ingestion stack."""

from functools import cache
import http.client
import ipaddress
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "recount-ingestion"
SECRETS = Path("/etc/recount/betterstack-heartbeats.env")
TARGETS = ("KAFKA", "NORMALIZERS", "CLICKHOUSE", "POSTGRES", "PIPELINE")
TOPICS = {
    "recount.metrics.raw": 3,
    "recount.metrics.normalized-packed": 3,
    "recount.metrics.late": 3,
    "recount.metrics.dead-letter": 1,
    "recount.participants": 3,
}
RAW = "recount.metrics.raw"
LIVE = "recount.metrics.live"
LIVE_PARTITIONS = 8
RAW_LAG_LIMIT = 1000
FRESH_SECONDS = 180
INGEST_HOST = "ingest.recount.cloud"
EXPORTER = f"{PROJECT}-monitoring-kafka-exporter-1"


def command(*args, input_data=None, timeout=5):
    return subprocess.run(args, input=input_data, capture_output=True, timeout=timeout,
                          check=True).stdout


def secrets(path, *, check_permissions=True):
    with path.open() as file:
        info = os.fstat(file.fileno())
        if check_permissions and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError("invalid secret permissions")
        text = file.read(4097)
        if len(text) > 4096:
            raise ValueError("heartbeat file too large")
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        target = key.removeprefix("RECOUNT_HEARTBEAT_")
        if key != f"RECOUNT_HEARTBEAT_{target}" or target not in TARGETS or target in result:
            raise ValueError("unexpected heartbeat key")
        url = urlsplit(value)
        if (url.scheme != "https" or url.netloc != "incidents.betterstack.com"
                or url.query or url.fragment
                or not re.fullmatch(r"/api/v1/heartbeat/[A-Za-z0-9_-]+", url.path)):
            raise ValueError("invalid heartbeat URL")
        result[target] = url.path
    if result.keys() != set(TARGETS):
        raise ValueError("missing heartbeat")
    return result


def ping(path):
    # Do not follow redirects or log exceptions: the URL is a write credential.
    connection = http.client.HTTPSConnection("incidents.betterstack.com", timeout=5)
    try:
        connection.request("GET", path)
        return 200 <= connection.getresponse().status < 300
    finally:
        connection.close()


def exporter_metrics():
    output = command("docker", "inspect", "-f", '{{with index .NetworkSettings.Networks '
                     '"recount-ingestion-monitoring_scrape"}}{{.IPAddress}}{{end}}', EXPORTER)
    address = ipaddress.IPv4Address(output.decode().strip())
    connection = http.client.HTTPConnection(str(address), 9308, timeout=4)
    try:
        connection.request("GET", "/metrics")
        response = connection.getresponse()
        data = response.read(262145)
        if response.status != 200 or len(data) > 262144:
            raise ValueError("exporter scrape failed")
        return data.decode()
    finally:
        connection.close()


def kafka_metrics(text):
    result = {}
    wanted = ("kafka_brokers", "kafka_topic_partition_leader", "kafka_consumergroup_lag")
    pattern = re.compile(r'(\w+)(?:\{([^{}]+)\})? (-?\d+)')
    for line in text.splitlines():
        match = pattern.fullmatch(line)
        if match and match[1] in wanted:
            labels = dict(re.findall(r'(\w+)="([^"\\]*)"', match[2] or ""))
            key = (match[1], labels.get("topic"), labels.get("partition"),
                   labels.get("consumergroup"))
            if key in result:
                raise ValueError("duplicate exporter sample")
            result[key] = int(match[3])
    return result


def partition_values(metrics, metric, topic, group=None):
    return {int(partition): value for (name, label, partition, consumer), value in metrics.items()
            if name == metric and label == topic and partition is not None and consumer == group}


def complete_partitions(values, count):
    return values.keys() == set(range(count)) and all(v >= 0 for v in values.values())


def live_offsets():
    # Live is outside the exporter's ACL. A ListOffsets response from each live
    # partition proves it has a leader, using the existing Live reader credential.
    with Path("/etc/recount/kafka/live.properties").open("rb") as properties:
        output = command(
            "docker", "exec", "-i", f"{PROJECT}-kafka-1", "sh", "-ec",
            'umask 077; properties=$(mktemp); trap \'rm -f "$properties"\' EXIT; '
            'trap \'exit 1\' HUP INT TERM; cat > "$properties"; '
            'timeout 12s /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 '
            '--command-config "$properties" --topic "$1"', "live-offsets", LIVE,
            input_data=properties.read(), timeout=15).decode()
    return {int(p): int(v) for p, v in re.findall(r"^recount\.metrics\.live:(\d+):(-?\d+)$",
                                               output, re.MULTILINE)}


def kafka_healthy(metrics):
    return (metrics.get(("kafka_brokers", None, None, None), 0) > 0
            and all(complete_partitions(partition_values(metrics, "kafka_topic_partition_leader", topic), count)
                    for topic, count in TOPICS.items())
            and complete_partitions(live_offsets(), LIVE_PARTITIONS))


def normalizers_healthy(metrics):
    running = command("docker", "ps", "-q", "--filter", "status=running",
                      "--filter", f"label=com.docker.compose.project={PROJECT}",
                      "--filter", "label=com.docker.compose.service=normalizer").split()
    lag = partition_values(metrics, "kafka_consumergroup_lag", RAW, "recount-normalizer")
    return (len(running) == 3 and complete_partitions(lag, TOPICS[RAW])
            and sum(lag.values()) < RAW_LAG_LIMIT)


def pg(*args):
    return command("docker", "exec", "-e",
                   "PGOPTIONS=-c statement_timeout=1500 -c default_transaction_read_only=on",
                   f"{PROJECT}-postgres-1", *args).strip()


def postgres_healthy():
    pg("pg_isready", "-q", "-h", "127.0.0.1", "-U", "recount", "-d", "recount", "-t", "2")
    return pg_scalar("SELECT 1") == b"1"


def pg_scalar(sql):
    return pg("psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "recount", "-d", "recount", "-c", sql)


def clickhouse(sql):
    return command("docker", "exec", f"{PROJECT}-clickhouse-1", "clickhouse-client",
                   "--readonly=1", "--max_execution_time=3", "--max_threads=1",
                   "--max_rows_to_read=2000000", "--max_bytes_to_read=67108864",
                   "--query", sql).strip()


def sources_sending():
    # last_seen_at is flushed by the ingestion API after accepted metrics exports.
    # Unlike a stored receipt, it still advances if downstream storage is broken.
    value = pg_scalar(
        "SELECT EXISTS (SELECT FROM ingestion.collector_node "
        "WHERE revoked_at IS NULL AND deleted_at IS NULL "
        f"AND last_seen_at >= now() - interval '{FRESH_SECONDS} seconds')")
    if value not in (b"t", b"f"):
        raise ValueError("unexpected ingress activity result")
    return value == b"t"


def fresh_data():
    # Check a real point for the project of the latest recent stored receipt.
    # The event timestamp bounds include both ends of a UTC day rollover.
    return clickhouse(
        f"WITH now64(3) AS upper, upper - INTERVAL {FRESH_SECONDS} SECOND AS lower "
        "SELECT 1 FROM telemetry.metric_points "
        "WHERE project_id IN (SELECT project_id FROM telemetry.activity_receipts "
        "WHERE received_unix_nano BETWEEN toUnixTimestamp64Nano(lower) AND toUnixTimestamp64Nano(upper) "
        "AND max_event_unix_milli BETWEEN toUnixTimestamp64Milli(lower) AND toUnixTimestamp64Milli(upper) "
        "ORDER BY received_unix_nano DESC LIMIT 1) "
        "AND event_day BETWEEN intDiv(toUnixTimestamp(lower),86400) AND intDiv(toUnixTimestamp(upper),86400) "
        "AND time_unix_milli BETWEEN toUnixTimestamp64Milli(lower) AND toUnixTimestamp64Milli(upper) "
        "LIMIT 1") == b"1"


def clickhouse_healthy():
    return clickhouse("SELECT 1") == b"1" and (not sources_sending() or fresh_data())


def caddy_serving():
    # Empty grpc.health.v1.HealthCheckRequest. curl interleaves gRPC trailers with
    # headers when writing them to the same stream as the response frame.
    output = command("curl", "-q", "--noproxy", "*", "--silent", "--http2",
                     "--max-time", "4", "--resolve", f"{INGEST_HOST}:443:127.0.0.1",
                     "--dump-header", "-", "--header", "content-type: application/grpc",
                     "--header", "te: trailers", "--data-binary", "@-",
                     f"https://{INGEST_HOST}/grpc.health.v1.Health/Check",
                     input_data=b"\x00" * 5)
    headers, _, data = output.partition(b"\r\n\r\n")
    frame = b"\x00\x00\x00\x00\x02\x08\x01"  # HealthCheckResponse.SERVING
    return (headers.startswith(b"HTTP/2 200 ") and data.startswith(frame)
            and data[len(frame):].strip().lower() == b"grpc-status: 0")


def run(checks, paths, send=ping):
    for name, check in checks.items():
        try:
            healthy = check()
        except (OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException):
            healthy = False
        if not healthy:
            print(f"{name}: unhealthy; ping withheld")
            continue
        try:
            sent = send(paths[name])
        except Exception:
            sent = False
        print(f"{name}: {'ping accepted' if sent else 'ping failed'}")


def pipeline_healthy():
    return caddy_serving() and fresh_data()


def main(mode):
    if mode == "validate":
        secrets(Path(sys.argv[2]), check_permissions=False)
        return
    if mode == "pipeline":
        checks = {"PIPELINE": pipeline_healthy}
    elif mode == "components":
        # Cache only a successful scrape for this run; an exporter error cannot
        # stop the independent database checks.
        metrics = cache(lambda: kafka_metrics(exporter_metrics()))
        checks = {
            "KAFKA": lambda: kafka_healthy(metrics()),
            "NORMALIZERS": lambda: normalizers_healthy(metrics()),
            "CLICKHOUSE": clickhouse_healthy,
            "POSTGRES": postgres_healthy,
        }
    else:
        raise ValueError("unknown mode")
    run(checks, secrets(SECRETS))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception:
        sys.exit("heartbeat job configuration or execution failed")
