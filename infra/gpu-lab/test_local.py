import json
import subprocess
import unittest
from unittest.mock import patch

from local import native_normalizer_ready


class NativeReadinessTests(unittest.TestCase):
    def container(self):
        return {"Id": "owned-container", "State": {"Running": True, "StartedAt": "current-start"}}

    def test_current_incarnation_requires_the_native_ready_signal(self):
        container = self.container()
        for log, passes in [
            ("state=starting\n", False),
            ("state=ready checks=initial_snapshot offset_reset=earliest\n", True),
            ("state=ready checks=initial_snapshot offset_reset=earliest\nstate=stopping\n", False),
            ("state=ready checks=initial_snapshot offset_reset=earliest\nstate=fatal reason=error\n", False),
        ]:
            result = subprocess.CompletedProcess([], 0, stdout="", stderr=log)
            with patch("local.subprocess.run", return_value=result) as run, patch(
                "local.subprocess.check_output", return_value=json.dumps([container]).encode()
            ):
                if passes:
                    native_normalizer_ready(container)
                    self.assertIn("current-start", run.call_args.args[0])
                else:
                    with self.assertRaises(ValueError):
                        native_normalizer_ready(container)

    def test_restarts_do_not_reuse_old_readiness(self):
        result = subprocess.CompletedProcess(
            [], 0, stdout="", stderr="state=ready checks=initial_snapshot offset_reset=earliest\n",
        )
        restarted = self.container()
        restarted["State"]["StartedAt"] = "new-start"
        with patch("local.subprocess.run", return_value=result), patch(
            "local.subprocess.check_output", return_value=json.dumps([restarted]).encode()
        ):
            with self.assertRaises(ValueError):
                native_normalizer_ready(self.container())


if __name__ == "__main__":
    unittest.main()
