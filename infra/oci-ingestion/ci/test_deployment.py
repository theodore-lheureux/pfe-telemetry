import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import credentials

spec = importlib.util.spec_from_file_location(
    "run_command", Path(__file__).with_name("run-command.py")
)
run_command = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_command)


class CredentialTests(unittest.TestCase):
    def test_invalid_identity_never_writes_credentials(self):
        with (
            tempfile.TemporaryDirectory() as home,
            patch.object(Path, "home", return_value=Path(home)),
        ):
            with (
                patch.dict(
                    os.environ,
                    {
                        "OCI_TENANCY_ID": "invalid\nmetadata",
                        "OCI_USER_ID": "synthetic-user",
                        "OCI_API_KEY_FINGERPRINT": "synthetic-fingerprint",
                    },
                ),
                self.assertRaises(SystemExit),
            ):
                credentials.main()
            self.assertFalse((Path(home) / ".oci").exists())

    def test_credential_files_are_private_and_existing_configuration_is_preserved(self):
        values = {
            "OCI_API_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----",
            "OCI_API_KEY_FINGERPRINT": "synthetic-fingerprint",
            "OCI_USER_ID": "ocid1.user.oc1.test",
            "OCI_TENANCY_ID": "ocid1.tenancy.oc1.test",
        }
        previous_umask = os.umask(0o077)
        try:
            with (
                tempfile.TemporaryDirectory() as home,
                patch.object(Path, "home", return_value=Path(home)),
                patch.dict(os.environ, values),
            ):
                credentials.main()
                root = Path(home) / ".oci"
                for name in ("config", "deployment.pem"):
                    self.assertEqual((root / name).stat().st_mode & 0o777, 0o600)
                config = (root / "config").read_text()
                with self.assertRaises(SystemExit):
                    credentials.main()
                self.assertEqual((root / "config").read_text(), config)
        finally:
            os.umask(previous_umask)


class RunCommandTests(unittest.TestCase):
    def test_only_fixed_receiver_and_validated_arguments_reach_remote_shell(self):
        release = "a" * 40 + "-123-1"
        text = run_command.command_text(release, "arm64", "b" * 64)
        self.assertIn("/usr/local/sbin/recount-release", text)
        self.assertIn('if [[ ! -x "$receiver" ]]', text)
        self.assertIn('sudo -n -l -- "$receiver"', text)
        self.assertLess(len(text.encode()), 4096)
        for value in ("../../release", release + "; id", release + "\nwhoami"):
            with self.assertRaises(ValueError):
                run_command.command_text(value, "arm64", "b" * 64)
        with self.assertRaises(ValueError):
            run_command.command_text(release, "arm64;id", "b" * 64)

    def run_status(self, status):
        with tempfile.TemporaryDirectory() as directory:
            checksum = Path(directory) / "checksum"
            checksum.write_text("b" * 64 + "  recount-ingestion-arm64.tar.gz\n")
            with (
                patch.dict(
                    os.environ,
                    {
                        "RELEASE": "a" * 40 + "-123-1",
                        "ARCH": "arm64",
                        "OCI_INSTANCE_ID": "ocid1.instance.oc1.test",
                        "OCI_COMPARTMENT_ID": "ocid1.compartment.oc1.test",
                    },
                ),
                patch.object(run_command, "Path", return_value=checksum),
                patch.object(
                    run_command,
                    "oci",
                    side_effect=[{"id": "synthetic-command"}, status],
                ) as api,
                patch.object(run_command, "save_execution") as save,
            ):
                run_command.main()
                save.assert_called_once_with(status)
                arguments = api.call_args_list[0].args
                content = json.loads(arguments[arguments.index("--content") + 1])
                self.assertEqual(content["output"], {"outputType": "TEXT"})

    def test_cli_response_accepts_literal_control_characters(self):
        response = '{"data":{"content":{"text":"failure\\u001b[31m\\n"}}}'
        response = response.replace("\\u001b", "\x1b").replace("\\n", "\n")
        with patch.object(
            run_command.subprocess, "check_output", return_value=response
        ):
            self.assertEqual(
                run_command.oci("synthetic")["content"]["text"], "failure\x1b[31m\n"
            )

    def test_execution_receipt_is_private_and_retains_failure_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            receipt = path / "oci-deploy-execution.json"
            receipt.write_text("old")
            receipt.chmod(0o644)
            status = {
                "content": {"text": "sudo: a password is required\n", "exit-code": 1}
            }
            run_command.save_execution(status, path)
            self.assertEqual(json.loads(receipt.read_text()), status)
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)

    def test_api_acceptance_is_not_deployment_success(self):
        for status in (
            {"lifecycle-state": "FAILED"},
            {"lifecycle-state": "SUCCEEDED", "content": {"exit-code": 1}},
            {"lifecycle-state": "SUCCEEDED", "content": {}},
        ):
            with self.assertRaises(SystemExit):
                self.run_status(status)
        self.run_status({"lifecycle-state": "SUCCEEDED", "content": {"exit-code": 0}})


