#!/usr/bin/env python3
"""Validate an owner-provisioned NVIDIA GPU VM through private SSH reverse tunnels."""

import argparse
from datetime import datetime, timezone
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import time
from urllib.parse import urlparse
from uuid import uuid4

from snapshot import ROOT, checkout_files, create_snapshot, digest, validate_binaries
from local import check_config
from capabilities import PIPES, matches, parse_capabilities
from ssh_host import pin_host_key

SOURCE = Path(__file__).resolve().parent
EVIDENCE_FILES = [
    "hardware.log", "packages-plan.log", "packages.log", "discovery.log",
    "capabilities.log", "capabilities.json", "collector.log", "phases.log", "load-1004.log",
    "load-1006.log", "load-1007.log", "load-1008.log", "node.json",
]


def verify(points, capabilities):
    def rows(metric):
        return [p for p in points if p["metric_name"] == metric]

    def positive(metric, attributed=False):
        return any(
            (not attributed or p["attributed"])
            and float(p["double_value"] if p["double_value"] is not None else p["int_value"]) > 0
            for p in rows(metric)
        )

    pipes = rows("recount.gpu.pipe.activity")
    checks = {
        "device_utilization": positive("recount.gpu.utilization"),
        "device_memory": positive("recount.gpu.memory.used"),
        "device_identity": any(dict(p["resource_attributes"]).get("/gpu.uuid") for p in pipes),
        "execution_process_memory": positive("recount.process.gpu.memory.used", True),
        "execution_process_utilization": positive("recount.process.gpu.utilization", True),
    }
    for field in capabilities["load_fields"]:
        checks[PIPES[field]] = any(
            matches(p, field) and p["double_value"] is not None and float(p["double_value"]) > 0
            for p in pipes
        )
    for field in capabilities["unavailable_fields"]:
        checks[f"{field}_no_scalar"] = not any(matches(p, field) for p in points)
        checks[f"{field}_unsupported"] = any(
            matches(p, field, status=True)
            and p["int_value"] is not None and int(p["int_value"]) == 1
            for p in points
        )
    for field in capabilities["offered_fields"]:
        checks[f"{field}_coverage"] = any(
            matches(p, field) or (
                matches(p, field, status=True) and p["int_value"] is not None
                and 1 <= int(p["int_value"]) <= 6
            ) for p in points
        )
    if not all(checks.values()):
        raise ValueError(f"Missing GPU evidence: {[key for key, passed in checks.items() if not passed]}")
    return checks


def loopback_port(url):
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
        raise ValueError("The web endpoint must be local HTTP on loopback")
    if parsed.path not in ("", "/") or parsed.username or parsed.query or parsed.fragment:
        raise ValueError("Use the web origin without credentials, path or query")
    return parsed.port or 80


