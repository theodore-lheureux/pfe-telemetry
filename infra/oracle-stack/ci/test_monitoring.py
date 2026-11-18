import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

MONITORING = Path(__file__).resolve().parents[1] / "deploy/monitoring"
spec = importlib.util.spec_from_file_location("sample_host", MONITORING / "sample-host.py")
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


class SamplerTest(unittest.TestCase):
    def test_unavailable_sources_do_not_emit_healthy_zeroes(self):
        with patch.object(sample, "command", side_effect=subprocess.TimeoutExpired("docker", 4)):
            result = sample.snapshot()
        for source in ("cpu", "disk", "queries", "points", "freshness"):
            self.assertIn(f'recount_ingestion_host_source_up{{source="{source}"}} 0\n', result)
        self.assertNotIn("recount_clickhouse_cpu_seconds_total", result)
        self.assertNotIn("recount_clickhouse_points_written_per_second", result)

    def test_freshness_uses_part_write_time_and_excludes_invalid_receipts(self):
        part = "20775_12_12_0"
        written = 1_800_000_000_000_000_000
        def payload(received):
            return (b"\x0a\x03\x21\x00\x00\x21" + received.to_bytes(8, "little")).hex()
        points = [f"{part}\t{payload(written - i * 10**9)}" for i in range(1, 21)]
        points.extend([f"{part}\t{payload(written + 1)}", f"{part}\t21ff"])
        with patch.object(sample, "freshness_query", side_effect=[f"{part}\t{written}", "\n".join(points)]):
            self.assertEqual(list(sample.freshness_metrics()), [
                "recount_ingestion_freshness_samples 20",
                "recount_ingestion_freshness_last_sample_timestamp_seconds 1800000000.0",
                "recount_ingestion_freshness_p95_seconds 19.0",
            ])
        with patch.object(sample, "freshness_query", return_value=""):
            self.assertEqual(list(sample.freshness_metrics()), ["recount_ingestion_freshness_samples 0"])

    def test_query_times_and_part_rows_are_scaled_to_dashboard_units(self):
        with patch.object(sample, "command", side_effect=["SelectQuery\t10\nSelectQueryTimeMicroseconds\t2500000\n", "12000"]):
            self.assertEqual(list(sample.query_metrics()), [
                "recount_clickhouse_select_queries_total 10",
                "recount_clickhouse_select_query_seconds_total 2.5",
            ])
            self.assertEqual(list(sample.point_metrics()), [
                "recount_clickhouse_points_written_per_second 100.0",
            ])

    def test_host_panels_gate_on_sampler_freshness(self):
        dashboard = json.loads((MONITORING / "dashboards/ingestion.json").read_text())
        self.assertEqual(len({panel["id"] for panel in dashboard["panels"]}), len(dashboard["panels"]))
        for panel in dashboard["panels"]:
            for target in panel["targets"]:
                expression = target["expr"]
                if "recount_clickhouse_" in expression or "recount_data_device_" in expression:
                    self.assertIn("time() - recount_ingestion_host_sample_timestamp_seconds < 45", expression)
