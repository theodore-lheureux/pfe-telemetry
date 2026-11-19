"""Expose the current synthetic-load plan and result contract to Ansible."""

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "recount_demo_load", Path(__file__).resolve().parents[1] / "files/recount_demo_load.py"
)
loads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loads)


class FilterModule:
    def filters(self):
        return {"demo_load_plan": loads.plan, "demo_load_summary": loads.summary}
