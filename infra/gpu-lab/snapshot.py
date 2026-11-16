"""Private source archives without Git internals, ignored settings or build caches."""

import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(p in (".", "..", ".git") for p in path.parts):
        raise ValueError(f"Invalid snapshot path: {name}")
    return path


def file_entry(path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"Snapshot entries must be regular files: {path}")
    data = path.read_bytes()
    return data, {
        "sha256": hashlib.sha256(data).hexdigest(),
        "mode": 0o755 if metadata.st_mode & 0o111 else 0o644,
    }


def checkout_files(root=ROOT):
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root,
    ).decode().split("\0")
    files = {}
    for name in sorted(set(names) - {""}):
        safe_path(name)
        path = root / name
        if path.exists() or path.is_symlink():
            _, files[name] = file_entry(path)
    return files


def digest(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def create_snapshot(directory, root=ROOT):
    files = checkout_files(root)
    archive = directory / "source.tar.gz"
    with tarfile.open(archive, mode="w:gz") as output:
        for name, expected in files.items():
            data, actual = file_entry(root / name)
            if actual != expected:
                raise ValueError("Source changed while creating the snapshot")
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = expected["mode"]
            output.addfile(entry, io.BytesIO(data))
    if checkout_files(root) != files:
        raise ValueError("Source changed while creating the snapshot")
    manifest = {
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "source_sha256": digest(files),
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "files": files,
    }
    (directory / "snapshot.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def verify_snapshot(root, manifest):
    files = manifest["files"]
    if not files or digest(files) != manifest["source_sha256"]:
        raise ValueError("Snapshot manifest digest mismatch")
    for name, expected in files.items():
        relative = safe_path(name)
        path = root / name
        if any((root / parent).is_symlink() for parent in relative.parents if parent.parts):
            raise ValueError("Snapshot contains a symlink ancestor")
        _, actual = file_entry(path)
        if actual != expected:
            raise ValueError(f"Snapshot file changed: {name}")
    actual_names = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("Snapshot contains a symlink")
        if path.is_file():
            actual_names.add(path.relative_to(root).as_posix())
    if actual_names != set(files):
        raise ValueError("Snapshot contains missing or unexpected files")


def validate_binaries(directory, manifest):
    receipt = json.loads((directory / "build.json").read_text())
    if (
        receipt["target"] != "x86_64-unknown-linux-gnu"
        or receipt["toolchain"] != "1.99.0"
        or receipt["source_sha256"] != manifest["source_sha256"]
        or receipt["commit"] != manifest["commit"]
    ):
        raise ValueError("Build receipt does not match the source snapshot and pinned toolchain")
    for name in ("recount-collector", "recount"):
        data = (directory / name).read_bytes()
        if data[:6] != b"\x7fELF\x02\x01" or data[18:20] != b"\x3e\x00":
            raise ValueError(f"{name} is not an x86_64 Linux ELF executable")
        if hashlib.sha256(data).hexdigest() != receipt["sha256"][name]:
            raise ValueError(f"{name} does not match the build receipt")
    return receipt
