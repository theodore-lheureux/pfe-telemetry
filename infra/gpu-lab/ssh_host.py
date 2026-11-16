"""Pin an SSH key only after matching an out-of-band GCP guest-attribute fingerprint."""

import base64
import hashlib
import re
import subprocess

ALGORITHMS = {
    "ssh-ed25519": "ssh-ed25519",
    "ecdsa-sha2-nistp256": "ecdsa-sha2-nistp256",
    "ssh-rsa": "rsa-sha2-512,rsa-sha2-256",
}


def verified_key(scan, ip, expected):
    if not re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", expected):
        raise ValueError("Supply the SHA256 host-key fingerprint from trusted GCP guest attributes")
    for line in scan.splitlines():
        if line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) != 3 or fields[1] not in ALGORITHMS:
            continue
        try:
            blob = base64.b64decode(fields[2], validate=True)
        except ValueError:
            continue
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
        if fingerprint == expected:
            return f"{ip} {fields[1]} {fields[2]}\n", ALGORITHMS[fields[1]]
    raise ValueError("Scanned host keys do not match the trusted GCP guest-attribute fingerprint")


def pin_host_key(ip, expected, directory):
    # keyscan is untrusted discovery, never trust-on-first-use authorization.
    scan = subprocess.run(
        ["ssh-keyscan", "-T", "10", "-t", "ed25519,ecdsa,rsa", str(ip)],
        capture_output=True, text=True, check=True, timeout=40,
    )
    key, algorithms = verified_key(scan.stdout, ip, expected)
    path = directory / "known_hosts"
    with path.open("x") as file:
        file.write(key)
    return ["-o", f"UserKnownHostsFile={path}", "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", f"HostKeyAlgorithms={algorithms}"]
