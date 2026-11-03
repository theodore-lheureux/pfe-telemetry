#!/usr/bin/env python3
"""Run the real ingestion/storage pipeline with isolated Docker Compose projects."""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "infra/telemetry/compose.yaml"
ORIGIN = 1_730_000_000_000_000_000
IMAGE = "pfe-storage-experiment:local"


class Experiment:
    def __init__(self, output, args):
        self.output, self.args = output, args
        self.origin = time.time_ns()
        self.lock = threading.Lock()
        self.env = os.environ | {
            "TELEMETRY_INGESTION_PORT": "0",
            "TELEMETRY_INGESTION_SOURCES_FILE": str(output / "sources.json"),
            "LOAD_TOKEN": secrets.token_hex(32),
            "LOAD_CREATED_ORIGIN": str(self.origin),
        }
        (output / "sources.json").write_text(json.dumps([{
            "project_id": "experiment", "source_id": "generator",
            "token_sha256": hashlib.sha256(self.env["LOAD_TOKEN"].encode()).hexdigest(),
            "hosts": [f"load-node-{i}" for i in range(8)],
        }]))
        (output / "override.json").write_text(json.dumps({"services": {
            "ingestion": {"image": IMAGE, "restart": "no"},
            "storage": {"image": IMAGE, "restart": "no"},
            "kafka": {"restart": "no"},
        }}))

    def event(self, kind, **values):
        with self.lock, (self.output / "events.jsonl").open("a") as stream:
            stream.write(json.dumps({"kind": kind, "time_ns": time.time_ns(), **values}) + "\n")

    def command(self, argv, check=True, timeout=180):
        self.event("command", argv=argv)
        result = subprocess.run(argv, env=self.env, text=True, capture_output=True, timeout=timeout)
        self.event("command_result", argv=argv, code=result.returncode,
                   stdout=result.stdout, stderr=result.stderr)
        if check and result.returncode:
            raise RuntimeError(f"Command failed: {argv}\n{result.stderr}")
        return result

    def compose(self, *args):
        return ["docker", "compose", "--project-name", self.project,
                "--file", str(BASE), "--file", str(self.output / "override.json"), *args]

    def load(self, start, count, interval=0):
        result = self.command(self.compose("run", "--rm", "--no-deps", "-T",
            "--entrypoint", "storage-load", "-e", "LOAD_TOKEN", "-e", "LOAD_CREATED_ORIGIN", "ingestion",
            "--start", str(start), "--batches", str(count), "--interval-ms", str(interval)),
            timeout=max(180, count * interval / 1000 + 120))
        acks = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert len(acks) == count
        self.event("ingestion", scenario=self.project, start=start, count=count, acks=acks)
        return acks

    def wait_rows(self, reader, batches):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = reader.query("SELECT count(*) AS n FROM measurements", "drain")
            if result and result[0]["n"] == batches * 192:
                return
            time.sleep(0.5)
        raise RuntimeError(f"Storage did not drain to {batches * 192} rows")

    def validate(self, reader, batches):
        # Complete bounded domains + unique identities + exact values establish set equality.
        result = reader.query(f"""
            WITH samples AS (
                SELECT *, (client_created_unix_nano::HUGEINT - {self.origin}) AS seq
                FROM measurements
            ) SELECT count(*) AS rows,
                count(DISTINCT (client_batch_id, resource_index, metric_index, point_index)) AS identities,
                count(*) FILTER (WHERE NOT coalesce(
                    seq BETWEEN 0 AND {batches - 1}
                    AND resource_index BETWEEN 0 AND 63 AND metric_index BETWEEN 0 AND 2
                    AND scope_index = 0 AND point_index = 0
                    AND project_id = 'experiment' AND source_id = 'generator'
                    AND client_batch_id = '01900000-0000-7000-8000-' || lpad(lower(hex(seq)), 12, '0')
                    AND host_id = 'load-node-' || (resource_index // 8)::VARCHAR
                    AND process_pid = resource_index % 8
                    AND metric_name = CASE metric_index WHEN 0 THEN 'system.cpu.time'
                        WHEN 1 THEN 'system.disk.io' ELSE 'process.memory.usage' END
                    AND value_int = seq * 1000 + (resource_index // 8) * 100 + (resource_index % 8) * 10 + metric_index
                    AND time_unix_nano = {ORIGIN} + (seq + 1) * 1000000000
                    AND start_time_unix_nano = {ORIGIN}, false)) AS invalid
            FROM samples
        """, "integrity")
        assert result == [{"rows": batches * 192, "identities": batches * 192, "invalid": 0}], result
        self.event("integrity", scenario=self.project, batches=batches, result=result)

    def monitor(self, stop, names):
        while not stop.is_set():
            result = self.command(["docker", "stats", "--no-stream", "--format", "{{json .}}", *names], check=False)
            self.event("resources", scenario=self.project, samples=[json.loads(v) for v in result.stdout.splitlines() if v.startswith("{")])
            stop.wait(1)

    def scenario(self, repeat, readers, write=True):
        self.project = f"pfe-storage-exp-{self.output.name}-{repeat}-{readers}-{'rw' if write else 'ro'}"
        print(self.project, flush=True)
        label = f"label=com.docker.compose.project={self.project}"
        if self.command(["docker", "volume", "ls", "--filter", label, "--quiet"]).stdout.strip() or self.command(
            ["docker", "ps", "--all", "--filter", label, "--quiet"]
        ).stdout.strip():
            raise RuntimeError("Experiment project already exists; choose a different output name")
        active, clients = [], []
        stop = threading.Event()
        try:
            self.command(self.compose("up", "--no-build", "--detach", "--wait", "--wait-timeout", "180", "ingestion", "storage"))
            self.load(0, self.args.history)
            check = Reader(self, "check")
            clients.append(check)
            self.wait_rows(check, self.args.history)
            self.validate(check, self.args.history)
            check.close()
            clients.remove(check)
            for i in range(readers):
                clients.append(Reader(self, f"reader-{i}"))
            names = self.command(self.compose("ps", "--format", "json")).stdout
            names = [json.loads(line)["Name"] for line in names.splitlines() if line.startswith("{")]
            names += [client.name for client in clients]
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=readers + 1)
            active.append(pool.submit(self.monitor, stop, names))
            self.event("phase_start", scenario=self.project, readers=readers, write=write)
            for client in clients:
                active.append(pool.submit(client.workload, stop, self.args.history))
            if write:
                self.load(self.args.history, self.args.batches, self.args.interval_ms)
            else:
                time.sleep(self.args.batches * self.args.interval_ms / 1000)
            stop.set()
            for future in active:
                future.result()
            pool.shutdown()
            self.event("phase_end", scenario=self.project)
            for client in clients:
                client.close()
            clients.clear()
            check = Reader(self, "check-final")
            clients.append(check)
            total = self.args.history + (self.args.batches if write else 0)
            self.wait_rows(check, total)
            self.validate(check, total)
            self.lag()
            if repeat == self.args.repeats - 1 and readers == 4 and write:
                self.recovery(check, total)
            self.command(self.compose("exec", "-T", "storage", "sh", "-c", "du -sk /var/lib/pfe/measurements; find /var/lib/pfe/measurements -name '*.parquet' | wc -l"))
        finally:
            stop.set()
            for future in active:
                try:
                    future.result(timeout=120)
                except Exception as error:
                    self.event("cleanup_error", error=str(error))
            for client in clients:
                client.close()
            self.command(self.compose("logs", "--no-color", "storage"), check=False)
            self.command(self.compose("down", "--timeout", "15"), check=False)

    def lag(self, group="pfe-storage-v1"):
        return self.command(self.compose("exec", "-T", "kafka", "/opt/kafka/bin/kafka-consumer-groups.sh",
            "--bootstrap-server", "kafka:9092", "--describe", "--group", group), check=False)

    def recovery(self, reader, total):
        self.event("recovery_start", scenario=self.project)
        second = self.command(self.compose("run", "--rm", "--no-deps", "-T", "storage"), check=False)
        assert second.returncode != 0 and "Another storage worker" in second.stderr
        self.command(self.compose("stop", "storage"))
        self.load(total, 50)
        assert reader.query("SELECT count(*) AS n FROM measurements", "paused")[0]["n"] == total * 192
        self.lag()
        started = time.monotonic()
        self.command(self.compose("start", "storage"))
        total += 50
        self.wait_rows(reader, total)
        self.event("resume", elapsed_s=time.monotonic() - started)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            loading = pool.submit(self.load, total, 100, 50)
            time.sleep(2)
            self.command(self.compose("kill", "--signal", "SIGKILL", "storage"))
            reader.query("SELECT count(*) AS n FROM measurements", "crashed")
            self.command(self.compose("start", "storage"))
            loading.result()
        total += 100
        self.wait_rows(reader, total)
        self.validate(reader, total)
        self.command(self.compose("stop", "storage", "ingestion", "kafka"))
        self.command(self.compose("up", "--no-build", "--detach", "--wait", "ingestion", "storage"))
        self.validate(reader, total)
        self.command(self.compose("stop", "storage"))
        # An absent checkpoint forces every already-published batch through replay.
        replay_name = self.project + "-replay"
        self.command(self.compose("run", "--detach", "--no-deps", "--name", replay_name,
            "-e", "TELEMETRY_STORAGE_KAFKA_GROUP=experiment-replay", "storage"))
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                lag = self.lag("experiment-replay")
                rows = [line.split() for line in lag.stdout.splitlines() if line.startswith("experiment-replay ")]
                if rows and all(row[5] == "0" for row in rows):
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Replay did not drain before deadline")
            self.validate(reader, total)
            self.event("recovery_pass", scenario=self.project, batches=total)
        finally:
            self.command(["docker", "stop", "--time", "15", replay_name], check=False)
            self.command(["docker", "logs", replay_name], check=False)
            self.command(["docker", "rm", replay_name], check=False)
        self.command(self.compose("start", "storage"))


