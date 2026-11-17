"""Submit only the restricted release receiver command and await its exit status."""

import json
import os
import re
import subprocess
import time
from pathlib import Path


def command_text(release, arch, digest):
    if not re.fullmatch(r"[a-f0-9]{40}-[0-9]+-[0-9]+", release):
        raise ValueError("Invalid release identifier")
    if arch not in ("arm64", "amd64") or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid architecture or checksum")
    return (
        "#!/bin/bash\nset -euo pipefail\n"
        "receiver=/usr/local/sbin/recount-release\n"
        'if [[ ! -x "$receiver" ]]; then\n'
        "  echo 'Host bootstrap incomplete: the reviewed deployment receiver is not installed' >&2\n"
        "  exit 78\nfi\n"
        f'if ! sudo -n -l -- "$receiver" {release} {arch} {digest} >/dev/null 2>&1; then\n'
        "  echo 'Host bootstrap incomplete: receiver-only NOPASSWD permission is missing for ocarun' >&2\n"
        "  exit 78\nfi\n"
        f'sudo -n "$receiver" {release} {arch} {digest}\n'
    )


def oci(*args):
    return json.loads(
        subprocess.check_output(
            [
                "oci",
                "--profile",
                "recount-deploy",
                "--auth",
                "api_key",
                "--region",
                "ca-montreal-1",
                *args,
            ],
            text=True,
            timeout=90,
            stderr=subprocess.PIPE,
        ),
        strict=False,
    )["data"]


def save_execution(status, directory=None):
    directory = directory or Path(".state")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(
        directory / "oci-deploy-execution.json",
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(status, output)


def main():
    release, arch = os.environ["RELEASE"], os.environ["ARCH"]
    digest = (
        Path(f"assets/recount-stack-{arch}.tar.gz.sha256").read_text().split()[0]
    )
    text = command_text(release, arch, digest)
    target = os.environ["OCI_INSTANCE_ID"]
    content = {
        "source": {
            "sourceType": "TEXT",
            "text": text,
        },
        "output": {"outputType": "TEXT"},
    }
    result = oci(
        "instance-agent",
        "command",
        "create",
        "--compartment-id",
        os.environ["OCI_COMPARTMENT_ID"],
        "--target",
        json.dumps({"instanceId": target}),
        "--content",
        json.dumps(content),
        "--timeout-in-seconds",
        "1200",
        "--display-name",
        f"recount-stack-{release}",
    )
    print("Submitted OCI deployment command", flush=True)
    deadline = time.monotonic() + 1260
    while time.monotonic() < deadline:
        status = oci(
            "instance-agent",
            "command-execution",
            "get",
            "--command-id",
            result["id"],
            "--instance-id",
            target,
        )
        save_execution(status)
        state = status["lifecycle-state"]
        if state == "SUCCEEDED":
            if status.get("content", {}).get("exit-code") != 0:
                raise SystemExit("OCI reported success without a zero exit status")
            print("VM release activation succeeded")
            return
        if state in ("FAILED", "TIMED_OUT", "CANCELED"):
            raise SystemExit(
                f"Deployment {state}; inspect the OCI command and host privately"
            )
        time.sleep(10)
    raise SystemExit(
        "Deployment status timed out; inspect before retrying. Remote work may still be running."
    )


if __name__ == "__main__":
    try:
        main()
    except (subprocess.SubprocessError, ValueError, OSError, KeyError):
        raise SystemExit(
            "OCI deployment request failed; private identifiers and raw diagnostics were withheld."
        ) from None
