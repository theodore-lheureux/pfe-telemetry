"""Keep cloud metadata and full OpenTofu output out of public Actions logs."""

import argparse
import html
import json
import os
import re
import subprocess
from collections import Counter
from pathlib import Path

IDENTIFIERS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_ACCOUNT_ID",
    "AWS_STATE_BUCKET",
    "OCI_TENANCY_ID",
    "OCI_USER_ID",
    "OCI_API_KEY_FINGERPRINT",
    "OCI_INSTANCE_ID",
    "OCI_COMPARTMENT_ID",
    "CLOUDFLARE_API_TOKEN",
    "TF_VAR_cloudflare_api_token",
    "OCI_API_PRIVATE_KEY",
    "PLAN_ENCRYPTION_KEY",
)
CONFIGURATIONS = ("INGESTION_TFVARS_JSON", "COLLECTORS_TFVARS_JSON")
PRIVATE_PATTERNS = (
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    re.compile(r"\bocid1\.[A-Za-z0-9._-]+\b"),
    re.compile(r"\b\d{12}\b"),
    re.compile(r"\b(?:vpc|subnet|sg|ami|eni|vol|lt|i)-[0-9a-f]{8,}\b"),
    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    re.compile(r"\b[0-9a-fA-F]{32}\b"),
)
HCL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
ACTIONS = {"create", "read", "update", "replace", "delete", "move", "import"}


def strings(value):
    if isinstance(value, str) and value not in {"true", "false", "null"}:
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif (
        isinstance(value, int) and not isinstance(value, bool) and len(str(value)) == 12
    ):
        yield str(value)


def mask(environ, output=""):
    values = {environ.get(name, "") for name in IDENTIFIERS}
    for name in CONFIGURATIONS:
        raw = environ.get(name, "").strip()
        if not raw:
            continue
        values.add(raw)
        try:
            values.update(strings(json.loads(raw)))
        except json.JSONDecodeError:
            pass
        output += "\n" + raw
    for pattern in PRIVATE_PATTERNS:
        values.update(pattern.findall(output))
    for value in sorted(filter(None, values), key=lambda item: (-len(item), item)):
        escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::add-mask::{escaped}", flush=True)
    return set(filter(None, values))


def redact(output, values):
    for value in sorted(values, key=lambda item: (-len(item), item)):
        output = output.replace(value, "***")
    return output


def write_plan_summary(masked_plan, environ):
    path = environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    changes = [
        line.strip()
        for line in masked_plan.splitlines()
        if line.startswith(("  # ", "Plan:", "No changes."))
    ]
    preview = "\n".join(changes) or "No resource-change summary was emitted."
    with Path(path).open("a", encoding="utf-8") as output:
        output.write(
            "## OpenTofu plan\n\n"
            f"<pre>{html.escape(preview)}</pre>\n\n"
            "<details>\n<summary>Full masked plan</summary>\n\n"
            f"<pre>{html.escape(masked_plan)}</pre>\n\n"
            "</details>\n\n"
        )


def collectors_configuration(environ):
    mask(environ)
    raw = environ.get("COLLECTORS_TFVARS_JSON", "").strip()
    values = json.loads(raw) if raw else {}
    if not isinstance(values, dict):
        raise TypeError("Expected a configuration object")
    configured = bool(values)
    with Path(environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"configured={str(configured).lower()}\n")
    if not configured:
        print(
            "::notice::Collectors plan skipped: COLLECTORS_TFVARS_JSON is unset; "
            "configure it after Oracle is verified."
        )
        return
    os.umask(0o077)
    Path("infra/aws-collectors/terraform.tfvars.json").write_text(json.dumps(values))


def summary(output, operation):
    changes = Counter()
    totals = None
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "planned_change":
            change = event.get("change", {})
            resource = change.get("resource", {})
            kind, name, action = (
                resource.get("resource_type", ""),
                resource.get("resource_name", ""),
                change.get("action"),
            )
            if (
                HCL_NAME.fullmatch(kind)
                and HCL_NAME.fullmatch(name)
                and action in ACTIONS
            ):
                changes[(kind, name, action)] += 1
            if (
                HCL_NAME.fullmatch(kind)
                and HCL_NAME.fullmatch(name)
                and change.get("importing")
                and action != "import"
            ):
                changes[(kind, name, "import")] += 1
        if event.get("type") == "change_summary":
            value = event.get("changes", {})
            counts = [value.get(key) for key in ("add", "change", "remove")]
            if value.get("operation") == operation and all(
                type(count) is int and count >= 0 for count in counts
            ):
                totals = counts
    if totals is None:
        raise ValueError("No recognized OpenTofu summary")
    lines = [
        f"# {kind}.{name}: {action} ({count})"
        for (kind, name, action), count in sorted(changes.items())
    ]
    added, changed, removed = totals
    if operation == "plan":
        lines.append(
            f"Plan: {added} to add, {changed} to change, {removed} to destroy."
        )
    else:
        lines.append(
            f"Apply complete! Resources: {added} added, {changed} changed, {removed} destroyed."
        )
    return lines


def error_diagnostics(output, values):
    errors = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "diagnostic":
            continue
        diagnostic = event.get("diagnostic", {})
        if not isinstance(diagnostic, dict):
            continue
        if diagnostic.get("severity") != "error":
            continue
        text = f"Error: {diagnostic.get('summary', 'OpenTofu apply failed')}"
        if diagnostic.get("address"):
            text += f"\n  with {diagnostic['address']}"
        if diagnostic.get("detail"):
            text += f"\n{diagnostic['detail']}"
        errors.append(text)
    return redact("\n\n".join(errors) if errors else output, values)


def run_tofu(root, operation, environ):
    mask(environ)
    command = [
        "tofu",
        f"-chdir={root}",
        operation,
        "-no-color",
        "-input=false",
        "-lock-timeout=5m",
    ]
    command.append(
        "-out=deployment.tfplan" if operation == "plan" else "deployment.tfplan"
    )
    if operation == "apply":
        command.append("-json")
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=environ,
        check=False,
    )
    values = mask(environ, result.stdout)
    if operation == "plan":
        masked_plan = redact(result.stdout, values)
        print(masked_plan, end="", flush=True)
        write_plan_summary(masked_plan, environ)
        return result.returncode
    if result.returncode:
        print(f"::error::OpenTofu {operation} failed; redacted diagnostics follow.")
        print(error_diagnostics(result.stdout, values), flush=True)
        return result.returncode
    for line in summary(result.stdout, operation):
        print(line)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "operation", choices=["mask", "collectors-configuration", "plan", "apply"]
    )
    parser.add_argument(
        "root", nargs="?", choices=["infra/oci-ingestion", "infra/aws-collectors"]
    )
    args = parser.parse_args()
    if args.operation == "mask":
        mask(os.environ)
        return 0
    if args.operation == "collectors-configuration":
        collectors_configuration(os.environ)
        return 0
    if not args.root:
        parser.error("plan/apply requires a selected deployment root")
    return run_tofu(args.root, args.operation, os.environ)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, TypeError, KeyError):
        raise SystemExit(
            "Infrastructure configuration failed; private values and raw diagnostics were withheld."
        ) from None
