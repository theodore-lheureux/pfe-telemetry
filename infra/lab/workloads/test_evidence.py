import unittest

from export import summarize


def point(metric, value, timestamp, series, *, node="node-a", segment="segment-a", direction=None):
    attributes = [["/recount.counter.segment_id", segment]]
    if direction:
        attributes.append(["/disk.io.direction", direction])
    return {
        "source_id": node,
        "series_id": series,
        "metric_name": metric,
        "int_value": value,
        "double_value": None,
        "time_unix_nano": timestamp,
        "temporality": 2,
        "monotonic": 1,
        "scope_version": "0.1.0",
        "attributes": attributes,
    }


class EvidenceSummaryTests(unittest.TestCase):
    def test_counter_deltas_exclude_initial_values_and_do_not_bridge_segments(self):
        points = [
            point("process.cpu.time", 100, 1_000_000_000, "cpu"),
            point("process.cpu.time", 105, 2_000_000_000, "cpu"),
            point("process.cpu.time", 0, 3_000_000_000, "cpu", segment="segment-b"),
            point("process.cpu.time", 2, 4_000_000_000, "cpu", segment="segment-b"),
            point("process.disk.io", 4096, 1_000_000_000, "write", direction="write"),
            point("process.disk.io", 8192, 2_000_000_000, "write", direction="write"),
        ]
        summary = summarize(points)
        self.assertEqual(summary["sampled_counter_deltas"], {
            "process.cpu.time": 7, "process.disk.io:write": 4096,
        })
        self.assertEqual(summary["counter_sample_span_seconds_by_node"], {"node-a": 3})

    def test_memory_peak_sums_processes_per_node_and_scan_not_over_time(self):
        points = [
            point("recount.process.memory.rss", 100, 1, "a"),
            point("recount.process.memory.rss", 200, 1, "b"),
            point("recount.process.memory.rss", 250, 2, "a"),
            point("recount.process.memory.rss", 400, 1, "c", node="node-b"),
        ]
        self.assertEqual(summarize(points)["peak_process_rss_sum_bytes_by_node"], {
            "node-a": 300, "node-b": 400,
        })

    def test_invalid_counter_evidence_is_not_silently_summarized(self):
        decreasing = [
            point("process.cpu.time", 10, 1, "cpu"),
            point("process.cpu.time", 9, 2, "cpu"),
        ]
        with self.assertRaisesRegex(ValueError, "decreased"):
            summarize(decreasing)
        decreasing[0]["temporality"] = 1
        with self.assertRaisesRegex(ValueError, "cumulative"):
            summarize(decreasing)

    def test_clickhouse_quoted_integers_remain_exact(self):
        points = [
            point("process.disk.io", str(2**53), "1000000000", "write", direction="write"),
            point("process.disk.io", str(2**53 + 1), "2000000000", "write", direction="write"),
            point("recount.process.memory.rss", "123", "1000000000", "rss"),
        ]
        summary = summarize(points)
        self.assertEqual(summary["sampled_counter_deltas"]["process.disk.io:write"], 1)
        self.assertEqual(summary["peak_process_rss_sum_bytes_by_node"], {"node-a": 123})


if __name__ == "__main__":
    unittest.main()
