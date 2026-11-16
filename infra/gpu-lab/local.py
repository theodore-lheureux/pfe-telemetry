"""Read-only preflight for the existing local stack; never repairs or restarts it."""

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
from urllib.parse import urlparse

from snapshot import ROOT


def native_normalizer_ready(container):
    state = container["State"]
    if not state["Running"] or state.get("Paused") or state.get("Restarting"):
        raise ValueError("Normalizer is not running normally")
    logs = subprocess.run([
        "docker", "logs", "--since", state["StartedAt"], "--tail", "200", container["Id"],
    ], check=True, capture_output=True, text=True)
    text = logs.stdout + logs.stderr
    states = re.findall(r"^state=(\w+)(?: .*)?$", text, flags=re.MULTILINE)
    ready = "state=ready checks=initial_snapshot offset_reset=earliest"
    if ready not in text.splitlines() or not states or states[-1] != "ready":
        raise ValueError("Current normalizer incarnation has not reported native readiness")
    current = json.loads(subprocess.check_output(["docker", "inspect", container["Id"]]))[0]
    if current["State"]["StartedAt"] != state["StartedAt"] or not current["State"]["Running"]:
        raise ValueError("Normalizer restarted during its readiness check")
    print("Normalizer native startup readiness verified for its current container incarnation")


def check_config(config):
    identity = Path(config["identity_file"]).expanduser()
    if not identity.is_file() or identity.stat().st_mode & 0o077:
        raise ValueError("SSH identity must exist and be private")
    for role in ("web", "ingestion-api", "normalizer"):
        name = config["containers"][role]
        container = json.loads(subprocess.check_output(["docker", "inspect", name]))[0]
        if container["State"].get("Health", {}).get("Status") != "healthy":
            if (role == "normalizer" and config.get("normalizer_readiness") == "native"
                    and not container["Config"].get("Healthcheck")):
                native_normalizer_ready(container)
            else:
                raise ValueError(f"{role} is not Docker-healthy; wait for the stack switch")
    web = urlparse(config["web_url"])
    for port in (web.port or 80, int(config["ingestion_port"])):
        with socket.create_connection(("127.0.0.1", port), timeout=5):
            pass
    subprocess.run([
        "docker", "exec", config["clickhouse_container"], "clickhouse-client",
        "--readonly=1", "--max_execution_time=10", "--query", "SELECT 1",
    ], check=True, stdout=subprocess.DEVNULL)
    migration = ROOT / "apps/web/drizzle/0026_gpu_enrollment_default.sql"
    environment = {
        **os.environ,
        "RECOUNT_GPU_ACTOR_ID": config["actor_id"],
        "RECOUNT_GPU_ORGANIZATION_ID": config["organization_id"],
        "RECOUNT_GPU_MIGRATION_HASH": hashlib.sha256(migration.read_bytes()).hexdigest(),
    }
    environment.pop("DATABASE_URL", None)
    subprocess.run([
        "bun", "--env-file=" + str(Path(config["database_env"]).expanduser().resolve()),
        str(ROOT / "infra/gpu-lab/project.ts"), "--check",
    ], cwd=ROOT, env=environment, check=True)
