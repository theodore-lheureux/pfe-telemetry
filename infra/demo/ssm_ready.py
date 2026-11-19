"""Check the selected node's connection and configured startup agent update."""

import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionError, HTTPClientError


def ready(connection, associations, document):
    if connection != "connected":
        return False
    if not document:
        return True
    updates = [item for item in associations if item.get("Name") == document]
    return bool(updates) and all(
        item.get("Status") == "Success" and item.get("ExecutionDate") is not None
        for item in updates
    )


def probe(client, instance, document):
    connection = client.get_connection_status(Target=instance)["Status"]
    associations = []
    if document:
        for page in client.get_paginator("describe_instance_associations_status").paginate(InstanceId=instance):
            associations.extend(page.get("InstanceAssociationStatusInfos", []))
    return ready(connection, associations, document)


def wait_for_fleet(instances, check, *, timeout=180, delay=5):
    if not 1 <= len(instances) <= 200 or len(set(instances)) != len(instances):
        raise ValueError("Expected one to 200 unique AWS instances")
    if any(not re.fullmatch(r"i-[0-9a-f]{17}", instance) for instance in instances):
        raise ValueError("Invalid AWS instance ID")
    pending = list(instances)
    started = time.monotonic()
    reached = {}

    def timed_probe(instance):
        return round(time.monotonic() - started, 2) if check(instance) else None

    with ThreadPoolExecutor(max_workers=min(12, len(pending))) as pool:
        while pending:
            for instance, seconds in zip(pending, pool.map(timed_probe, pending), strict=True):
                if seconds is not None:
                    reached[instance] = seconds
            pending = [instance for instance in pending if instance not in reached]
            remaining = timeout - (time.monotonic() - started)
            if pending and remaining <= 0:
                raise TimeoutError(f"SSM startup still pending on {len(pending)} of {len(instances)} instances")
            if pending:
                time.sleep(min(delay, remaining))
    return reached


def main():
    if sys.argv[1:2] != ["--fleet"]:
        instance, region, document = sys.argv[1:]
        client = boto3.Session(profile_name="recount-demo", region_name=region).client("ssm")
        if not probe(client, instance, document):
            raise SystemExit("Waiting for the selected node's SSM connection and startup update")
        print("SSM startup is ready")
        return
    _, region, document, *instances = sys.argv[1:]
    # Create the session and load its configuration before starting workers.
    client = boto3.Session(profile_name="recount-demo", region_name=region).client(
        "ssm", config=Config(connect_timeout=3, read_timeout=5, retries={"total_max_attempts": 2},
                            max_pool_connections=12))

    def check(instance):
        try:
            return probe(client, instance, document)
        except ClientError as error:
            if error.response["Error"]["Code"] not in (
                "Throttling", "ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded",
                "InvalidInstanceId", "TargetNotConnected", "InternalServerError",
            ):
                raise
            return False
        except (ConnectionError, HTTPClientError):
            return False

    results = wait_for_fleet(instances, check)
    print(f"SSM startup ready for {len(results)} collectors; first/last seconds "
          f"{min(results.values()):.2f}/{max(results.values()):.2f}")


if __name__ == "__main__":
    main()
