#!/usr/bin/python3
"""Fetch the enrollment key on the instance at service start, into tmpfs only.

The key is read from SSM here rather than copied by Ansible because Ansible's SSM
connection transfers files through an S3 bucket.
"""

import os
from pathlib import Path

import boto3

KEY = Path("/run/recount-collector/enrollment.key")
NODE = Path("/var/lib/recount-collector/node/node.json")


def main():
    os.umask(0o077)
    if NODE.exists():
        KEY.unlink(missing_ok=True)
        return
    parameter = Path("/etc/recount-collector/enrollment-parameter").read_text().strip()
    value = boto3.client("ssm", region_name="us-east-2").get_parameter(
        Name=parameter, WithDecryption=True
    )["Parameter"]["Value"]
    KEY.write_text(value)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - never log decrypted enrollment values
        raise SystemExit("Collector enrollment failed; check SSM access privately.") from None
