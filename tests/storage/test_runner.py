import io
import unittest
from unittest.mock import MagicMock, Mock, patch

from run import Reader


class ReaderTests(unittest.TestCase):
    def test_sql_failure_is_logged_and_stops_workload(self):
        reader = Reader.__new__(Reader)
        reader.experiment = Mock(origin=0, project="test")
        reader.name, reader.label = "test-reader", "reader"
        reader.errors = Mock(name="stderr")
        reader.process = Mock(stdin=io.StringIO(), stdout=io.StringIO("__DONE__\n"))
        stop = Mock()
        stop.is_set.return_value = False

        with self.assertRaisesRegex(RuntimeError, "Query failed: test-reader"):
            reader.workload(stop, 10)

        self.assertTrue(reader.experiment.event.call_args.kwargs["failed"])
        self.assertEqual(reader.experiment.event.call_args.kwargs["label"], "range")

    def test_failed_startup_closes_reader(self):
        experiment = Mock()
        experiment.output = MagicMock()
        experiment.project = "test"
        experiment.compose.return_value = ["docker"]
        with patch("run.subprocess.Popen"), patch.object(Reader, "query", side_effect=RuntimeError("SQL error")), patch.object(Reader, "close") as close:
            with self.assertRaisesRegex(RuntimeError, "SQL error"):
                Reader(experiment, "reader")
        close.assert_called_once()
