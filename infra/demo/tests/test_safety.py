import copy
import datetime as dt
import importlib.util
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from jinja2 import Environment
import yaml

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load("scope", ROOT / "filter_plugins/demo.py")
drain = load("drain", ROOT / "drain.py")
expiry = load("expiry", ROOT / "expiry/aws/handler.py")
ssm = load("ssm_ready", ROOT / "ssm_ready.py")
CONFIG = {
    "zones": {"gpu": "us-central1-a"},
    "subnets": {"us-central1": "recount-demo-us-central1"},
    "aws": {"account_id": "123456789012", "region": "us-east-2", "vpc_id": "vpc-1234",
            "subnet_id": "subnet-1234", "security_group_id": "sg-1234",
            "instance_profile": "recount-demo-nodes"},
}


def aws_instance():
    return {
        "instance_id": "i-0123456789abcdef0", "instance_type": "t4g.nano", "architecture": "arm64",
        "vpc_id": "vpc-1234", "subnet_id": "subnet-1234",
        "security_groups": [{"group_id": "sg-1234"}],
        "iam_instance_profile": {"arn": "arn:aws:iam::123456789012:instance-profile/recount-demo-nodes"},
        "block_device_mappings": [{"ebs": {"delete_on_termination": True}}],
        "state": {"name": "running"},
        "tags": {"Name": "demo-lab-001", "component": "demo", "recount-owner": scope.OWNER,
                 "recount-lab": "lab", "recount-kind": "cpu", "recount-preset": "t4g-nano",
                 "recount-ttl": "7200", "recount-expires": "2026-11-17T14:00:00Z"},
    }


def gpu_instance():
    base = "https://www.googleapis.com/compute/v1/projects/recount-cloud"
    return {
        "id": "1234", "name": "demo-gpu-01", "selfLink": base + "/zones/us-central1-a/instances/demo-gpu-01",
        "zone": base + "/zones/us-central1-a", "machineType": base + "/zones/us-central1-a/machineTypes/g2-standard-4",
        "status": "RUNNING", "creationTimestamp": "2026-11-17T12:00:00Z",
        "lastStartTimestamp": "2026-11-17T12:10:00Z",
        "labels": {"recount-owner": scope.OWNER, "recount-demo": "true", "recount-kind": "gpu",
                   "recount-preset": "gpu-l4", "recount-lab": "gpu", "recount-ttl": "7200"},
        "scheduling": {"provisioningModel": "SPOT", "instanceTerminationAction": "DELETE",
                       "automaticRestart": False, "maxRunDuration": {"seconds": "7200"}},
        "tags": {"items": ["recount-demo"]},
        "networkInterfaces": [{"network": base + "/global/networks/recount-demo",
                               "subnetwork": base + "/regions/us-central1/subnetworks/recount-demo-us-central1",
                               "accessConfigs": [{"natIP": "203.0.113.1"}]}],
        "disks": [{"boot": True, "autoDelete": True, "diskSizeGb": "60"}],
        "guestAccelerators": [{"acceleratorCount": 1, "acceleratorType": "acceleratorTypes/nvidia-l4"}],
    }


