"""Terminate expired, explicitly owned temporary CPU instances."""

import datetime as dt
import json
import os
import re


def expired(instance, now, config):
    tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
    lab = tags.get("recount-lab", "")
    if not (
        tags.get("component") == "demo"
        and tags.get("recount-owner") == "recount-demo-semaphore"
        and tags.get("recount-kind") == "cpu"
        and tags.get("recount-preset") == "t4g-nano"
        and re.fullmatch(r"[a-z][a-z0-9-]{0,23}", lab)
        and re.fullmatch(r"demo-" + re.escape(lab) + r"-[0-9]{3}", tags.get("Name", ""))
        and instance.get("InstanceType") == "t4g.nano"
        and instance.get("Architecture") == "arm64"
        and not instance.get("InstanceLifecycle")
        and not instance.get("KeyName")
        and 1 <= int(tags["Name"].rsplit("-", 1)[-1]) <= 200
        and instance.get("VpcId") == config["vpc"]
        and instance.get("SubnetId") == config["subnet"]
        and sorted(group["GroupId"] for group in instance.get("SecurityGroups", [])) == [config["security_group"]]
        and instance.get("IamInstanceProfile", {}).get("Arn") == config["profile_arn"]
        and len(instance.get("BlockDeviceMappings", [])) == 1
        and instance["BlockDeviceMappings"][0]["Ebs"]["DeleteOnTermination"]
    ):
        return False
    try:
        ttl = int(tags["recount-ttl"])
        deadline = dt.datetime.fromisoformat(tags["recount-expires"].replace("Z", "+00:00"))
        launched = instance["LaunchTime"]
        if ttl not in {900, 1800, 3600, 7200, 14400} or deadline.tzinfo is None:
            return False
        return now >= min(deadline, launched + dt.timedelta(hours=4))
    except (KeyError, TypeError, ValueError):
        return False


def handler(event, context):
    import boto3

    account = context.invoked_function_arn.split(":")[4]
    config = {
        "vpc": os.environ["DEMO_VPC_ID"],
        "subnet": os.environ["DEMO_SUBNET_ID"],
        "security_group": os.environ["DEMO_SECURITY_GROUP_ID"],
        "profile_arn": f"arn:aws:iam::{account}:instance-profile/{os.environ['DEMO_INSTANCE_PROFILE']}",
    }
    client = boto3.client("ec2")
    now = dt.datetime.now(dt.timezone.utc)
    ids = []
    for page in client.get_paginator("describe_instances").paginate(Filters=[
        {"Name": "tag:component", "Values": ["demo"]},
        {"Name": "tag:recount-owner", "Values": ["recount-demo-semaphore"]},
        {"Name": "instance-type", "Values": ["t4g.nano"]},
        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
    ]):
        for reservation in page["Reservations"]:
            if reservation["OwnerId"] != account:
                continue
            ids.extend(item["InstanceId"] for item in reservation["Instances"] if expired(item, now, config))
    if ids:
        client.terminate_instances(InstanceIds=ids)
    print(json.dumps({"expired_instance_ids": ids}))
    return {"terminated": len(ids)}
