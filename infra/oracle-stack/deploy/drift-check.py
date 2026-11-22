#!/usr/bin/env python3
"""Compare Oracle with an independently approved private inventory (no writes)."""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.request


CLICKHOUSE = "recount-ingestion-clickhouse-1"
KAFKA = "recount-ingestion-kafka-1"
RUNNER = "recount-demo-semaphore-runner-1"
SEMAPHORE = "http://127.0.0.1:3100/api/project/1/"
KAFKA_ENGINE_SETTINGS = ("kafka_max_block_size", "kafka_poll_max_batch_size", "kafka_flush_interval_ms")


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=20)
    if result.returncode:
        # stderr and argv can contain connection settings or query text.
        raise RuntimeError(f"{args[0]} probe failed (exit {result.returncode})")
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def inventory():
    result = {}
    etc = pathlib.Path("/etc/recount")
    for path in sorted((*etc.glob("*.env"), etc / "web.local.yaml")):
        result[f"host-file:{path.name}"] = digest(path.read_bytes()) if path.is_file() else None

    for directory in ("config.d", "users.d"):
        root = "/etc/clickhouse-server/" + directory
        paths = command("docker", "exec", CLICKHOUSE, "find", root, "-maxdepth", "1",
                        "(", "-type", "f", "-o", "-type", "l", ")").decode().splitlines()
        for path in sorted(paths):
            result[f"clickhouse-file:{directory}/{pathlib.PurePosixPath(path).name}"] = digest(
                command("docker", "exec", CLICKHOUSE, "cat", path)
            )
    query = """SELECT name, engine, create_table_query FROM system.tables
        WHERE database='telemetry' ORDER BY name FORMAT JSONEachRow"""
    for line in command("docker", "exec", CLICKHOUSE, "clickhouse-client",
                        "--readonly=1", "--max_execution_time=5", "-q", query).splitlines():
        row = json.loads(line)
        result["telemetry-ddl:" + row["name"]] = digest(row["create_table_query"].encode())
        if row["engine"] == "Kafka":
            for setting in KAFKA_ENGINE_SETTINGS:
                matches = re.findall(rf"(?<!\w){setting}\s*=\s*(\d+)\b", row["create_table_query"])
                if len(matches) != 1:
                    raise RuntimeError("missing or ambiguous Kafka batching declaration")
                result[f"telemetry-kafka-setting:{row['name']}:{setting}"] = int(matches[0])

    codecs = """SELECT name, compression_codec FROM system.columns
        WHERE database='telemetry' AND table='metric_points'
        AND name IN ('time_unix_milli','raw_offset') FORMAT JSONEachRow"""
    for line in command("docker", "exec", CLICKHOUSE, "clickhouse-client",
                        "--readonly=1", "--max_execution_time=5", "-q", codecs).splitlines():
        row = json.loads(line)
        result[f"telemetry-codec:metric_points:{row['name']}"] = row["compression_codec"]

    kafka = ("docker", "exec", KAFKA, "/opt/kafka/bin/")
    endpoint = ("--bootstrap-server", "localhost:9092",
                "--command-config", "/run/recount-kafka/broker.properties")
    topics = command(*kafka[:3], kafka[3] + "kafka-topics.sh", *endpoint,
                     "--describe").decode().splitlines()
    for line in topics:
        values = {}
        for field in line.split("\t"):
            key, separator, value = field.partition(":")
            if separator:
                values[key.strip()] = value.strip()
        name = values.get("Topic", "")
        if not name.startswith("recount.") or "PartitionCount" not in values:
            continue
        # Configuration order is not stable across broker/tool versions.
        configs = sorted(values.get("Configs", "").split(","))
        result[f"kafka-topic:{name}"] = fingerprint([
            values["PartitionCount"], values["ReplicationFactor"], configs
        ])
    for scope in ("brokers", "broker-loggers"):
        response = command(*kafka[:3], kafka[3] + "kafka-configs.sh", *endpoint,
                           "--describe", "--entity-type", scope, "--entity-name", "1")
        result[f"kafka-overrides:{scope}"] = fingerprint(
            sorted(line.strip() for line in response.decode().splitlines() if line.strip())
        )
    response = command(*kafka[:3], kafka[3] + "kafka-configs.sh", *endpoint,
                       "--describe", "--entity-type", "brokers", "--entity-default")
    result["kafka-overrides:cluster"] = fingerprint(
        sorted(line.strip() for line in response.decode().splitlines() if line.strip())
    )
    source = command("docker", "exec", RUNNER, "sh", "-ec",
                     "cd /opt/recount; find infra/demo infra/semaphore -type f "
                     "-not -path '*/__pycache__/*' -print0 | xargs -0 sha256sum")
    for line in source.decode().splitlines():
        sha, path = line.split(maxsplit=1)
        result[f"semaphore-source:{path}"] = sha

    names = command("docker", "ps", "--format", "{{.Names}}").decode().splitlines()
    expected = {CLICKHOUSE, KAFKA, RUNNER, "recount-ingestion-monitoring-prometheus-1",
                "recount-ingestion-monitoring-grafana-1"}
    if not expected <= set(names):
        raise RuntimeError("one or more required ingestion, monitoring, or Semaphore containers are absent")
    normalizer_replicas = 0
    for name in sorted(n for n in names if n.startswith(("recount-ingestion-", "recount-demo-semaphore-"))):
        config, = json.loads(command("docker", "inspect", name))
        labels = config["Config"].get("Labels") or {}
        if (labels.get("com.docker.compose.project") == "recount-ingestion"
                and labels.get("com.docker.compose.service") == "normalizer"):
            normalizer_replicas += 1
        host = config["HostConfig"]
        result[f"container:{name}:resources"] = [
            host.get(key) for key in ("NanoCpus", "Memory", "MemorySwap", "PidsLimit")
        ]
        result[f"container:{name}:env"] = fingerprint(sorted(config["Config"].get("Env") or []))
        result[f"container:{name}:command"] = fingerprint(
            [config["Config"].get("Entrypoint"), config["Config"].get("Cmd")])
        for mount in config["Mounts"]:
            target, source = mount["Destination"], pathlib.Path(mount["Source"])
            if mount["Type"] != "bind":
                continue
            if source.is_file():
                result[f"mount:{name}:{target}"] = digest(source.read_bytes())
            elif ("/provisioning" in target or "/dashboards" in target
                  or (name == RUNNER and target in ("/run/demo", "/run/runner"))) and source.is_dir():
                for path in sorted(p for p in source.rglob("*") if p.is_file()):
                    result[f"mount:{name}:{target}/{path.relative_to(source)}"] = digest(path.read_bytes())
    result["compose:recount-ingestion:normalizer:running-replicas"] = normalizer_replicas

    token = pathlib.Path("/opt/recount-demo-semaphore/private/toolbar/semaphore-token").read_text().strip()
    for endpoint in ("templates", "repositories", "inventory", "environment"):
        request = urllib.request.Request(SEMAPHORE + endpoint, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=8) as response:
            rows = json.load(response)
        for row in rows:
            # Template responses also carry task-run history, not configuration.
            config = ({key: value for key, value in row.items() if key not in ("last_task", "tasks")}
                      if endpoint == "templates" else row)
            result[f"semaphore:{endpoint}:{int(row['id'])}"] = fingerprint(config)
    return result


