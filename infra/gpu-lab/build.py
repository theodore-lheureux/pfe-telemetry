#!/usr/bin/env python3
"""Build a verified source snapshot on the native x86_64 Ubuntu 22.04 GPU VM."""

import argparse
import hashlib
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys

from snapshot import ROOT, validate_binaries, verify_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or platform.machine() != "x86_64":
        parser.error("Build on the native x86_64 Linux lab host")
    manifest = json.loads(args.snapshot.read_text())
    verify_snapshot(ROOT, manifest)
    rustc = subprocess.check_output(["rustc", "+1.99.0", "--version"], text=True).strip()
    if not rustc.startswith("rustc 1.99.0 ("):
        raise ValueError("Expected the pinned stable Rust 1.99.0 toolchain")
    # Discover outputs and respect the invoking lab's private Cargo cache.
    metadata = json.loads(subprocess.check_output(
        ["cargo", "+1.99.0", "metadata", "--no-deps", "--format-version", "1"], cwd=ROOT,
    ))
    print(f"Cargo target directory: {metadata['target_directory']}", file=sys.stderr)
    result = subprocess.check_output([
        "cargo", "+1.99.0", "build", "--locked", "--release", "--jobs", "4",
        "--target", "x86_64-unknown-linux-gnu",
        "-p", "recount-collector", "-p", "recount", "--message-format=json",
    ], cwd=ROOT, text=True)
    verify_snapshot(ROOT, manifest)
    args.output.mkdir(parents=True, exist_ok=False)
    hashes = {}
    for line in result.splitlines():
        event = json.loads(line)
        name = event.get("target", {}).get("name")
        if event.get("executable") and name in ("recount", "recount-collector"):
            path = args.output / name
            shutil.copy2(event["executable"], path)
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if set(hashes) != {"recount", "recount-collector"}:
        raise RuntimeError("Cargo did not produce both executables")
    (args.output / "build.json").write_text(json.dumps({
        "source_sha256": manifest["source_sha256"],
        "commit": manifest["commit"],
        "toolchain": "1.99.0",
        "rustc": rustc,
        "target": "x86_64-unknown-linux-gnu",
        "sha256": hashes,
    }, indent=2) + "\n")
    validate_binaries(args.output, manifest)


if __name__ == "__main__":
    main()
