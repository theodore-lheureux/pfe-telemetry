import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from snapshot import create_snapshot, digest, file_entry, validate_binaries, verify_snapshot


class SnapshotTests(unittest.TestCase):
    def test_uncommitted_files_are_copied_but_ignored_settings_are_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            (root / ".gitignore").write_text(".state/\n.env\n")
            (root / "source.rs").write_text("old")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                            "commit", "--quiet", "-m", "fixture"], cwd=root, check=True)
            (root / "source.rs").write_text("uncommitted")
            (root / "new.rs").write_text("untracked")
            (root / ".env").write_text("private")
            output = root / ".state"
            output.mkdir()
            manifest = create_snapshot(output, root)
            self.assertEqual(set(manifest["files"]), {".gitignore", "source.rs", "new.rs"})
            with tarfile.open(output / "source.tar.gz") as archive:
                self.assertEqual(archive.extractfile("source.rs").read(), b"uncommitted")
                self.assertEqual(archive.extractfile("new.rs").read(), b"untracked")

    def test_remote_snapshot_rejects_tampering_extra_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.rs"
            source.write_text("snapshot")
            files = {"source.rs": file_entry(source)[1]}
            manifest = {"files": files, "source_sha256": digest(files)}
            verify_snapshot(root, manifest)
            source.write_text("changed")
            with self.assertRaises(ValueError):
                verify_snapshot(root, manifest)
            source.write_text("snapshot")
            (root / "extra").write_text("unexpected")
            with self.assertRaises(ValueError):
                verify_snapshot(root, manifest)
            (root / "extra").unlink()
            source.unlink()
            source.symlink_to("/etc/passwd")
            with self.assertRaises(ValueError):
                verify_snapshot(root, manifest)
            manifest["files"] = {"../outside": files["source.rs"]}
            manifest["source_sha256"] = digest(manifest["files"])
            with self.assertRaises(ValueError):
                verify_snapshot(root, manifest)

    def test_receipt_checks_toolchain_snapshot_target_elf_and_both_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\x00"
            names = ("recount", "recount-collector")
            for name in names:
                (root / name).write_bytes(data)
            manifest = {"source_sha256": "snapshot", "commit": "commit"}
            receipt = {
                **manifest, "target": "x86_64-unknown-linux-gnu", "toolchain": "1.99.0",
                "sha256": {name: hashlib.sha256(data).hexdigest() for name in names},
            }
            path = root / "build.json"
            path.write_text(json.dumps(receipt))
            validate_binaries(root, manifest)
            for field in ("target", "toolchain", "source_sha256", "commit"):
                changed = {**receipt, field: "wrong"}
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    validate_binaries(root, manifest)
            path.write_text(json.dumps(receipt))
            (root / "recount").write_bytes(data + b"changed")
            with self.assertRaises(ValueError):
                validate_binaries(root, manifest)
            (root / "recount").write_bytes(b"not ELF")
            with self.assertRaises(ValueError):
                validate_binaries(root, manifest)


if __name__ == "__main__":
    unittest.main()