def differences(expected, actual):
    return [(key, key in expected, key in actual) for key in sorted(expected.keys() | actual.keys())
            if key not in expected or key not in actual or expected[key] != actual[key]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--expected", type=pathlib.Path, help="approved private inventory JSON")
    mode.add_argument("--inventory", action="store_true", help="emit fingerprints for review, not approval")
    args = parser.parse_args()
    try:
        live = inventory()
        if args.inventory:
            print(json.dumps(live, sort_keys=True, indent=2))
            return 0
        expected = json.loads(args.expected.read_text())
        if not isinstance(expected, dict) or not expected:
            raise ValueError("empty or invalid expected inventory")
        changed = differences(expected, live)
        for key, before, after in changed:
            # Only the explicitly inventoried numeric batching settings are safe to display.
            if ((key.startswith("telemetry-kafka-setting:") or key == "compose:recount-ingestion:normalizer:running-replicas")
                    and type(expected.get(key)) is int and type(live.get(key)) is int):
                print(f"{key}: expected {expected[key]}, found {live[key]}")
            else:
                print(f"{key}: {'changed' if before and after else 'missing' if before else 'unexpected'}")
        if not changed:
            print("Oracle configuration matches the approved inventory.")
        return int(bool(changed))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyError) as error:
        print(f"Drift check could not complete ({type(error).__name__}).", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