def tunnels_ready(addresses):
    forwarded = [a for a in addresses if a.rsplit(":", 1)[-1] in ("43170", "30070")]
    allowed = {"127.0.0.1:43170", "127.0.0.1:30070"}
    if any(a not in allowed for a in forwarded) or len(forwarded) != len(set(forwarded)):
        raise ValueError("Reverse forwards are not exclusively loopback-bound")
    return set(forwarded) == allowed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ip", type=ipaddress.IPv4Address, nargs="?")
    parser.add_argument("--config", type=Path, default=ROOT / ".state/gpu-lab/config.json")
    parser.add_argument("--check-config", action="store_true", help="Read-only local checks; no SSH")
    parser.add_argument("--host-key-fingerprint", help="Trusted SHA256 fingerprint from GCP guest attributes")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    web_port = loopback_port(config["web_url"])
    if not 1 <= int(config["ingestion_port"]) <= 65535:
        parser.error("Invalid local ingestion port")
    browser_state = browser_state_path(config)
    check_config(config)
    if args.check_config:
        print("Local GPU lab configuration is ready; no remote actions performed")
        return
    if not args.ip:
        parser.error("An already-running instance IP is required")
    fingerprint = args.host_key_fingerprint or config.get("host_key_fingerprint")
    if not fingerprint:
        parser.error("Provide --host-key-fingerprint from the owner's GCP guest attributes")
    execution = f"gpu-e2e-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid4().hex[:8]}"
    evidence = ROOT / ".state/gpu-lab" / execution
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    snapshot = create_snapshot(evidence)
    binaries = Path(config["bin_directory"]).expanduser().resolve() / execution
    binaries.mkdir(mode=0o700, parents=True, exist_ok=False)
    environment = {
        **os.environ,
        "RECOUNT_GPU_EVIDENCE": str(evidence),
        "RECOUNT_GPU_EXECUTION": execution,
        "RECOUNT_GPU_WEB_URL": config["web_url"].rstrip("/"),
        "RECOUNT_GPU_ACTOR_ID": config["actor_id"],
        "RECOUNT_GPU_ORGANIZATION_ID": config["organization_id"],
        "RECOUNT_GPU_BROWSER_STATE": str(browser_state) if browser_state else "",
    }
    environment.pop("DATABASE_URL", None)
    project_command = [
        "bun", "--env-file=" + str(Path(config["database_env"]).expanduser().resolve()),
        str(SOURCE / "project.ts"),
    ]
    ssh_options = [
        "-F", "/dev/null",
        "-i", str(Path(config["identity_file"]).expanduser()), "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes", "-o", "ForwardAgent=no", "-o", "UpdateHostKeys=no",
        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
    ]
    ssh_options.extend(pin_host_key(args.ip, fingerprint, evidence))
    user = config.get("ssh_user", "recount")
    if not user.replace("-", "").replace("_", "").isalnum():
        parser.error("Invalid SSH user")
    target = f"{user}@{args.ip}"

    def ssh(command, **options):
        return subprocess.run(
            ["ssh", *ssh_options, target, command], check=True, **options,
        )

    def project(*extra):
        subprocess.run([*project_command, *extra], cwd=ROOT, env=environment, check=True)

    remote = f"/var/lib/recount-gpu-lab/{execution}"
    tunnel = None
    installed = False
    staging = None
    try:
        # Fail before creating a project or installing anything if sudo/host access is unavailable.
        ssh(
            'set -- $SSH_CONNECTION; sudo -n /usr/sbin/sshd -T -C '
            '"user=$(id -un),host=$1,addr=$1,laddr=$3,lport=$4" '
            "| grep -x 'gatewayports no'",
            timeout=20,
        )
        candidate = ssh("umask 077; mktemp -d", capture_output=True, text=True).stdout.strip()
        if not candidate.startswith("/tmp/tmp.") or not candidate[len("/tmp/tmp."):].isalnum():
            raise ValueError("Unexpected remote staging directory")
        staging = candidate
        subprocess.run([
            "scp", *ssh_options, str(evidence / "source.tar.gz"), str(evidence / "snapshot.json"),
            f"{target}:{staging}/",
        ], check=True)
        manifest_hash = hashlib.sha256((evidence / "snapshot.json").read_bytes()).hexdigest()
        with (evidence / "build.log").open("w") as log:
            ssh(
                f"cd {staging} && printf '%s  %s\\n' "
                f"{snapshot['archive_sha256']} source.tar.gz {manifest_hash} snapshot.json "
                f"| sha256sum --check --strict && mkdir source && "
                f"tar -xzf source.tar.gz -C source --no-same-owner && "
                f"timeout --signal=INT --kill-after=30s 2400s "
                f"bash source/infra/gpu-lab/remote-build.sh {staging} {snapshot['archive_sha256']}",
                stdout=log, stderr=subprocess.STDOUT, timeout=2460,
            )
        subprocess.run([
            "scp", *ssh_options, *[f"{target}:{staging}/bin/{name}"
                                  for name in ("recount-collector", "recount", "build.json")],
            str(binaries) + "/",
        ], check=True)
        validate_binaries(binaries, snapshot)
        if digest(checkout_files()) != snapshot["source_sha256"]:
            raise ValueError("Checkout changed during the remote build; start a fresh run")
        # Enrollment keys are issued only after the potentially lengthy build.
        project()
        subprocess.run([
            "scp", *ssh_options, str(evidence / "enrollment.key"), f"{target}:{staging}/",
        ], check=True)
        installed = True
        ssh(
            f"sudo -n install -d -m 700 {remote} && "
            f"sudo -n install -m 700 {staging}/bin/recount-collector {staging}/bin/recount "
            f"{staging}/source/infra/gpu-lab/remote.sh {remote}/ && "
            f"sudo -n install -m 600 {staging}/source/infra/gpu-lab/host.sh "
            f"{staging}/source/infra/gpu-lab/capabilities.py {remote}/ && "
            f"sudo -n install -m 600 {staging}/enrollment.key {remote}/ && "
            f"sudo -n install -m 600 {staging}/source/apps/collector/NOTICE-NVIDIA "
            f"{staging}/source/crates/nvidia-dcgm/NOTICE "
            f"{staging}/source/crates/nvidia-dcgm/LICENSE-APACHE {remote}/ && "
            f"rm -f {staging}/enrollment.key"
        )
        tunnel = subprocess.Popen([
            "ssh", *ssh_options, "-NT", "-o", "ExitOnForwardFailure=yes",
            "-R", f"127.0.0.1:43170:127.0.0.1:{int(config['ingestion_port'])}",
            "-R", f"127.0.0.1:30070:127.0.0.1:{web_port}", target,
        ])
        for attempt in range(20):
            if tunnel.poll() is not None:
                raise RuntimeError("SSH reverse forwarding failed")
            listeners = ssh("ss -ltnH", capture_output=True, text=True).stdout.splitlines()
            addresses = [line.split()[3] for line in listeners]
            if tunnels_ready(addresses):
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Reverse forwards did not become ready")
        with (evidence / "install-and-run.log").open("w") as log:
            ssh(
                f"sudo -n timeout --signal=INT --kill-after=15s 420s "
                f"bash {remote}/remote.sh {remote} {execution}",
                stdout=log, stderr=subprocess.STDOUT, timeout=450,
            )
        collect_remote(ssh, remote, evidence)
        capabilities = parse_capabilities((evidence / "capabilities.log").read_text())
        if json.loads((evidence / "capabilities.json").read_text()) != capabilities:
            raise ValueError("Remote capability expectations do not match dcgmi profile -l")
        node = json.loads((evidence / "node.json").read_text())
        manifest = json.loads((evidence / "project.json").read_text())
        if node["projectId"] != manifest["projectId"]:
            raise ValueError("Collector enrolled into an unexpected project")
        query = (SOURCE / "points.sql").read_text()
        for attempt in range(30):
            result = subprocess.check_output([
                "docker", "exec", config["clickhouse_container"], "clickhouse-client",
                "--readonly=1", "--max_execution_time=30", "--max_memory_usage=268435456",
                "--max_result_rows=100000", "--result_overflow_mode=throw",
                f"--param_project={manifest['projectId']}", f"--param_node={node['nodeId']}",
                f"--param_execution={execution}", "--query", query,
            ], text=True)
            (evidence / "points.jsonl").write_text(result)
            try:
                checks = verify([json.loads(line) for line in result.splitlines()], capabilities)
                break
            except ValueError:
                if attempt == 29:
                    raise
                time.sleep(2)
        participants = subprocess.check_output([
            "docker", "exec", config["clickhouse_container"], "clickhouse-client",
            "--readonly=1", "--max_execution_time=30", "--max_memory_usage=268435456",
            "--max_result_rows=10000", "--result_overflow_mode=throw",
            f"--param_project={manifest['projectId']}", f"--param_execution={execution}",
            "--query", (SOURCE.parent / "lab/workloads/participants.sql").read_text(),
        ], text=True)
        (evidence / "participants.jsonl").write_text(participants)
        (evidence / "build.json").write_bytes((binaries / "build.json").read_bytes())
        browser = capture_browser(browser_state, environment)
        (evidence / "verification.json").write_text(json.dumps({
            "clickhouse": checks, "browser": browser,
        }, indent=2) + "\n")
        print(f"ClickHouse GPU validation passed; browser {browser}: {evidence}\n{manifest['executionUrl']}")
    finally:
        try:
            if installed:
                collect_remote(ssh, remote, evidence, required=False)
                # Only this run's disposable credentials; retain logs/queue for diagnosis.
                ssh(f"sudo -n rm -f {remote}/enrollment.key {remote}/node/node.key", timeout=20)
            if staging:
                ssh(f"rm -f {staging}/enrollment.key", timeout=20)
        finally:
            try:
                if tunnel is not None:
                    tunnel.terminate()
                    try:
                        tunnel.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        tunnel.kill()
                        tunnel.wait()
            finally:
                (evidence / "enrollment.key").unlink(missing_ok=True)
                if (evidence / "project.json").exists():
                    project("--revoke")


def collect_remote(ssh, remote, evidence, required=True):
    try:
        result = ssh(
            f"sudo -n tar --ignore-failed-read -czf - -C {shlex.quote(remote)} "
            + shlex.join(EVIDENCE_FILES), capture_output=True, timeout=30,
        )
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:gz") as archive:
            for name in EVIDENCE_FILES:
                try:
                    stream = archive.extractfile(name)
                except KeyError:
                    continue
                if stream:
                    (evidence / name).write_bytes(stream.read())
    except (subprocess.SubprocessError, tarfile.TarError):
        if required:
            raise


def browser_state_path(config):
    value = config.get("browser_state")
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ValueError("Configured browser storage-state file does not exist")
    return path


def capture_browser(state, environment):
    if state is None:
        print("Browser capture skipped: no storage state configured; verify the UI manually")
        return "skipped"
    subprocess.run(["node", str(SOURCE / "capture.mjs")], cwd=ROOT, env=environment, check=True)
    return "passed"


if __name__ == "__main__":
    main()
