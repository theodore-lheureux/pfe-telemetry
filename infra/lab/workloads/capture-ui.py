#!/usr/bin/env python3
"""Capture execution pages using an already authenticated agent-browser session."""

import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import quote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--session", default="workload-evidence")
    args = parser.parse_args()
    project_url = os.environ["RECOUNT_PROJECT_URL"].rstrip("/")
    runs = {
        category: json.loads(next((args.directory / category).glob("*/run.json")).read_text())
        for category in ["cpu", "memory", "io", "distributed"]
    }

    def browser(*command):
        return subprocess.check_output(
            ["agent-browser", "--session", args.session, *command], text=True, timeout=60,
        )

    def evaluate(script):
        response = json.loads(browser("eval", script, "--json"))
        if not response["success"]:
            raise RuntimeError(response["error"])
        return json.loads(response["data"]["result"])

    browser("open", project_url + "/executions")
    browser("wait", "--text", "Workload cpu")
    listing = evaluate("""JSON.stringify({
        path: location.pathname,
        links: Array.from(document.querySelectorAll('main a'), a => ({
            text: a.textContent, path: new URL(a.href).pathname
        }))
    })""")
    paths = {"/executions/" + quote(run["execution_key"], safe="") for run in runs.values()}
    listing["links"] = [
        link for link in listing["links"] if any(link["path"].endswith(path) for path in paths)
    ]
    (args.directory / "ui-listing.json").write_text(json.dumps(listing, indent=2) + "\n")
    for category, run in runs.items():
        key = run["execution_key"]
        path = "/executions/" + quote(key, safe="")
        if not any(link["path"].endswith(path) for link in listing["links"]):
            raise ValueError(f"{key}: absent from the execution listing")
        browser("open", project_url + path)
        browser("wait", "--text", key)
        view = evaluate("""JSON.stringify({
            path: location.pathname,
            heading: document.querySelector('h1')?.textContent,
            text: document.querySelector('main')?.innerText,
            times: Array.from(document.querySelectorAll('main time'), e => e.getAttribute('datetime'))
        })""")
        count = 2 if category == "distributed" else 1
        variable = "SLURM_JOB_ID" if category == "distributed" else "RECOUNT_EXECUTION"
        for expected in [key, f"Nodes: {count}", f"Participants: {count}", variable]:
            if expected not in view["text"]:
                raise ValueError(f"{key}: missing {expected!r} in the English UI")
        (args.directory / category / "ui.json").write_text(json.dumps(view, indent=2) + "\n")
        print(f"{key}: UI verified")


if __name__ == "__main__":
    main()
