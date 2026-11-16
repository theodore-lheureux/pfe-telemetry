import configparser
import hashlib
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import prepare


class CollectorServiceTests(unittest.TestCase):
    def test_transient_bootstrap_failures_do_not_exhaust_restart_budget(self):
        config = configparser.ConfigParser(interpolation=None, strict=False)
        config.optionxform = str
        config.read(Path(__file__).with_name("collector.service"))
        interval = int(config["Unit"]["StartLimitIntervalSec"])
        burst = int(config["Unit"]["StartLimitBurst"])
        restart = int(config["Service"]["RestartSec"])
        self.assertEqual(restart, 75)
        self.assertGreater((burst - 1) * restart, interval - 1)
        self.assertEqual(
            config["Service"]["ExecStartPre"],
            "/usr/local/sbin/recount-collector-prepare enroll",
        )
        self.assertNotIn("/usr/local/bin", config["Service"]["ReadWritePaths"])


class ReleaseInstallationTests(unittest.TestCase):
    def archive(self, name="recount-collector", machine=b"\xb7\x00", symlink=False):
        binary = bytearray(64)
        binary[:4] = b"\x7fELF"
        binary[18:20] = machine
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w:gz") as archive:
            entry = tarfile.TarInfo(name)
            entry.size = len(binary)
            if symlink:
                entry.type = tarfile.SYMTYPE
                entry.linkname = "/etc/passwd"
                entry.size = 0
            archive.addfile(entry, io.BytesIO(binary))
        return content.getvalue()

    def install(self, content, directory):
        return prepare.install(
            {
                "sha256": hashlib.sha256(content).hexdigest(),
                "release_url": "https://example.invalid/release.tar.gz",
            },
            Path(directory) / "recount-collector",
            Path(directory) / "release.sha256",
        )

    def test_checksum_verified_installation_is_idempotent(self):
        content = self.archive()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)
            ) as download,
        ):
            self.assertTrue(self.install(content, directory))
            self.assertFalse(self.install(content, directory))
            self.assertEqual(download.call_count, 1)
            self.assertEqual(
                (Path(directory) / "recount-collector").stat().st_mode & 0o777,
                0o755,
            )

    def test_unsafe_archives_and_wrong_architecture_never_install(self):
        for content in (
            self.archive(name="../outside"),
            self.archive(symlink=True),
            self.archive(machine=b"\x3e\x00"),
        ):
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.object(
                    prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)
                ),
                self.assertRaises(ValueError),
            ):
                self.install(content, directory)

    def test_checksum_mismatch_never_installs(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                prepare.urllib.request,
                "urlopen",
                return_value=io.BytesIO(b"incorrect download"),
            ),
            self.assertRaises(ValueError),
        ):
            self.install(self.archive(), directory)
