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

    def test_failed_apply_emits_useful_redacted_diagnostics(self):
        diagnostic = {
            "type": "diagnostic",
            "diagnostic": {
                "severity": "error",
                "summary": "404-NotAuthorizedOrNotFound",
                "address": "oci_core_volume_attachment.data[0]",
                "detail": (
                    "AttachVolume denied for ocid1.instance.oc1.private; "
                    "account=123456789012; actor=owner@example.test; "
                    "key=synthetic-access-key; zone=aabbccddaabbccddaabbccddaabbccdd; "
                    "origin=192.0.2.10"
                ),
            },
        }
        output = io.StringIO()
        with (
            patch.object(public_logs.subprocess, "run") as process,
            contextlib.redirect_stdout(output),
        ):
            process.return_value.returncode = 1
            process.return_value.stdout = (
                event_stream("apply") + "\n" + json.dumps(diagnostic)
            )
            result = public_logs.run_tofu(
                "infra/oci-ingestion",
                "apply",
                {"AWS_ACCESS_KEY_ID": "synthetic-access-key"},
            )
        self.assertEqual(result, 1)
        visible = "\n".join(
            line
            for line in output.getvalue().splitlines()
            if not line.startswith("::add-mask::")
        )
        self.assertIn("404-NotAuthorizedOrNotFound", visible)
        self.assertIn("AttachVolume denied", visible)
        self.assertIn("oci_core_volume_attachment.data[0]", visible)
        for private in (
            "ocid1.instance.oc1.private",
            "123456789012",
            "owner@example.test",
            "synthetic-access-key",
            "aabbccddaabbccddaabbccddaabbccdd",
            "192.0.2.10",
        ):
            self.assertNotIn(private, visible)
        self.assertNotIn('"outputs"', visible)

    def test_plain_apply_failure_also_keeps_diagnostics_and_masks_private_values(self):
        output = io.StringIO()
        with (
            patch.object(public_logs.subprocess, "run") as process,
            contextlib.redirect_stdout(output),
        ):
            process.return_value.returncode = 1
            process.return_value.stdout = (
                "Error acquiring the state lock for private-state-bucket"
            )
            public_logs.run_tofu(
                "infra/oci-ingestion",
                "apply",
                {"AWS_STATE_BUCKET": "private-state-bucket"},
            )
        visible = "\n".join(
            line
            for line in output.getvalue().splitlines()
            if not line.startswith("::add-mask::")
        )
        self.assertIn("Error acquiring the state lock", visible)
        self.assertNotIn("private-state-bucket", visible)

    def test_host_failure_tail_normalizes_controls_and_redacts_runtime_values(self):
        text = (
            "older output must not be shown\n" * 50
            + "recent context\n" * 40
            + "\x1b[31mHost failed\x1b[0m\r\n"
            + "id=ocid1.inst\x1b[31mance.oc1.private\x1b[0m\x00\n"
            + "owner+host@example.test 192.0.2.10 aabbccddaabbccddaabbccddaabbccdd\n"
            + "key=synthetic-secret\n"
            + "database=postgresql://runtime:host-password@postgres:5432/recount\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "execution.json"
            path.write_text(json.dumps({"content": {"exit-code": 1, "text": text}}))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                public_logs.host_failure_tail(
                    {"AWS_SECRET_ACCESS_KEY": "synthetic-secret"},
                    path,
                )
            visible = "\n".join(
                line
                for line in output.getvalue().splitlines()
                if not line.startswith("::add-mask::")
            )
            self.assertIn("OCI host exit code: 1", visible)
            self.assertIn("Host failed", visible)
            for private in (
                "ocid1.instance.oc1.private",
                "owner+host@example.test",
                "192.0.2.10",
                "aabbccddaabbccddaabbccddaabbccdd",
                "synthetic-secret",
                "host-password",
            ):
                self.assertNotIn(private, visible)
            self.assertNotIn("\x1b", visible)
            self.assertNotIn("\x00", visible)
            self.assertNotIn("\r", visible)
            self.assertNotIn("older output", visible)

    def test_absent_host_receipt_is_not_reported_as_a_host_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                public_logs.host_failure_tail({}, Path(directory) / "absent.json")
            self.assertIn(
                "No OCI host execution output was captured", output.getvalue()
            )

    def test_host_output_is_redacted_before_tail_truncation(self):
        secret = "synthetic-secret-" * 12
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "execution.json"
            path.write_text(json.dumps({"content": {"text": secret + "y" * 4000}}))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                public_logs.host_failure_tail({"AWS_SECRET_ACCESS_KEY": secret}, path)
            visible = "\n".join(
                line
                for line in output.getvalue().splitlines()
                if not line.startswith("::add-mask::")
            )
            self.assertNotIn("synthetic", visible)

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

    def test_plan_job_summary_uses_the_same_redacted_diff_for_both_roots(self):
        plan = (
            "  # cloudflare_dns_record.ingestion will be created\n"
            '  + zone_id = "aabbccddaabbccddaabbccddaabbccdd"\n'
            '  + content = "192.0.2.10"\n'
            '  + owner = "owner+summary@example.test"\n'
            '  + id = "ocid1.instance.oc1.private"\n'
            '  + account = "123456789012"\n'
            '  + bucket = "private-state-bucket"\n'
            '  + diagnostic = "synthetic-access-key"\n'
            '  + comment = "</pre></details><script>unsafe</script>"\n'
            "Plan: 1 to add, 0 to change, 0 to destroy.\n"
        )
        for root in ("infra/oci-ingestion", "infra/aws-collectors"):
            with self.subTest(root=root), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "summary.md"
                path.write_text("Existing summary\n\n")
                environ = {
                    "GITHUB_STEP_SUMMARY": str(path),
                    "AWS_ACCOUNT_ID": "123456789012",
                    "AWS_STATE_BUCKET": "private-state-bucket",
                    "AWS_ACCESS_KEY_ID": "synthetic-access-key",
                }
                log = io.StringIO()
                with (
                    patch.object(public_logs.subprocess, "run") as process,
                    contextlib.redirect_stdout(log),
                ):
                    process.return_value.returncode = 0
                    process.return_value.stdout = plan
                    self.assertEqual(public_logs.run_tofu(root, "plan", environ), 0)
                text = path.read_text()
                visible_log = "\n".join(
                    line
                    for line in log.getvalue().splitlines()
                    if not line.startswith("::add-mask::")
                )
                for private in (
                    "aabbccddaabbccddaabbccddaabbccdd",
                    "192.0.2.10",
                    "owner+summary@example.test",
                    "ocid1.instance.oc1.private",
                    "123456789012",
                    "private-state-bucket",
                    "synthetic-access-key",
                ):
                    self.assertNotIn(private, text)
                    self.assertNotIn(private, visible_log)
                self.assertTrue(text.startswith("Existing summary\n\n"))
                self.assertIn("<details>", text)
                self.assertIn("<summary>Full masked plan</summary>", text)
                self.assertIn("&lt;script&gt;unsafe&lt;/script&gt;", text)
                self.assertNotIn("<script>", text)
                self.assertEqual(text.count("</details>"), 1)
                preview, details = text.split("<details>", 1)
                self.assertIn(
                    "# cloudflare_dns_record.ingestion will be created", preview
                )
                self.assertIn("Plan: 1 to add, 0 to change, 0 to destroy.", preview)
                self.assertNotIn("+ content", preview)
                self.assertIn("+ content = &quot;***&quot;", details)
                self.assertIn("-no-color", process.call_args.args[0])

    def test_no_change_plan_summary_does_not_invent_resource_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.md"
            public_logs.write_plan_summary(
                "No changes. Your infrastructure matches the configuration.\n",
                {"GITHUB_STEP_SUMMARY": str(path)},
            )
            self.assertIn("No changes.", path.read_text().split("<details>", 1)[0])

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
