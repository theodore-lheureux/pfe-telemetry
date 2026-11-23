import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

MONITORING = Path(__file__).resolve().parents[1] / "deploy" / "monitoring"
spec = importlib.util.spec_from_file_location("heartbeats", MONITORING / "heartbeats.py")
heartbeats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heartbeats)


def scrape(*, brokers=1, missing=None, leader=1, lag=(0, 0, 0)):
    text = [f"kafka_brokers {brokers}"]
    for topic, count in heartbeats.TOPICS.items():
        for partition in range(count):
            if (topic, partition) != missing:
                text.append(f'kafka_topic_partition_leader{{partition="{partition}",topic="{topic}"}} {leader}')
    for partition, value in enumerate(lag):
        text.append('kafka_consumergroup_lag{consumergroup="recount-normalizer",'
                    f'partition="{partition}",topic="{heartbeats.RAW}"}} {value}')
    return heartbeats.kafka_metrics("\n".join(text))


class HeartbeatsTest(unittest.TestCase):
    def test_kafka_requires_broker_and_every_partition_leader(self):
        live = dict.fromkeys(range(8), 1)
        with patch.object(heartbeats, "live_offsets", return_value=live):
            self.assertTrue(heartbeats.kafka_healthy(scrape()))
            self.assertFalse(heartbeats.kafka_healthy(scrape(brokers=0)))
            self.assertFalse(heartbeats.kafka_healthy(scrape(missing=(heartbeats.RAW, 1))))
            self.assertFalse(heartbeats.kafka_healthy(scrape(leader=-1)))
            del live[7]
            self.assertFalse(heartbeats.kafka_healthy(scrape()))

    def test_normalizers_require_three_replicas_and_known_bounded_total_lag(self):
        with patch.object(heartbeats, "command", return_value=b"a\nb\nc") as command:
            self.assertTrue(heartbeats.normalizers_healthy(scrape(lag=(333, 333, 333))))
            self.assertFalse(heartbeats.normalizers_healthy(scrape(lag=(334, 333, 333))))
            self.assertFalse(heartbeats.normalizers_healthy(scrape(lag=(0, -1, 0))))
            self.assertFalse(heartbeats.normalizers_healthy(scrape(lag=(0, 0))))
            command.return_value = b"a\nc"
            self.assertFalse(heartbeats.normalizers_healthy(scrape()))

    def test_clickhouse_idle_is_healthy_but_missing_data_while_sending_is_not(self):
        with (patch.object(heartbeats, "clickhouse", return_value=b"1") as query,
              patch.object(heartbeats, "sources_sending", return_value=False) as active,
              patch.object(heartbeats, "fresh_data", return_value=False) as fresh):
            self.assertTrue(heartbeats.clickhouse_healthy())
            fresh.assert_not_called()
            active.return_value = True
            self.assertFalse(heartbeats.clickhouse_healthy())
            fresh.return_value = True
            self.assertTrue(heartbeats.clickhouse_healthy())
            query.return_value = b""
            self.assertFalse(heartbeats.clickhouse_healthy())

    def test_pipeline_requires_grpc_serving_and_fresh_data(self):
        head = b"HTTP/2 200 \r\ncontent-type: application/grpc\r\n\r\n"
        serving = b"\x00\x00\x00\x00\x02\x08\x01"
        ok = b"grpc-status: 0\r\n"
        with (patch.object(heartbeats, "command", return_value=head + serving + ok) as curl,
              patch.object(heartbeats, "fresh_data", return_value=True) as fresh):
            self.assertTrue(heartbeats.pipeline_healthy())
            self.assertIn("ingest.recount.cloud:443:127.0.0.1", curl.call_args.args)
            fresh.return_value = False
            self.assertFalse(heartbeats.pipeline_healthy())
            fresh.return_value = True
            for data in (head + serving, head + serving + b"grpc-status: 13",
                         head + serving[:-1] + b"\x02" + ok, head + ok):
                curl.return_value = data
                self.assertFalse(heartbeats.pipeline_healthy())

    def test_withholds_ping_and_does_not_log_secrets(self):
        send = Mock(side_effect=OSError("fixture-secret"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            heartbeats.run({"failed": lambda: False, "healthy": lambda: True},
                           {"failed": "/other-secret", "healthy": "/fixture-secret"}, send)
        send.assert_called_once_with("/fixture-secret")
        self.assertEqual(output.getvalue(), "failed: unhealthy; ping withheld\nhealthy: ping failed\n")

    def test_secret_validation_and_redirect_refusal(self):
        fixture = "".join(f"RECOUNT_HEARTBEAT_{name}=https://incidents.betterstack.com"
                          f"/api/v1/heartbeat/fixture-{name}\n" for name in heartbeats.TARGETS)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "heartbeats.env"
            path.write_text(fixture)
            self.assertEqual(set(heartbeats.secrets(path, check_permissions=False)), set(heartbeats.TARGETS))
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                heartbeats.secrets(path)
            path.write_text(fixture.replace("incidents.betterstack.com", "example.com"))
            with self.assertRaises(ValueError):
                heartbeats.secrets(path, check_permissions=False)
        with patch.object(heartbeats.http.client, "HTTPSConnection") as https:
            connection = https.return_value
            connection.getresponse.return_value.status = 302
            self.assertFalse(heartbeats.ping("/api/v1/heartbeat/fixture"))
            connection.request.assert_called_once_with("GET", "/api/v1/heartbeat/fixture")