class ComposeTests(unittest.TestCase):
    def test_caddy_serves_only_owned_domains_using_the_tls_alpn_challenge(self):
        config = Path(__file__).resolve().parents[1] / "deploy" / "Caddyfile"
        text = config.read_text()
        sites = [
            line.split()[0] for line in text.splitlines() if line.startswith("https://")
        ]
        self.assertEqual(
            sites, ["https://app.recount.cloud", "https://ingest.recount.cloud"]
        )
        self.assertEqual(text.count("disable_http_challenge"), 2)
        self.assertIn("auto_https disable_redirects", text)

    def test_release_images_keep_loopback_ports_and_private_role_networks(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as directory:
            environment = Path(directory) / "release.env"
            environment.write_text(
                "RECOUNT_COLLECTOR_SIGNING_KEY=synthetic-only\n"
                "RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS=synthetic-only\n"
                "RECOUNT_LIVE_GATEWAY_SECRET=synthetic-only\n"
                "RECOUNT_INGESTION_IMAGE=recount-ingestion-api:synthetic\n"
                "RECOUNT_NORMALIZER_IMAGE=recount-normalizer:synthetic\n"
                "RECOUNT_WEB_IMAGE=recount-web:synthetic\n"
            )
            result = subprocess.check_output(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    "infra/local/.env.example",
                    "--env-file",
                    str(environment),
                    "--file",
                    "infra/local/compose.yaml",
                    "--file",
                    "infra/local/compose.apps.yaml",
                    "--file",
                    "infra/oci-ingestion/deploy/compose.yaml",
                    "config",
                    "--format",
                    "json",
                ],
                cwd=root,
                text=True,
                env={"PATH": os.environ["PATH"]},
            )
        services = json.loads(result)["services"]
        self.assertEqual(
            services["web"]["environment"]["BETTER_AUTH_URL"],
            "https://app.recount.cloud",
        )
        for role in ("ingestion-api", "normalizer", "web", "live"):
            expected = 512 if role == "live" else 1024
            self.assertEqual(int(services[role]["mem_limit"]), expected * 1024 * 1024)
            self.assertTrue(services[role]["image"].endswith(":synthetic"))
        self.assertEqual(int(services["clickhouse"]["mem_limit"]), 8192 * 1024 * 1024)
        total = sum(
            int(service.get("mem_limit", 0))
            for name, service in services.items()
            if name != "kafka-topics"
        )
        self.assertEqual(total, 14 * 1024 * 1024 * 1024)
        for service in services.values():
            for port in service.get("ports", []):
                self.assertEqual(port["host_ip"], "127.0.0.1")
        self.assertEqual(set(services["normalizer"]["networks"]), {"broker"})
        self.assertNotIn("ports", services["live"])
