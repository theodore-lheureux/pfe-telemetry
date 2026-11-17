"""Temporary Recount collectors on Google Cloud for tests and demos."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
KEYS = ROOT / ".state" / "keys"
PROJECT = os.environ.get("RECOUNT_DEMO_GCP_PROJECT", "recount-cloud")
REPOSITORY = os.environ.get("RECOUNT_REPOSITORY", "theodore-lheureux/pfe-telemetry")
SSH_USER = "recount"
SSH_KEY = Path.home() / ".ssh" / "id_ed25519"
LABEL = "recount-demo"
# Zones with GPU quota, tried in order; capacity varies, quota does not.
GPU_ZONES = ["us-central1-a", "us-central1-b", "us-central1-c", "us-east1-c",
             "us-east1-d", "northamerica-northeast1-c"]
CPU_ZONES = ["us-central1-a", "us-east1-b", "northamerica-northeast1-a"]


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]


def run(*command, capture=True):
    result = subprocess.run(command, text=True, capture_output=capture, check=False)
    if result.returncode:
        raise SystemExit((result.stderr or "").strip() or f"{command[0]} failed")
    return result.stdout


def gcloud(*args):
    return run("gcloud", *args, f"--project={PROJECT}")


def key_file(project):
    path = KEYS / f"{slug(project)}.key"
    if not path.is_file():
        raise SystemExit(f"No enrollment key for {project!r}; run: just demo key {project!r}")
    return path


def latest_release():
    tag = run("gh", "release", "list", "-R", REPOSITORY, "--limit", "20", "--json",
              "tagName", "--jq", '[.[].tagName | select(startswith("release-"))][0]').strip()
    if not tag:
        raise SystemExit("No release-* build is published yet")
    digest = run("gh", "release", "download", tag, "-R", REPOSITORY, "--pattern",
                 "recount-collector-amd64.tar.gz.sha256", "--output", "-").split()[0]
    return tag, digest


def create(name, gpu, ttl):
    pubkey = " ".join(SSH_KEY.with_suffix(".pub").read_text().split()[:2])
    common = [
        "--provisioning-model=SPOT", "--instance-termination-action=DELETE",
        f"--max-run-duration={ttl}", "--maintenance-policy=TERMINATE",
        f"--labels={LABEL}=true", "--boot-disk-size=60GB",
        # Guest attributes publish the host keys used to verify the first SSH connection.
        f"--metadata=enable-oslogin=FALSE,enable-guest-attributes=TRUE,ssh-keys={SSH_USER}:{pubkey}",
        "--format=json",
    ]
    if gpu:
        shapes = [["--machine-type=g2-standard-4"],
                  ["--machine-type=n1-standard-4", "--accelerator=type=nvidia-tesla-t4,count=1"]]
        image = ["--image-family=common-cu129-ubuntu-2204-nvidia-580",
                 "--image-project=deeplearning-platform-release"]
        zones = GPU_ZONES
    else:
        shapes = [["--machine-type=e2-small"]]
        image = ["--image-family=ubuntu-2204-lts", "--image-project=ubuntu-os-cloud"]
        zones = CPU_ZONES
    for shape in shapes:
        for zone in zones:
            result = subprocess.run(
                ["gcloud", "compute", "instances", "create", name, f"--zone={zone}",
                 f"--project={PROJECT}", *shape, *image, *common],
                text=True, capture_output=True, check=False)
            if result.returncode == 0:
                instance = json.loads(result.stdout)[0]
                return zone, instance["networkInterfaces"][0]["accessConfigs"][0]["natIP"]
            if not re.search(r"STOCKOUT|RESOURCE_POOL_EXHAUSTED|not available|does not have enough", result.stderr):
                raise SystemExit(result.stderr.strip())
    raise SystemExit("No Spot capacity in the configured zones; try again later")


def known_hosts(name, zone, address):
    for _ in range(36):
        key = subprocess.run(
            ["gcloud", "compute", "instances", "get-guest-attributes", name, f"--zone={zone}",
             f"--project={PROJECT}", "--query-path=hostkeys/ssh-ed25519", "--format=value(value)"],
            text=True, capture_output=True, check=False).stdout.strip()
        if key:
            path = ROOT / ".state" / f"{name}.known_hosts"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{address} ssh-ed25519 {key}\n")
            return path
        time.sleep(10)
    raise SystemExit(f"{name} did not publish its SSH host key")


def playbook(address, hosts_file, project, gpu=False, load=False, reenroll=False):
    tag, digest = latest_release()
    extra = {
        "recount_release": tag, "recount_release_sha256": digest,
        "recount_repository": REPOSITORY, "recount_enrollment_key_file": str(key_file(project)),
        "recount_gpu": gpu, "recount_load": load, "recount_reenroll": reenroll,
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json") as variables:
        json.dump(extra, variables)
        variables.flush()
        run("uv", "run", "--locked", "ansible-playbook", str(ROOT / "collector.yml"),
            "--inventory", f"{address},", "--limit", address, "--extra-vars", f"@{variables.name}",
            "--user", SSH_USER, "--private-key", str(SSH_KEY),
            "--ssh-common-args", f"-o StrictHostKeyChecking=yes -o UserKnownHostsFile={hosts_file}",
            "-e", "ansible_python_interpreter=/usr/bin/python3",
            capture=False)


def instances():
    return json.loads(gcloud("compute", "instances", "list", f"--filter=labels.{LABEL}=true",
                             "--format=json"))


def find(name):
    for item in instances():
        if item["name"] == name:
            zone = item["zone"].rsplit("/", 1)[-1]
            return zone, item["networkInterfaces"][0]["accessConfigs"][0]["natIP"]
    raise SystemExit(f"No demo collector named {name!r}")


def main():
    parser = argparse.ArgumentParser(prog="just demo")
    commands = parser.add_subparsers(dest="command", required=True)
    key = commands.add_parser("key", help="store a project's enrollment key from stdin")
    key.add_argument("project")
    up = commands.add_parser("up", help="start temporary collectors")
    up.add_argument("--project", required=True)
    up.add_argument("--gpu", action="store_true")
    up.add_argument("--load", action="store_true", help="run a labelled GPU workload")
    up.add_argument("--ttl", default="2h", help="hard expiry, e.g. 90m or 4h")
    up.add_argument("--count", type=int, default=1)
    commands.add_parser("list", help="show running demo collectors")
    move = commands.add_parser("move", help="re-enroll a collector into another project")
    move.add_argument("name")
    move.add_argument("--project", required=True)
    down = commands.add_parser("down", help="delete demo collectors")
    down.add_argument("names", nargs="*")
    down.add_argument("--all", action="store_true")
    args = parser.parse_args()

    if args.command == "key":
        KEYS.mkdir(parents=True, exist_ok=True)
        os.umask(0o077)
        value = sys.stdin.read().strip()
        if not value:
            raise SystemExit("Paste the enrollment key on stdin")
        (KEYS / f"{slug(args.project)}.key").write_text(value + "\n")
        print(f"Stored the enrollment key for {args.project!r}")
    elif args.command == "up":
        if args.load and not args.gpu:
            raise SystemExit("--load needs --gpu")
        key_file(args.project)
        for index in range(args.count):
            name = f"demo-{slug(args.project)}-{'gpu-' if args.gpu else ''}{int(time.time()) % 100000}{index}"
            zone, address = create(name, args.gpu, args.ttl)
            print(f"{name}: {zone} {address}; deleted automatically after {args.ttl}")
            playbook(address, known_hosts(name, zone, address), args.project, args.gpu, args.load)
    elif args.command == "list":
        for item in instances():
            scheduling = item.get("scheduling", {})
            print(item["name"], item["zone"].rsplit("/", 1)[-1], item["status"],
                  "expires", scheduling.get("terminationTime", "?"))
    elif args.command == "move":
        zone, address = find(args.name)
        gpu = "-gpu-" in args.name
        playbook(address, ROOT / ".state" / f"{args.name}.known_hosts", args.project,
                 gpu=gpu, reenroll=True)
    elif args.command == "down":
        names = [item["name"] for item in instances()] if args.all else args.names
        for name in names:
            zone, _ = find(name)
            gcloud("compute", "instances", "delete", name, f"--zone={zone}", "--quiet")
            print(f"Deleted {name}")


if __name__ == "__main__":
    main()