class ScopeTests(unittest.TestCase):
    def test_only_creation_generates_a_missing_lab_id(self):
        first = scope.selected_lab("", "create")
        second = scope.selected_lab("", "create")
        self.assertRegex(first, r"^demo-[a-f0-9]{16}$")
        self.assertNotEqual(first, second)
        self.assertLessEqual(len(first), 24)
        self.assertEqual(scope.selected_lab("my-demo", "create"), "my-demo")
        self.assertEqual(scope.selected_lab("my-demo", "destroy"), "my-demo")
        for action in ["configure", "move", "destroy"]:
            with self.subTest(action=action), self.assertRaises(Exception):
                scope.selected_lab("", action)
        for value in ["../another-lab", " ", "Uppercase", "a" * 25]:
            with self.subTest(value=value), self.assertRaises(Exception):
                scope.selected_lab(value, "create")

    def test_create_form_allows_generated_ids_but_existing_actions_require_them(self):
        tasks = yaml.safe_load((ROOT.parent / "semaphore/tasks/bootstrap-template.yml").read_text())
        expression = tasks[0]["ansible.builtin.set_fact"]["semaphore_surveys"].strip()[2:-2]
        evaluate = Environment().compile_expression(expression)
        for action in ["create", "configure", "move", "destroy"]:
            survey = evaluate(semaphore_template={"action": action}, semaphore_lab_title="Lab ID")
            self.assertEqual(survey[0]["required"], action != "create")

    def test_ssm_startup_requires_connection_and_completed_configured_update(self):
        update = {"Name": "AWS-UpdateSSMAgent", "Status": "Success", "ExecutionDate": "now"}
        self.assertTrue(ssm.ready("connected", [update], "AWS-UpdateSSMAgent"))
        self.assertTrue(ssm.ready("connected", [], ""))
        self.assertFalse(ssm.ready("notconnected", [update], "AWS-UpdateSSMAgent"))
        self.assertFalse(ssm.ready("connected", [], "AWS-UpdateSSMAgent"))
        for change in [{"Status": "Pending"}, {"Status": "InProgress"},
                       {"Status": "Failed"}, {"ExecutionDate": None}]:
            with self.subTest(change=change):
                self.assertFalse(ssm.ready("connected", [{**update, **change}], "AWS-UpdateSSMAgent"))

    def test_fleet_readiness_rechecks_only_pending_nodes(self):
        first, second = "i-00000000000000001", "i-00000000000000002"
        calls = {first: 0, second: 0}

        def check(instance):
            calls[instance] += 1
            return instance == first or calls[instance] == 2

        self.assertEqual(set(ssm.wait_for_fleet([first, second], check, delay=0)), set(calls))
        self.assertEqual(calls, {first: 1, second: 2})
        with self.assertRaises(ValueError):
            ssm.wait_for_fleet([first, first], check)
        with self.assertRaises(TimeoutError):
            ssm.wait_for_fleet([first], lambda _: False, timeout=0)

    def test_cpu_inventory_is_scoped_by_identity_shape_network_profile_and_expiry(self):
        scope.owned_aws([aws_instance()], CONFIG)
        mutations = [
            lambda x: x["tags"].update(component="permanent"),
            lambda x: x["tags"].update({"Name": "permanent-collector"}),
            lambda x: x["tags"].update({"recount-owner": "other"}),
            lambda x: x["tags"].update({"recount-ttl": "18000"}),
            lambda x: x.update(instance_type="m8g.48xlarge"),
            lambda x: x.update(instance_lifecycle="spot"),
            lambda x: x.update(subnet_id="subnet-permanent"),
            lambda x: x.update(key_name="owner-key"),
            lambda x: x.update(iam_instance_profile={"arn": "permanent-profile"}),
            lambda x: x["block_device_mappings"][0]["ebs"].update(delete_on_termination=False),
        ]
        for mutate in mutations:
            value = aws_instance()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(Exception):
                scope.owned_aws([value], CONFIG)

    def test_gpu_scope_rejects_credentials_cost_and_network_changes(self):
        scope.owned_gcp([gpu_instance()], CONFIG)
        mutations = [
            lambda x: x.update(serviceAccounts=[{"email": "default"}]),
            lambda x: x["scheduling"].update(provisioningModel="STANDARD"),
            lambda x: x["scheduling"].update(instanceTerminationAction="STOP"),
            lambda x: x["scheduling"].update(maxRunDuration={"seconds": "18000"}),
            lambda x: x["networkInterfaces"][0].update(network="global/networks/default"),
            lambda x: x["disks"][0].update(autoDelete=False),
            lambda x: x["guestAccelerators"][0].update(acceleratorCount=2),
            lambda x: x.update(name="permanent-gpu"),
        ]
        for mutate in mutations:
            value = gpu_instance()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(Exception):
                scope.owned_gcp([value], CONFIG)

    def test_replacement_or_untracked_vm_blocks_destroy_even_with_absent_state_allowed(self):
        live = scope.owned_gcp([gpu_instance()], CONFIG)
        state = copy.deepcopy(live)
        scope.accounted(live, state, "gpu", "gcp-gpu", True)
        state[0]["instance_id"] = "old-id"
        with self.assertRaises(Exception):
            scope.accounted(live, state, "gpu", "gcp-gpu", True)
        with self.assertRaises(Exception):
            scope.accounted(live, [], "gpu", "gcp-gpu", True)
        self.assertEqual(scope.accounted([], state, "gpu", "gcp-gpu", True), [])
        with self.assertRaises(Exception):
            scope.accounted([], state, "gpu", "gcp-gpu")

    def test_only_create_actions_are_accepted(self):
        change = {"type": "aws_instance", "name": "collector", "change": {"actions": ["create"]}}
        self.assertTrue(scope.create_plan({"resource_changes": [change]}, "aws-cpu"))
        for actions in [["update"], ["delete"], ["delete", "create"], ["no-op"]]:
            with self.subTest(actions=actions), self.assertRaises(Exception):
                scope.create_plan({"resource_changes": [{**change, "change": {"actions": actions}}]}, "aws-cpu")
        with self.assertRaises(Exception):
            scope.create_plan({"resource_changes": [{**change, "type": "aws_iam_role"}]}, "aws-cpu")

    def test_published_runtime_prereleases_require_matching_assets(self):
        release = {
            "tag_name": "release-" + "a" * 40 + "-123-1",
            "draft": False, "prerelease": True,
            "assets": [{"name": "recount-collector-arm64.tar.gz"},
                       {"name": "recount-collector-arm64.tar.gz.sha256"}],
        }
        self.assertEqual(scope.published_release([release], "arm64"), release)
        older = {**release, "published_at": "2026-11-16T10:00:00Z"}
        newer = {**release, "tag_name": "release-" + "b" * 40 + "-124-1",
                 "published_at": "2026-11-17T10:00:00Z"}
        self.assertEqual(scope.published_release([older, newer], "arm64"), newer)
        for change in [{"draft": True}, {"tag_name": "unrelated"}, {"assets": []}]:
            with self.subTest(change=change), self.assertRaises(Exception):
                scope.published_release([{**release, **change}], "arm64")
        with self.assertRaises(Exception):
            scope.published_release([release], "amd64")

    def test_provenance_is_verified_before_create(self):
        controller = yaml.safe_load((ROOT / "tasks/controller.yml").read_text())
        tasks = next(task["block"] for task in controller if "block" in task)
        includes = [task.get("ansible.builtin.include_tasks") for task in tasks]
        self.assertLess(includes.index("release.yml"), includes.index("create.yml"))
        self.assertIn("--source-digest", (ROOT / "tasks/release.yml").read_text())

    def test_gpu_expiry_uses_last_start_not_nonexistent_termination_time(self):
        value = gpu_instance()
        value["scheduling"]["terminationTime"] = "wrong"
        self.assertEqual(scope.owned_gcp([value], CONFIG)[0]["expires"], "2026-11-17T14:10:00+00:00")

    def test_enrollment_secret_is_removed_from_tofu_process_environment(self):
        secret = "synthetic-enrollment-key"
        output = subprocess.check_output(
            ["env", "-u", "DEMO_ENROLLMENT_KEY", "python3", "-c",
             "import os; print('DEMO_ENROLLMENT_KEY' in os.environ)"],
            env={**os.environ, "DEMO_ENROLLMENT_KEY": secret}, text=True)
        self.assertEqual(output.strip(), "False")
        self.assertNotIn("DEMO_ENROLLMENT_KEY", (ROOT / "tofu/aws-cpu/variables.tf").read_text())
        self.assertNotIn("enrollment", (ROOT / "tofu/gcp-gpu/main.tf").read_text())

    def test_capacity_checks_use_normalized_mixed_inventory(self):
        tasks = yaml.safe_load((ROOT / "tasks/create.yml").read_text())
        assertions = next(task["ansible.builtin.assert"]["that"] for task in tasks
                          if "ansible.builtin.assert" in task)
        expression = next(value for value in assertions
                          if "selectattr('kind'" in value)
        environment = Environment()
        environment.globals["lookup"] = lambda *args: "2"
        evaluate = environment.compile_expression(expression)
        self.assertTrue(evaluate(demo_instances=[{"kind": "cpu"}, {"kind": "gpu"}], demo_kind="cpu",
                                 demo_config={"cpu_budget": 3}))
        self.assertFalse(evaluate(demo_instances=[{"kind": "cpu"}, {"kind": "cpu"}, {"kind": "gpu"}],
                                   demo_kind="cpu", demo_config={"cpu_budget": 3}))

    def test_new_lab_accepts_only_empty_state_without_history(self):
        tasks = yaml.safe_load((ROOT / "tasks/create.yml").read_text())
        assertions = next(task["ansible.builtin.assert"]["that"] for task in tasks
                          if "ansible.builtin.assert" in task)
        checks = [Environment().compile_expression(value) for value in assertions
                  if "demo_initial_state" in value]
        self.assertEqual(len(checks), 5)
        initial = {"version": 4, "serial": 0, "lineage": "", "outputs": {}, "resources": []}
        self.assertTrue(all(check(demo_initial_state=initial) for check in checks))
        for change in [{"resources": [{"type": "aws_instance"}]},
                       {"outputs": {"collectors": {"value": []}}},
                       {"serial": 1}, {"lineage": "previous-lab"}, {"version": 3}]:
            self.assertFalse(all(check(demo_initial_state={**initial, **change}) for check in checks))

    def test_dynamic_host_flags_are_not_shadowed_by_play_defaults(self):
        play = yaml.safe_load((ROOT / "collector.yml").read_text())[0]
        self.assertTrue({"recount_gpu", "recount_reenroll", "recount_discard_queue"}.isdisjoint(play["vars"]))


class DrainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "collector"
        self.state.mkdir()
        self.database = self.state / "queue.sqlite3"
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript(
                "CREATE TABLE batches (id INTEGER); INSERT INTO batches VALUES (1);"
                "CREATE TABLE losses (reason INTEGER, points INTEGER);"
                "CREATE TABLE participant_queue (id INTEGER);"
                "CREATE TABLE participant_rejections (id INTEGER);"
                "CREATE TABLE participant_facts (acknowledged INTEGER);")
        (self.state / "node.key").write_text("synthetic-old-project-identity")

    def change(self, sql):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript(sql)

    def test_success_removes_backup_after_delivery(self):
        drain.drain(self.state, lambda: self.change("DELETE FROM batches"))
        self.assertFalse(self.state.with_name("collector.move-backup").exists())

    def test_expiry_rejection_and_participant_loss_restore_the_old_queue(self):
        for sql in [
            "DELETE FROM batches; INSERT INTO losses VALUES (1,4);",
            "DELETE FROM batches; INSERT INTO participant_rejections VALUES (1);",
            "DELETE FROM batches; INSERT INTO participant_queue VALUES (1);",
            "DELETE FROM batches; INSERT INTO participant_facts VALUES (0);",
        ]:
            with self.subTest(sql=sql), self.assertRaisesRegex(RuntimeError, "Queue preserved"):
                drain.drain(self.state, lambda: self.change(sql))
            self.assertEqual(drain.metrics(self.state)["queue.sqlite3"], (1, 0, 0, 0, 0))
            self.assertEqual((self.state / "node.key").read_text(), "synthetic-old-project-identity")

    def test_unfinished_backup_blocks_blind_retry(self):
        self.state.with_name("collector.move-backup").mkdir()
        with self.assertRaisesRegex(RuntimeError, "requires reconciliation"):
            drain.drain(self.state, lambda: None)


