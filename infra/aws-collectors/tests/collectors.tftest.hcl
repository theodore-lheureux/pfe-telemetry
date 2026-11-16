mock_provider "aws" {
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-00000000000000000" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-00000000000000000", root_device_name = "/dev/sda1" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { id = "recount-collector-transfer-123456789012", arn = "arn:aws:s3:::recount-collector-transfer-123456789012" }
  }
}

variables {
  expected_account_id      = "123456789012"
  vpc_id                   = "vpc-synthetic"
  subnet_ids               = ["subnet-first", "subnet-second"]
  oracle_endpoint_verified = true
}

run "two_private_enrolled_arm_collectors" {
  command = plan
  assert {
    condition     = length(aws_instance.collector) == 2 && aws_launch_template.collectors.instance_type == "t4g.nano"
    error_message = "Allocate exactly two Graviton nano collectors."
  }
  assert {
    condition     = aws_launch_template.collectors.metadata_options[0].http_tokens == "required" && aws_launch_template.collectors.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDSv2 is mandatory with no container hop allowance."
  }
  assert {
    condition     = length(aws_security_group.collectors.ingress) == 0
    error_message = "Default collectors have no inbound network access."
  }
  assert {
    condition     = one(aws_launch_template.collectors.block_device_mappings).ebs[0].volume_size == 8 && one(aws_launch_template.collectors.block_device_mappings).ebs[0].encrypted
    error_message = "Root disks must be encrypted 8 GiB volumes."
  }
  assert {
    condition     = length(aws_launch_template.collectors.tag_specifications) == 3
    error_message = "Tag instances, root volumes and interfaces during launch."
  }
  assert {
    condition     = !strcontains(base64decode(aws_launch_template.collectors.user_data), "recount") && strcontains(base64decode(aws_launch_template.collectors.user_data), "amazon-ssm-agent")
    error_message = "Cloud-init must only prepare Systems Manager, never collector software or secrets."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.transfer.block_public_acls && aws_s3_bucket_public_access_block.transfer.block_public_policy && aws_s3_bucket_public_access_block.transfer.ignore_public_acls && aws_s3_bucket_public_access_block.transfer.restrict_public_buckets
    error_message = "Ansible transfers require a fully private bucket."
  }
  assert {
    condition     = aws_s3_bucket_versioning.transfer.versioning_configuration[0].status == "Disabled" && aws_s3_bucket_lifecycle_configuration.transfer.rule[0].expiration[0].days == 1
    error_message = "Do not retain old transfer versions; expire interrupted transfers after one day."
  }
}

run "oracle_must_be_live_first" {
  command = plan
  variables {
    oracle_endpoint_verified = false
  }
  expect_failures = [aws_launch_template.collectors]
}

run "distinct_subnets_are_required" {
  command = plan
  variables {
    subnet_ids = ["subnet-first", "subnet-first"]
  }
  expect_failures = [var.subnet_ids]
}
