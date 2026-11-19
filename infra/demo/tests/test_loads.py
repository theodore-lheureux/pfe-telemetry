import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from jinja2 import Environment, StrictUndefined

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "files"))
spec = importlib.util.spec_from_file_location("cpu_load", ROOT / "files/cpu_load.py")
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)
loads = sys.modules["recount_demo_load"]


class DistributedCpuTests(unittest.TestCase):
    def test_shards_reduce_to_the_same_result_as_one_contiguous_job(self):
        seed = bytes.fromhex("0123456789abcdef0123456789abcdef")
        for profile in cpu.PROFILES:
            with self.subTest(profile=profile):
                serial = cpu.combine(profile, [cpu.batch(profile, block, seed, 32) for block in range(12)])
                distributed = []
                for shard in range(3):
                    partials = [cpu.batch(profile, shard + step * 3, seed, 32) for step in range(4)]
                    distributed.append(cpu.combine(profile, partials))
                self.assertEqual(serial, cpu.combine(profile, distributed))

    def test_prime_work_has_a_checked_mathematical_result(self):
        value = cpu.batch("cpu-primes", 0, b"seed", 29)
        self.assertEqual(value["matches"], 10)
        self.assertEqual(value["checksum"], 129)

    def test_expired_job_does_no_work(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            subprocess.run([
                sys.executable, str(ROOT / "files/cpu_load.py"),
                "--profile", "cpu-pi", "--job", "load-" + "a" * 32,
                "--shard", "0", "--shards", "3", "--duration", "1",
                "--expires", str(time.time() - 1), "--output", str(output),
            ], check=True, timeout=5)
            value = json.loads(output.read_text())
            self.assertEqual(value["state"], "expired")
            self.assertEqual(value["operations"], 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_out_of_range_shard_is_rejected_before_starting(self):
        with self.assertRaises(ValueError):
            cpu.run("cpu-hash", "load-" + "a" * 32, 3, 3, 60, time.time() + 120, Path("unused"))

    def test_each_cpu_profile_finishes_with_bounded_runtime_and_a_checkpoint(self):
        for profile in cpu.PROFILES:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "result.json"
                subprocess.run([
                    sys.executable, str(ROOT / "files/cpu_load.py"),
                    "--profile", profile, "--job", "load-" + "b" * 32,
                    "--shard", "0", "--shards", "2", "--duration", "1",
                    "--expires", str(time.time() + 10), "--output", str(output),
                ], check=True, timeout=5)
                result = json.loads(output.read_text())
                self.assertEqual(result["state"], "completed")
                self.assertGreater(result["operations"], 0)
                self.assertLess(result["elapsed_seconds"], 3)

    def test_stop_preserves_partial_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            process = subprocess.Popen([
                sys.executable, str(ROOT / "files/cpu_load.py"),
                "--profile", "cpu-hash", "--job", "load-" + "c" * 32,
                "--shard", "0", "--shards", "2", "--duration", "10",
                "--expires", str(time.time() + 20), "--output", str(output),
            ])
            try:
                deadline = time.monotonic() + 5
                while not output.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(output.exists())
                process.terminate()
                self.assertEqual(process.wait(timeout=5), 0)
                value = json.loads(output.read_text())
                self.assertEqual(value["state"], "stopped")
                self.assertGreater(value["operations"], 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


class LoadContractTests(unittest.TestCase):
    project = "11111111-1111-1111-1111-111111111111"

    def nodes(self):
        return [{
            "name": f"demo-lab-{ordinal:03}", "instance_id": "i-" + str(ordinal) * 17,
            "lab_id": "lab", "cloud": "aws-cpu",
            "expires": dt.datetime.fromtimestamp(time.time() + 600, dt.timezone.utc).isoformat(),
        } for ordinal in [1, 2]]

    def job(self):
        return loads.plan(self.nodes(), "lab", self.project, "aws-cpu", "cpu-primes", "120")

    def reports(self, job):
        return [{"name": node["name"], "active": False, "result": {
            "job_id": job["job_id"], "profile": job["profile"],
            "shard": node["shard"], "shards": 2, "state": "completed",
            "operations": 100, "matches": 20, "checksum": "42", "elapsed_seconds": 120,
        }} for node in job["nodes"]]

    def test_plans_assign_stable_disjoint_shards_and_never_extend_vm_expiry(self):
        nodes = self.nodes()[::-1]
        nodes[0]["expires"] = dt.datetime.fromtimestamp(time.time() + 90, dt.timezone.utc).isoformat()
        job = loads.plan(nodes, "lab", self.project, "aws-cpu", "cpu-pi", "300")
        self.assertEqual([node["name"] for node in job["nodes"]], sorted(node["name"] for node in nodes))
        self.assertEqual([node["shard"] for node in job["nodes"]], [0, 1])
        self.assertLessEqual(job["duration_seconds"], 75)
        self.assertRegex(job["job_id"], r"^load-[a-f0-9]{32}$")
        for bad in ["0", "301", "1; true", "3000"]:
            with self.subTest(duration=bad), self.assertRaises(ValueError):
                loads.plan(nodes, "lab", self.project, "aws-cpu", "cpu-pi", bad)
        with self.assertRaises(ValueError):
            loads.plan(nodes[:1], "lab", self.project, "aws-cpu", "cpu-pi", "60")
        with self.assertRaises(ValueError):
            loads.plan(nodes, "other", self.project, "aws-cpu", "cpu-pi", "60")

    def test_results_are_reduced_but_unrelated_or_malformed_data_is_rejected(self):
        job = self.job()
        reports = self.reports(job)
        result = loads.summary(job, reports)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["reduction"], {"operations": 200, "matches": 40, "checksum": "84"})
        for change in [{"job_id": "load-" + "d" * 32}, {"shard": 99},
                       {"operations": True}, {"matches": 101}, {"checksum": "secret"},
                       {"elapsed_seconds": float("nan")}, {"state": "ready"}]:
            altered = copy.deepcopy(reports)
            altered[0]["result"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                loads.summary(job, altered)
        self.assertNotEqual(loads.summary(job, reports[:1])["state"], "completed")
        reports[0]["result"]["unknown_secret"] = "must-not-be-returned"
        self.assertNotIn("must-not-be-returned", json.dumps(loads.summary(job, reports)))

    def test_services_have_independent_resource_and_lifetime_limits(self):
        template = Environment(undefined=StrictUndefined).from_string(
            (ROOT / "templates/workload.service.j2").read_text())
        for gpu in [False, True]:
            text = template.render(recount_gpu=gpu, recount_load_job=self.job(), recount_load_shard=0)
            self.assertIn("Restart=no", text)
            self.assertIn("RuntimeMaxSec=125", text)
            self.assertIn("KillMode=control-group", text)
            self.assertIn("MemoryMax=" + ("1G" if gpu else "64M"), text)
            self.assertIn("CPUQuota=" + ("100%" if gpu else "50%"), text)
            self.assertNotIn("DEMO_ENROLLMENT_KEY", text)
            self.assertIn("\nRestart=no", text)

    def test_numeric_annotations_preserve_counter_semantics_without_accepting_booleans(self):
        class AnnotatedInt(int):
            pass

        class AnnotatedFloat(float):
            pass

        job = self.job()
        reports = self.reports(job)
        reports[0]["result"].update(
            operations=AnnotatedInt(100), matches=AnnotatedInt(20),
            elapsed_seconds=AnnotatedFloat(120),
        )
        self.assertEqual(loads.summary(job, reports)["reduction"]["operations"], 200)
        reports[0]["result"]["elapsed_seconds"] = True
        with self.assertRaises(ValueError):
            loads.summary(job, reports)

class GpuWorkerTests(unittest.TestCase):
    def test_deadline_termination_is_never_reported_as_completed_compute(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "dcgmproftester13"
            binary.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n")
            binary.chmod(0o700)
            output = root / "result.json"
            subprocess.run([
                sys.executable, str(ROOT / "files/gpu_load.py"),
                "--profile", "gpu-fp32", "--job", "load-" + "e" * 32,
                "--duration", "2", "--expires", str(time.time() + 10), "--output", str(output),
            ], env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                check=True, timeout=7)
            value = json.loads(output.read_text())
            self.assertEqual(value["state"], "interrupted")
            self.assertEqual(value["completed_bursts"], 0)
            self.assertNotEqual(value["exit_code"], 0)
            job = {
                "job_id": value["job_id"], "profile": "gpu-fp32", "project_id": LoadContractTests.project,
                "lab_id": "lab", "cloud": "gcp-gpu", "duration_seconds": 2,
                "nodes": [{"name": "demo-lab-01", "shard": 0}],
            }
            result = loads.summary(job, [{"name": "demo-lab-01", "active": False, "result": value}])
            self.assertEqual(result["state"], "partial")

    def test_selected_profiles_use_the_corresponding_fixed_dcgm_pipe(self):
        for profile, field in [("gpu-fp32", "1007"), ("gpu-tensor", "1004"), ("gpu-memory", "1005")]:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binary = root / "dcgmproftester13"
                binary.write_text("#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
                binary.chmod(0o700)
                output = root / "result.json"
                subprocess.run([
                    sys.executable, str(ROOT / "files/gpu_load.py"),
                    "--profile", profile, "--job", "load-" + "e" * 32,
                    "--duration", "2", "--expires", str(time.time() + 10), "--output", str(output),
                ], env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]},
                    check=True, timeout=6)
                result = json.loads(output.read_text())
                self.assertEqual(result["state"], "completed")
                self.assertGreater(result["completed_bursts"], 0)
                argv = json.loads(output.with_suffix(".dcgm.log").read_text().splitlines()[0])
                self.assertEqual(argv[argv.index("-t") + 1], field)
                self.assertIn("--no-dcgm-validation", argv)

    def test_expired_gpu_job_does_not_require_or_start_a_gpu_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            subprocess.run([
                sys.executable, str(ROOT / "files/gpu_load.py"),
                "--profile", "gpu-mixed", "--job", "load-" + "f" * 32,
                "--duration", "60", "--expires", str(time.time() - 1), "--output", str(output),
            ], check=True, timeout=5)
            result = json.loads(output.read_text())
            self.assertEqual(result["state"], "expired")
            self.assertEqual(result["completed_bursts"], 0)


if __name__ == "__main__":
    unittest.main()
