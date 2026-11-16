import configparser
import unittest
from pathlib import Path


class CollectorServiceTests(unittest.TestCase):
    def test_transient_bootstrap_failures_do_not_exhaust_restart_budget(self):
        config = configparser.ConfigParser(interpolation=None, strict=False)
        config.optionxform = str
        config.read(Path(__file__).with_name("collector.service"))
        interval = int(config["Unit"]["StartLimitIntervalSec"])
        burst = int(config["Unit"]["StartLimitBurst"])
        restart = int(config["Service"]["RestartSec"])
        self.assertEqual(restart, 75)
        self.assertGreater((burst - 1) * restart, interval - 1)
