"""Materialize only the dedicated OCI deployment identity on an ephemeral runner."""

import os
from pathlib import Path


def main():
    metadata = {
        key: os.environ[key]
        for key in ("OCI_TENANCY_ID", "OCI_USER_ID", "OCI_API_KEY_FINGERPRINT")
    }
    if any(not value or "\n" in value or "\r" in value for value in metadata.values()):
        raise SystemExit("Invalid OCI deployment identity metadata")
    private_key = os.environ["OCI_API_PRIVATE_KEY"]
    if "PRIVATE KEY-----" not in private_key:
        raise SystemExit("OCI deployment private key is required")
    os.umask(0o077)
    root = Path.home() / ".oci"
    root.mkdir(mode=0o700, exist_ok=True)
    config = root / "config"
    if config.exists():
        raise SystemExit("Refusing to overwrite an existing OCI configuration")
    key_path = root / "deployment.pem"
    with open(
        key_path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)
    ) as key:
        key.write(private_key)
    config.write_text(
        "[recount-deploy]\nregion=ca-montreal-1\n"
        f"tenancy={metadata['OCI_TENANCY_ID']}\nuser={metadata['OCI_USER_ID']}\n"
        f"fingerprint={metadata['OCI_API_KEY_FINGERPRINT']}\nkey_file={key_path}\n"
    )


if __name__ == "__main__":
    main()
