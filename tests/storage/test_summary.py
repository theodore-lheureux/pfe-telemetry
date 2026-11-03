import unittest

from summarize import byte_size, distribution, summarize


class SummaryTests(unittest.TestCase):
    def test_units_and_nearest_rank(self):
        self.assertIsNone(distribution([]))
        self.assertEqual(distribution([3, 1, 2]), {"n": 3, "p50": 2, "p95": 3, "p99": 3, "max": 3})
        self.assertEqual(byte_size("128MiB"), 134217728)
        self.assertEqual(byte_size("1.5MB"), 1500000)

    def test_prefill_is_excluded_and_failed_runs_are_rejected(self):
        events = [
            {"kind": "parameters"},
            {"kind": "ingestion", "scenario": "case", "time_ns": 1, "acks": [{"ack_ms": 999}]},
            {"kind": "phase_start", "scenario": "case", "time_ns": 2, "readers": 0, "write": True},
            {"kind": "ingestion", "scenario": "case", "time_ns": 3, "acks": [
                {"sequence": 1, "ack_ns": 1_000_000_000, "ack_ms": 1},
                {"sequence": 2, "ack_ns": 2_000_000_000, "ack_ms": 2},
            ]},
            {"kind": "query", "scenario": "case", "label": "freshness", "result": [{"latest": "2"}],
             "end_ns": 2_100_000_000, "elapsed_ms": 5, "engine_ms": 4, "failed": False},
            {"kind": "phase_end", "scenario": "case", "time_ns": 4},
            {"kind": "complete", "time_ns": 5},
        ]
        result = summarize(events)["scenarios"][0]
        self.assertEqual(result["accepted_rows"], 384)
        self.assertEqual(result["accepted_rows_per_s"], 192)
        self.assertEqual(result["ack_ms"]["max"], 2)
        self.assertEqual(result["sampled_latest_ack_to_observation_ms"]["p50"], 100)
        with self.assertRaises(AssertionError):
            summarize(events[:-1])
