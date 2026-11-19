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
        for source in ("cpu", "cpu_kafka", "disk", "queries", "part_log", "active_parts", "active_nodes", "freshness"):
            self.assertIn(f'recount_ingestion_host_source_up{{source="{source}"}} 0\n', result)
        self.assertNotIn("recount_ingestion_container_cpu_seconds_total", result)
        self.assertNotIn("recount_clickhouse_new_rows_per_second", result)
        self.assertNotIn("recount_ingestion_active_nodes", result)

    def test_freshness_uses_part_write_time_and_excludes_invalid_receipts(self):
        part = "20775_12_12_0"
        written = 1_800_000_000_000_000_000
        points = [f"{part}\t{written - i * 10**9}" for i in range(1, 21)]
        points.extend([f"{part}\t{written + 1}", f"{part}\t0"])
        with patch.object(sample, "clickhouse_query", side_effect=[f"{part}\t{written}", "\n".join(points)]):
            self.assertEqual(list(sample.freshness_metrics()), [
                "recount_ingestion_freshness_samples 20",
                "recount_ingestion_freshness_last_sample_timestamp_seconds 1800000000.0",
                "recount_ingestion_freshness_p95_seconds 19.0",
                "recount_ingestion_freshness_p95_samples 20",
                "recount_ingestion_freshness_p95_write_timestamp_seconds 1800000000.0",
            ])
        with patch.object(sample, "clickhouse_query", return_value=""):
            self.assertEqual(list(sample.freshness_metrics()), ["recount_ingestion_freshness_samples 0"])

    def test_query_times_and_part_rows_are_scaled_to_dashboard_units(self):
        with patch.object(sample, "command", return_value="SelectQuery\t10\nSelectQueryTimeMicroseconds\t2500000\n"):
            self.assertEqual(list(sample.query_metrics()), [
                "recount_clickhouse_select_queries_total 10",
                "recount_clickhouse_select_query_seconds_total 2.5",
            ])
        with patch.object(sample, "clickhouse_query", side_effect=[
            "metric_points\t12000\t18000\t60000000\nmetric_series\t0\t24\t12000000\n",
            "metric_points\t17\nmetric_series\t0\n",
        ]):
            self.assertEqual(list(sample.part_metrics()), [
                'recount_clickhouse_new_rows_per_second{table="metric_points"} 100.0',
                'recount_clickhouse_merge_cpu_seconds_per_second{table="metric_points"} 0.5',
                'recount_clickhouse_merge_rows_per_new_row{table="metric_points"} 1.5',
                'recount_clickhouse_new_rows_per_second{table="metric_series"} 0.0',
                'recount_clickhouse_merge_cpu_seconds_per_second{table="metric_series"} 0.1',
            ])
            self.assertEqual(list(sample.active_part_metrics()), [
                'recount_clickhouse_active_parts{table="metric_points"} 17',
                'recount_clickhouse_active_parts{table="metric_series"} 0',
            ])

    def test_cgroup_cpu_counters_and_clickhouse_limit(self):
        files = {
            "/proc/42/cgroup": "0::/test\n",
            "/sys/fs/cgroup/test/cpu.stat": "usage_usec 1500000\nnr_periods 20\nnr_throttled 3\n",
            "/sys/fs/cgroup/test/cpu.max": "200000 100000\n",
        }
        with patch.object(Path, "read_text", lambda path: files[str(path)]):
            self.assertEqual(list(sample.cpu_metrics("kafka", 42)), [
                'recount_ingestion_container_cpu_seconds_total{service="kafka"} 1.5',
            ])
            self.assertEqual(list(sample.cpu_metrics("clickhouse", 42)), [
                'recount_ingestion_container_cpu_seconds_total{service="clickhouse"} 1.5',
                "recount_clickhouse_cpu_periods_total 20",
                "recount_clickhouse_cpu_throttled_periods_total 3",
                "recount_clickhouse_cpu_limit_cores 2.0",
            ])

    def test_host_panels_gate_on_sampler_freshness(self):
        dashboard = json.loads((MONITORING / "dashboards/ingestion.json").read_text())
        self.assertEqual(len({panel["id"] for panel in dashboard["panels"]}), len(dashboard["panels"]))
        for panel in dashboard["panels"]:
            for target in panel["targets"]:
                expression = target["expr"]
                if "recount_" in expression:
                    self.assertIn("time() - recount_ingestion_host_sample_timestamp_seconds < 45", expression)
