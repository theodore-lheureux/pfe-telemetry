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
    return f"#!/bin/bash\nset -euo pipefail\nsudo -n /usr/local/sbin/recount-release {release} {arch} {digest}\n"


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
        )
    )["data"]


def main():
    release, arch = os.environ["RELEASE"], os.environ["ARCH"]
    digest = (
        Path(f"assets/recount-ingestion-{arch}.tar.gz.sha256").read_text().split()[0]
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
    )
    print(f"Submitted OCI deployment command {result['id']}", flush=True)
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
    main()
