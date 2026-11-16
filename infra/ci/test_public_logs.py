import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import public_logs


def event_stream(operation="plan"):
    return "\n".join(
        json.dumps(event)
        for event in [
            {
                "type": "planned_change",
                "@message": "Imported state belongs to owner+deployment@example.test",
                "change": {
                    "action": "update",
                    "resource": {
                        "resource_type": "oci_core_security_list",
                        "resource_name": "ingestion",
                        "resource_key": "ocid1.securitylist.oc1.private",
                        "addr": 'oci_core_security_list.ingestion["private-key"]',
                    },
                },
            },
            {
                "type": "outputs",
                "outputs": {"private": "ocid1.instance.oc1.private"},
            },
            {
                "type": "change_summary",
                "changes": {"add": 1, "change": 1, "remove": 0, "operation": operation},
            },
        ]
    )


class PublicLogTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("tofu"), "OpenTofu is not installed")
    def test_real_redacted_full_plan_without_cloud_providers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "main.tf").write_text(
                'resource "terraform_data" "probe" {\n'
                '  input = "owner+probe@example.test"\n'
                "}\n"
            )
            subprocess.run(
                ["tofu", f"-chdir={path}", "init", "-backend=false", "-input=false"],
                check=True,
                capture_output=True,
                text=True,
            )
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                result = public_logs.run_tofu(
                    str(path), "plan", {"PATH": os.environ["PATH"], "HOME": directory}
                )
            self.assertEqual(result, 0)
            visible = "\n".join(
                line
                for line in output.getvalue().splitlines()
                if not line.startswith("::add-mask::")
            )
            self.assertIn("Plan: 1 to add, 0 to change, 0 to destroy.", visible)
            self.assertIn("input", visible)
            self.assertNotIn("owner+probe@example.test", visible)

    def test_masks_nested_configuration_and_email_before_summary(self):
        environ = {
            "AWS_ACCOUNT_ID": "123456789012",
            "AWS_STATE_BUCKET": "private-state-bucket",
            "CLOUDFLARE_API_TOKEN": "synthetic-cloudflare-token",
            "TF_VAR_cloudflare_api_token": "synthetic-terraform-cloudflare-token",
            "INGESTION_TFVARS_JSON": json.dumps(
                {
                    "subnets": ["subnet-0123456789abcdef0"],
                    "nested": {"id": "ocid1.vnic.oc1.private"},
                }
            ),
        }
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            public_logs.mask(environ, event_stream())
        masks = output.getvalue()
        for value in [
            "123456789012",
            "private-state-bucket",
            "synthetic-cloudflare-token",
            "synthetic-terraform-cloudflare-token",
            "subnet-0123456789abcdef0",
            "ocid1.vnic.oc1.private",
            "owner+deployment@example.test",
        ]:
            self.assertIn(f"::add-mask::{value}\n", masks)
        self.assertNotIn("Plan:", masks)

    def test_mask_commands_escape_newlines_and_percent_signs(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            public_logs.mask({"AWS_STATE_BUCKET": "private%\n::notice::injected"})
        self.assertIn("private%25%0A::notice::injected", output.getvalue())
        self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_boolean_literals_are_not_registered_as_secret_job_outputs(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            public_logs.mask(
                {"COLLECTORS_TFVARS_JSON": '{"flag":"true","other":"false"}'}
            )
        self.assertNotIn("::add-mask::true\n", output.getvalue())
        self.assertNotIn("::add-mask::false\n", output.getvalue())

    def test_public_summary_never_contains_resource_keys_tags_or_outputs(self):
        lines = public_logs.summary(event_stream(), "plan")
        self.assertEqual(
            lines,
            [
                "# oci_core_security_list.ingestion: update (1)",
                "Plan: 1 to add, 1 to change, 0 to destroy.",
            ],
        )
        self.assertEqual(
            public_logs.summary(event_stream("apply"), "apply")[-1],
            "Apply complete! Resources: 1 added, 1 changed, 0 destroyed.",
        )
        for private in ("owner@", "ocid1.", "private-key"):
            self.assertNotIn(private, "\n".join(lines))

    def test_import_summary_omits_the_imported_identifier(self):
        events = [
            {
                "type": "planned_change",
                "change": {
                    "resource": {
                        "resource_type": "oci_core_security_list",
                        "resource_name": "ingestion",
                    },
                    "action": "noop",
                    "importing": {"id": "ocid1.securitylist.oc1.private"},
                },
            },
            {
                "type": "change_summary",
                "changes": {"add": 0, "change": 0, "remove": 0, "operation": "plan"},
            },
        ]
        lines = public_logs.summary(
            "\n".join(json.dumps(event) for event in events), "plan"
        )
        self.assertIn("# oci_core_security_list.ingestion: import (1)", lines)
        self.assertNotIn("ocid1.", "\n".join(lines))

    def test_failed_tofu_plan_diagnostics_are_redacted(self):
        output = io.StringIO()
        with (
            patch.object(public_logs.subprocess, "run") as process,
            contextlib.redirect_stdout(output),
        ):
            process.return_value.returncode = 1
            process.return_value.stdout = (
                "Error: private-state-bucket owner@example.test"
            )
            self.assertEqual(
                public_logs.run_tofu(
                    "infra/oci-ingestion",
                    "plan",
                    {"AWS_STATE_BUCKET": "private-state-bucket"},
                ),
                1,
            )
        visible = "\n".join(
            line
            for line in output.getvalue().splitlines()
            if not line.startswith("::add-mask::")
        )
        self.assertNotIn("private-state-bucket", visible)
        self.assertNotIn("owner@example.test", visible)
        command = process.call_args.args[0]
        self.assertIn("-no-color", command)
        self.assertNotIn("-json", command)
        self.assertIn("-lock-timeout=5m", command)

    def test_full_plan_is_printed_only_after_runtime_values_are_masked(self):
        output = io.StringIO()
        with (
            patch.object(public_logs.subprocess, "run") as process,
            contextlib.redirect_stdout(output),
        ):
            process.return_value.returncode = 0
            process.return_value.stdout = (
                "  # oci_core_security_list.ingestion will be updated in-place\n"
                '  ~ defined_tags = {"Oracle-Tags.CreatedBy" = "owner+deployment@example.test"}\n'
                '  ~ id = "ocid1.securitylist.oc1.private"\n'
                '  ~ content = "192.0.2.10"\n'
                '  ~ zone_id = "aabbccddaabbccddaabbccddaabbccdd"\n'
                "Plan: 1 to add, 1 to change, 0 to destroy.\n"
            )
            self.assertEqual(public_logs.run_tofu("infra/oci-ingestion", "plan", {}), 0)
        lines = output.getvalue().splitlines()
        mask_index = lines.index("::add-mask::owner+deployment@example.test")
        summary_index = lines.index(
            "  # oci_core_security_list.ingestion will be updated in-place"
        )
        self.assertLess(mask_index, summary_index)
        visible = "\n".join(
            line for line in lines if not line.startswith("::add-mask::")
        )
        self.assertNotIn("ocid1.", visible)
        self.assertIn("Oracle-Tags.CreatedBy", visible)
        self.assertIn("Plan: 1 to add", visible)
        self.assertNotIn("192.0.2.10", visible)
        self.assertNotIn("aabbccddaabbccddaabbccddaabbccdd", visible)
        self.assertNotIn("example.test", visible)

    def test_configured_collectors_emit_true_and_write_only_private_tfvars(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outputs"
            with (
                patch.object(public_logs.Path, "write_text") as write,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                public_logs.collectors_configuration(
                    {
                        "GITHUB_OUTPUT": str(path),
                        "COLLECTORS_TFVARS_JSON": '{"vpc_id":"vpc-0123456789abcdef0"}',
                    }
                )
            self.assertEqual(path.read_text(), "configured=true\n")
            write.assert_called_once_with('{"vpc_id": "vpc-0123456789abcdef0"}')

    def test_empty_collectors_configuration_skips_without_json_error(self):
        for raw in ("", " \n ", "{}"):
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "outputs"
                output = io.StringIO()
                with (
                    contextlib.redirect_stdout(output),
                    patch.object(public_logs.Path, "write_text") as write,
                ):
                    public_logs.collectors_configuration(
                        {"GITHUB_OUTPUT": str(path), "COLLECTORS_TFVARS_JSON": raw}
                    )
                self.assertEqual(path.read_text(), "configured=false\n")
                self.assertIn("::notice::Collectors plan skipped", output.getvalue())
                write.assert_not_called()

    def test_malformed_nonempty_configuration_fails_closed(self):
        with self.assertRaises(ValueError), contextlib.redirect_stdout(io.StringIO()):
            public_logs.collectors_configuration(
                {"COLLECTORS_TFVARS_JSON": "{private malformed data"}
            )
