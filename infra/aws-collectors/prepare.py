#!/usr/bin/python3
"""Install one checksum-pinned release and retrieve enrollment only into root tmpfs."""

import hashlib
import io
import json
import os
import tarfile
import urllib.request
from pathlib import Path

import boto3


def install(config):
    target = Path("/usr/local/bin/recount-collector")
    receipt = Path("/var/lib/recount-collector/release.sha256")
    if target.exists() and receipt.exists() and receipt.read_text() == config["sha256"]:
        return
    with urllib.request.urlopen(config["release_url"], timeout=60) as response:
        content = response.read(64 * 1024 * 1024 + 1)
    if (
        len(content) > 64 * 1024 * 1024
        or hashlib.sha256(content).hexdigest() != config["sha256"]
    ):
        raise ValueError("Collector archive size or checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        members = archive.getmembers()
        if (
            len(members) != 1
            or members[0].name != "recount-collector"
            or not members[0].isfile()
        ):
            raise ValueError("Expected one regular collector executable")
        if members[0].size > 128 * 1024 * 1024:
            raise ValueError("Collector executable exceeds release budget")
        source = archive.extractfile(members[0])
        binary = source.read()
        if binary[:4] != b"\x7fELF" or binary[18:20] != b"\xb7\x00":
            raise ValueError("Expected a native Linux ARM64 executable")
    temporary = target.with_suffix(".new")
    temporary.write_bytes(binary)
    temporary.chmod(0o755)
    temporary.replace(target)
    receipt.write_text(config["sha256"])


def main():
    os.umask(0o077)
    config = json.loads(Path("/etc/recount-collector/bootstrap.json").read_text())
    install(config)
    key_file = Path("/run/recount-collector/enrollment.key")
    if Path("/var/lib/recount-collector/node/node.json").exists():
        key_file.unlink(missing_ok=True)
        return
    value = boto3.client("ssm", region_name="us-east-2").get_parameter(
        Name=config["parameter"], WithDecryption=True
    )["Parameter"]["Value"]
    key_file.write_text(value)
    key_file.chmod(0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - Never log decrypted enrollment values through exception diagnostics.
        raise SystemExit(
            "Collector bootstrap failed; inspect connectivity, release and enrollment permissions privately."
        ) from None