class ExpiryTests(unittest.TestCase):
    def fixture(self):
        value = aws_instance()
        return {
            "InstanceType": value["instance_type"], "Architecture": value["architecture"],
            "SecurityGroups": [{"GroupId": "sg-1234"}],
            "BlockDeviceMappings": [{"Ebs": {"DeleteOnTermination": True}}],
            "VpcId": value["vpc_id"], "SubnetId": value["subnet_id"],
            "IamInstanceProfile": {"Arn": value["iam_instance_profile"]["arn"]},
            "LaunchTime": dt.datetime(2026, 11, 17, 12, tzinfo=dt.timezone.utc),
            "Tags": [{"Key": key, "Value": item} for key, item in value["tags"].items()],
        }

    def test_cleanup_only_expires_owned_cpu_ids(self):
        config = {"vpc": "vpc-1234", "subnet": "subnet-1234", "security_group": "sg-1234",
                  "profile_arn": "arn:aws:iam::123456789012:instance-profile/recount-demo-nodes"}
        now = dt.datetime(2026, 11, 17, 14, tzinfo=dt.timezone.utc)
        self.assertTrue(expiry.expired(self.fixture(), now, config))
        self.assertFalse(expiry.expired(self.fixture(), now - dt.timedelta(minutes=1), config))
        for field, value in [("InstanceType", "g2-standard-4"), ("SubnetId", "permanent"),
                             ("InstanceLifecycle", "spot"), ("KeyName", "owner-key"),
                             ("SecurityGroups", [{"GroupId": "sg-permanent"}]),
                             ("IamInstanceProfile", {"Arn": "permanent-profile"})]:
            item = self.fixture()
            item[field] = value
            self.assertFalse(expiry.expired(item, now, config))
        item = self.fixture()
        next(tag for tag in item["Tags"] if tag["Key"] == "component")["Value"] = "permanent"
        self.assertFalse(expiry.expired(item, now, config))


if __name__ == "__main__":
    unittest.main()