class Reader:
    def __init__(self, experiment, label):
        self.experiment, self.label = experiment, label
        self.name = experiment.project + "-" + label
        argv = experiment.compose("run", "--rm", "--no-deps", "-T", "--name", self.name, "query", "-json")
        experiment.event("command", argv=argv)
        self.errors = (experiment.output / f"{self.name}.stderr").open("w")
        self.process = subprocess.Popen(argv, env=experiment.env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.errors, text=True, bufsize=1)
        self.process.stdin.write(".timer on\n")
        self.process.stdin.flush()
        try:
            self.query("SELECT version() AS version", "startup")
        except Exception:
            self.close()
            raise

    def query(self, sql, label):
        start = time.time_ns()
        self.process.stdin.write(sql.strip().rstrip(";") + ";\n.print __DONE__\n")
        self.process.stdin.flush()
        lines, engine_ms = [], None
        for line in self.process.stdout:
            if line.strip() == "__DONE__":
                break
            if line.startswith("Run Time"):
                match = re.search(r"real ([0-9.]+)", line)
                engine_ms = float(match[1]) * 1000 if match else None
            else:
                lines.append(line)
        else:
            raise RuntimeError(f"Query process exited: {self.name}")
        end = time.time_ns()
        text = "".join(lines).strip()
        result = json.loads(text) if text else None
        self.experiment.event("query", scenario=self.experiment.project, reader=self.label,
            label=label, sql=sql, start_ns=start, end_ns=end, elapsed_ms=(end-start)/1e6,
            engine_ms=engine_ms, result=result, failed=result is None)
        if result is None:
            raise RuntimeError(f"Query failed: {self.name} ({label}); see {self.errors.name}")
        return result

    def workload(self, stop, history):
        origin = self.experiment.origin
        queries = [
            ("range", f"SELECT host_id, avg(value_int) AS value FROM measurements WHERE metric_name = 'process.memory.usage' AND client_created_unix_nano < {origin + history} GROUP BY host_id"),
            ("aggregate", f"SELECT metric_name, count(*) AS n, sum(value_int)::VARCHAR AS total FROM measurements WHERE client_created_unix_nano < {origin + history} GROUP BY metric_name"),
            ("rates", f"SELECT host_id, avg(rate_per_second) AS rate FROM metric_rates WHERE metric_name = 'system.cpu.time' AND client_created_unix_nano < {origin + history} GROUP BY host_id"),
            ("freshness", f"SELECT max(client_created_unix_nano)::HUGEINT - {origin} AS latest FROM measurements"),
        ]
        while not stop.is_set():
            for label, sql in queries:
                if stop.is_set():
                    break
                result = self.query(sql, label)
                if label == "range":
                    assert len(result) == 8 and all(
                        row["value"] == (history - 1) * 500 + int(row["host_id"].split("-")[-1]) * 100 + 37
                        for row in result), result
                elif label == "aggregate":
                    indices = {"system.cpu.time": 0, "system.disk.io": 1, "process.memory.usage": 2}
                    assert len(result) == 3 and all(
                        row["n"] == history * 64 and int(row["total"]) ==
                        history * 64 * ((history - 1) * 500 + 385 + indices[row["metric_name"]])
                        for row in result), result
                elif label == "rates":
                    assert len(result) == 8 and all(row["rate"] == (1000 if history > 1 else None) for row in result), result

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write(".quit\n")
                self.process.stdin.flush()
                self.process.wait(timeout=15)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.experiment.command(["docker", "stop", "--time", "5", self.name], check=False)
                self.process.wait(timeout=15)
        self.errors.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--history", type=int, default=500)
    parser.add_argument("--batches", type=int, default=150)
    parser.add_argument("--interval-ms", type=int, default=100)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if min(args.history, args.batches, args.interval_ms, args.repeats) < 1:
        parser.error("all workload parameters must be positive")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,35}", output.name):
        parser.error("output directory name must be a short lowercase Docker label")
    experiment = Experiment(output, args)
    experiment.event("parameters", parameters={**vars(args), "output": str(output)}, rows_per_batch=192, created_origin_ns=experiment.origin)
    for argv in [["git", "rev-parse", "HEAD"], ["git", "status", "--short"],
                 ["docker", "info", "--format", "{{json .}}"], ["docker", "version"],
                 ["docker", "image", "inspect", IMAGE]]:
        experiment.command(argv)
    for repeat in range(args.repeats):
        experiment.scenario(repeat, 1, write=False)
        for readers in (0, 1, 4):
            experiment.scenario(repeat, readers)
    experiment.event("complete")


if __name__ == "__main__":
    main()
