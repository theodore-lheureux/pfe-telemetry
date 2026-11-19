"""Validate public inventory, state identities and create-only plans."""

import datetime as dt
import ipaddress
import re
import uuid

from ansible.errors import AnsibleFilterError

OWNER = "recount-demo-semaphore"
TTLS = {900, 1800, 3600, 7200, 14400}


def require(condition, message):
    if not condition:
        raise AnsibleFilterError(message)


def selected_lab(lab, action):
    if not lab and action == "create":
        return "demo-" + uuid.uuid4().hex[:16]
    if action != "list":
        require(re.fullmatch(r"[a-z][a-z0-9-]{0,23}", lab or ""), "An existing valid lab ID is required")
    return lab


def lab_name(name, lab, cloud):
    require(re.fullmatch(r"[a-z][a-z0-9-]{0,23}", lab or ""), "Invalid lab ID")
    suffix = r"[0-9]{3}" if cloud == "aws-cpu" else r"01"
    require(re.fullmatch("demo-" + re.escape(lab) + "-" + suffix, name or ""), "Invalid lab instance name")
    if cloud == "aws-cpu":
        require(1 <= int(name.rsplit("-", 1)[-1]) <= 200, "CPU ordinal exceeds its limit")


def instant(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def owned_gcp(items, config):
    result = []
    for item in items:
        labels = item.get("labels", {})
        lab = labels.get("recount-lab")
        lab_name(item.get("name"), lab, "gcp-gpu")
        require(labels.get("recount-owner") == OWNER and labels.get("recount-demo") == "true" and
                labels.get("recount-kind") == "gpu" and labels.get("recount-preset") == "gpu-l4",
                "Unrecognized GPU ownership")
        zone = item["zone"].rsplit("/", 1)[-1]
        require("/projects/recount-cloud/zones/" in item["selfLink"] and zone == config["zones"]["gpu"] and
                item["machineType"].endswith("/g2-standard-4"), "Wrong GPU project, zone or shape")
        scheduling = item["scheduling"]
        ttl = int(labels.get("recount-ttl", "0"))
        require(ttl in TTLS and int(scheduling.get("maxRunDuration", {}).get("seconds", 0)) == ttl and
                scheduling.get("provisioningModel") == "SPOT" and
                scheduling.get("instanceTerminationAction") == "DELETE" and
                not scheduling.get("automaticRestart", True), "GPU expiry is not bounded Spot deletion")
        require(not item.get("serviceAccounts") and item.get("tags", {}).get("items") == ["recount-demo"],
                "Unexpected GPU service account or network tag")
        region = zone.rsplit("-", 1)[0]
        network = item["networkInterfaces"]
        require(len(network) == 1 and
                network[0]["network"].endswith("/projects/recount-cloud/global/networks/recount-demo") and
                network[0]["subnetwork"].endswith(
                    f"/projects/recount-cloud/regions/{region}/subnetworks/{config['subnets'][region]}"),
                "GPU is outside the demo network")
        disks = item["disks"]
        accelerators = item.get("guestAccelerators", [])
        require(len(disks) == 1 and disks[0].get("boot") and disks[0].get("autoDelete") and
                str(disks[0].get("diskSizeGb")) == "60", "Unexpected GPU disk")
        require(len(accelerators) == 1 and accelerators[0]["acceleratorCount"] == 1 and
                accelerators[0]["acceleratorType"].endswith("/nvidia-l4"), "Unexpected GPU accelerator")
        expires = scheduling.get("terminationTimestamp")
        if expires is None:
            started = instant(item.get("lastStartTimestamp", item["creationTimestamp"]))
            expires = (started + dt.timedelta(seconds=ttl)).isoformat()
        address = network[0]["accessConfigs"][0]["natIP"]
        require(ipaddress.ip_address(address).version == 4, "Expected a public IPv4 GPU address")
        result.append({"name": item["name"], "lab_id": lab, "cloud": "gcp-gpu", "kind": "gpu",
                       "instance_id": str(item["id"]), "zone": zone, "preset": "gpu-l4",
                       "ttl_seconds": ttl, "expires": expires, "status": item["status"],
                       "address": address})
    return result


def owned_aws(items, config):
    result = []
    aws = config["aws"]
    for item in items:
        tags = item.get("tags", {})
        lab_name(tags.get("Name"), tags.get("recount-lab"), "aws-cpu")
        require(tags.get("component") == "demo" and tags.get("recount-owner") == OWNER and
                tags.get("recount-kind") == "cpu" and tags.get("recount-preset") == "t4g-nano",
                "Unrecognized CPU ownership")
        require(item["instance_type"] == "t4g.nano" and item["architecture"] == "arm64" and
                not item.get("instance_lifecycle") and not item.get("key_name"),
                "CPU must be an ARM64 t4g.nano on-demand instance without an SSH key")
        require(re.fullmatch(r"i-[a-f0-9]{8,17}", item["instance_id"]), "Invalid CPU instance ID")
        require(item["vpc_id"] == aws["vpc_id"] and item["subnet_id"] == aws["subnet_id"] and
                sorted(group["group_id"] for group in item["security_groups"]) == [aws["security_group_id"]],
                "CPU is outside the demo network")
        expected = f"arn:aws:iam::{aws['account_id']}:instance-profile/{aws['instance_profile']}"
        require(item.get("iam_instance_profile", {}).get("arn") == expected, "Unexpected CPU instance profile")
        ttl = int(tags.get("recount-ttl", "0"))
        require(ttl in TTLS and instant(tags["recount-expires"]).tzinfo is not None, "Missing CPU expiry")
        disks = item.get("block_device_mappings", [])
        require(len(disks) == 1 and disks[0]["ebs"]["delete_on_termination"], "CPU disk must auto-delete")
        result.append({"name": tags["Name"], "lab_id": tags["recount-lab"], "cloud": "aws-cpu",
                       "kind": "cpu", "instance_id": item["instance_id"], "preset": "t4g-nano",
                       "ttl_seconds": ttl, "expires": tags["recount-expires"],
                       "status": item["state"]["name"], "region": aws["region"]})
    return result


def lab_state(state, lab, config, cloud):
    root = state.get("values", {}).get("root_module", {})
    require(not root.get("child_modules"), "Unexpected state module")
    result = []
    allowed_data = {"aws_ami", "aws_subnet", "aws_security_group"} if cloud == "aws-cpu" else {"google_compute_image"}
    for resource in root.get("resources", []):
        if resource.get("mode") == "data":
            require(resource["type"] in allowed_data, "Unexpected state data source")
            continue
        value = resource.get("values", {})
        expected_type = "aws_instance" if cloud == "aws-cpu" else "google_compute_instance"
        require(resource["type"] == expected_type and resource["name"] == "collector", "Unrelated managed resource")
        tags = value.get("tags", {}) if cloud == "aws-cpu" else value.get("labels", {})
        name = tags.get("Name") if cloud == "aws-cpu" else value.get("name")
        lab_name(name, lab, cloud)
        require(tags.get("recount-owner") == OWNER and tags.get("recount-lab") == lab, "Wrong state ownership")
        if cloud == "aws-cpu":
            aws = config["aws"]
            require(re.fullmatch(r"i-[a-f0-9]{8,17}", value.get("id", "")) and
                    value.get("arn") == f"arn:aws:ec2:{aws['region']}:{aws['account_id']}:instance/{value['id']}" and
                    value.get("instance_type") == "t4g.nano" and value.get("subnet_id") == aws["subnet_id"] and
                    value.get("iam_instance_profile") == aws["instance_profile"], "Wrong CPU state identity")
            identity = value["id"]
            preset = "t4g-nano"
        else:
            require(value.get("project") == "recount-cloud" and value.get("zone") == config["zones"]["gpu"] and
                    value.get("id") == f"projects/recount-cloud/zones/{value['zone']}/instances/{name}" and
                    not value.get("service_account") and value.get("machine_type") == "g2-standard-4",
                    "Wrong GPU state identity")
            identity = str(value["instance_id"])
            preset = "gpu-l4"
        ttl = int(tags.get("recount-ttl", "0"))
        require(ttl in TTLS, "State TTL is outside the limits")
        result.append({"name": name, "lab_id": lab, "cloud": cloud, "kind": "cpu" if cloud == "aws-cpu" else "gpu",
                       "instance_id": identity, "preset": preset, "ttl_seconds": ttl})
    require(len(result) <= (200 if cloud == "aws-cpu" else 1), "State exceeds the fleet limit")
    return result


def published_release(releases, architecture):
    require(architecture in {"arm64", "amd64"}, "Unsupported collector architecture")
    archive = f"recount-collector-{architecture}.tar.gz"
    for release in sorted(releases, key=lambda item: item.get("published_at", ""), reverse=True):
        if release.get("draft") or not re.fullmatch(
                r"release-[a-f0-9]{40}-[0-9]+-[0-9]+", release.get("tag_name", "")):
            continue
        assets = {asset["name"] for asset in release.get("assets", [])}
        if {archive, archive + ".sha256"} <= assets:
            return release
    raise AnsibleFilterError("No published runtime build contains the collector archive and checksum")


def create_plan(plan, cloud):
    expected = "aws_instance" if cloud == "aws-cpu" else "google_compute_instance"
    managed = [item for item in plan.get("resource_changes", []) if item.get("mode") != "data"]
    require(1 <= len(managed) <= (200 if cloud == "aws-cpu" else 1), "Invalid create count")
    require(all(item["type"] == expected and item["name"] == "collector" and
                item["change"]["actions"] == ["create"] for item in managed), "Plan must only create new collectors")
    return True


def accounted(live, state, lab, cloud, absent_ok=False):
    selected = [item for item in live if item["lab_id"] == lab and item["cloud"] == cloud]
    expected = {(item["name"], item["instance_id"]) for item in state}
    actual = {(item["name"], item["instance_id"]) for item in selected}
    require(actual <= expected, "A live lab VM is missing from state or has a replacement identity")
    require(absent_ok or actual == expected, "A lab VM is absent; no operation will recreate it")
    return selected


def listing(items):
    now = dt.datetime.now(dt.timezone.utc)
    return [{**item, "minutes_left": max(0, int((instant(item["expires"]) - now).total_seconds()) // 60)}
            for item in items] or "No temporary collectors"


class FilterModule:
    def filters(self):
        return {"demo_owned_gcp": owned_gcp, "demo_owned_aws": owned_aws, "demo_lab_state": lab_state,
                "demo_create_plan": create_plan, "demo_accounted": accounted, "demo_listing": listing,
                "demo_published_release": published_release, "demo_selected_lab": selected_lab}
