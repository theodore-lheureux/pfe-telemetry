import base64
import hashlib
import unittest

from ssh_host import verified_key


class HostKeyTests(unittest.TestCase):
    def test_only_the_guest_attribute_fingerprint_authorizes_a_scanned_key(self):
        blob = b"synthetic public key packet"
        key = base64.b64encode(blob).decode()
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
        line, algorithms = verified_key(f"untrusted-host ssh-ed25519 {key}", "192.0.2.1", fingerprint)
        self.assertEqual(line, f"192.0.2.1 ssh-ed25519 {key}\n")
        self.assertEqual(algorithms, "ssh-ed25519")
        for expected in ("MD5:wrong", "SHA256:" + "A" * 43):
            with self.assertRaises(ValueError):
                verified_key(f"192.0.2.1 ssh-ed25519 {key}", "192.0.2.1", expected)
        with self.assertRaises(ValueError):
            verified_key("192.0.2.1 ssh-ed25519 invalid!", "192.0.2.1", fingerprint)


if __name__ == "__main__":
    unittest.main()
