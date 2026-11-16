import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from run import browser_state_path, capture_browser, loopback_port, tunnels_ready, verify
from capabilities import PROFILING, parse_capabilities

A10_CAPABILITIES = parse_capabilities(
    (Path(__file__).resolve().parents[2] / "tests/fixtures/gpu/a10/profile-groups.txt").read_text()
)


def fixture(capabilities=A10_CAPABILITIES):
    """Synthetic assertions for the verifier, not hardware evidence."""
    def point(metric, value, attributes=(), attributed=False):
        return {
            "metric_name": metric, "int_value": None, "double_value": value,
            "attributes": attributes, "attributed": attributed,
            "resource_attributes": [("/gpu.uuid", "GPU-fixture")],
        }
    points = [
        point("recount.gpu.utilization", 1),
        point("recount.gpu.memory.used", 1024),
        point("recount.process.gpu.memory.used", 1024, attributed=True),
        point("recount.process.gpu.utilization", 0.5, attributed=True),
        *[point("recount.gpu.pipe.activity", 0.5, [("/gpu.pipe", pipe)])
          for pipe in capabilities["supported_pipes"]],
    ]
    for field, (metric, dimensions) in PROFILING.items():
        status = point("recount.collection.read.status", None, [
            *dimensions.items(), ("/recount.metric.name", metric),
        ])
        status["int_value"] = 1 if field in capabilities["unavailable_fields"] else 6
        points.append(status)
    return points


class VerificationTests(unittest.TestCase):
    def test_browser_capture_is_optional_but_a_configured_missing_file_is_an_error(self):
        for config in ({}, {"browser_state": None}, {"browser_state": ""}):
            self.assertIsNone(browser_state_path(config))
        with patch("run.subprocess.run") as run:
            self.assertEqual(capture_browser(None, {}), "skipped")
            run.assert_not_called()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            with self.assertRaises(ValueError):
                browser_state_path({"browser_state": str(path)})
            path.write_text("{}")
            self.assertEqual(browser_state_path({"browser_state": str(path)}), path.resolve())
            with patch("run.subprocess.run") as run:
                self.assertEqual(capture_browser(path, {}), "passed")
                run.assert_called_once()

    def test_real_usage_requires_all_pipes_and_attributed_process_points(self):
        self.assertTrue(all(verify(fixture(), A10_CAPABILITIES).values()))
        for name in ("recount.process.gpu.memory.used", "recount.process.gpu.utilization"):
            points = fixture()
            for point in points:
                if point["metric_name"] == name:
                    point["attributed"] = False
            with self.assertRaises(ValueError):
                verify(points, A10_CAPABILITIES)
        for pipe in ("tensor", "fp32", "fp16"):
            points = fixture()
            for point in points:
                if dict(point["attributes"]).get("/gpu.pipe") == pipe:
                    point["double_value"] = 0
            with self.assertRaises(ValueError):
                verify(points, A10_CAPABILITIES)

    def test_absent_fp64_is_not_zero_and_needs_explicit_unsupported_status(self):
        points = fixture()
        fabricated = copy.deepcopy(next(p for p in points if p["metric_name"] == "recount.gpu.pipe.activity"))
        fabricated["attributes"] = [("/gpu.pipe", "fp64")]
        fabricated["double_value"] = 0
        with self.assertRaises(ValueError):
            verify([*points, fabricated], A10_CAPABILITIES)
        unsupported = next(p for p in points if dict(p["attributes"]).get("/gpu.pipe") == "fp64")
        for status in (0, 4, 6):
            unsupported["int_value"] = status
            with self.assertRaises(ValueError):
                verify(points, A10_CAPABILITIES)

    def test_offered_fp64_is_loaded_and_missing_pipes_are_not_invented(self):
        capabilities = parse_capabilities("A.1 1001 1002 1003 1004 1005 1006 1007")
        self.assertIn("fp64", capabilities["supported_pipes"])
        self.assertIn("fp16", capabilities["unsupported_pipes"])
        points = fixture(capabilities)
        self.assertTrue(all(verify(points, capabilities).values()))
        for point in points:
            if point["metric_name"] == "recount.gpu.pipe.activity" and dict(point["attributes"]).get("/gpu.pipe") == "fp64":
                point["double_value"] = 0
        with self.assertRaises(ValueError):
            verify(points, capabilities)
        fabricated = copy.deepcopy(points[0])
        fabricated["metric_name"] = "recount.gpu.pcie.throughput"
        fabricated["attributes"] = [("/gpu.io.direction", "tx")]
        fabricated["double_value"] = 0
        with self.assertRaises(ValueError):
            verify([*fixture(capabilities), fabricated], capabilities)
        with self.assertRaises(ValueError):
            parse_capabilities("Error: profiling module unavailable")

    def test_public_endpoints_and_wildcard_forwards_are_rejected(self):
        self.assertEqual(loopback_port("http://127.0.0.1:3001"), 3001)
        for url in ("https://example.com", "http://0.0.0.0:3001", "http://localhost/app"):
            with self.assertRaises(ValueError):
                loopback_port(url)
        self.assertFalse(tunnels_ready(["127.0.0.1:43170"]))
        self.assertTrue(tunnels_ready(["127.0.0.1:43170", "127.0.0.1:30070"]))
        for address in ("0.0.0.0:43170", "[::]:43170", "*:43170"):
            with self.assertRaises(ValueError):
                tunnels_ready([address, "127.0.0.1:30070"])


if __name__ == "__main__":
    unittest.main()
