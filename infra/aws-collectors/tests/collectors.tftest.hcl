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
}

variables {
  expected_account_id      = "123456789012"
  vpc_id                   = "vpc-synthetic"
  subnet_ids               = ["subnet-first", "subnet-second"]
  ingestion_endpoint       = "https://ingestion.example.test"
  enrollment_url           = "https://web.example.test"
  collector_release_url    = "https://github.com/example/recount/releases/download/ingestion-synthetic/recount-collector-arm64.tar.gz"
  collector_release_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
    condition     = !strcontains(base64decode(aws_launch_template.collectors.user_data), "recount_enroll_")
    error_message = "Enrollment secret values must never be embedded in cloud-init."
  }
}

run "oracle_must_be_live_first" {
  command = plan
  variables {
    oracle_endpoint_verified = false
  }
  expect_failures = [aws_launch_template.collectors]
}

run "plaintext_ingestion_is_rejected" {
  command = plan
  variables {
    ingestion_endpoint = "http://ingestion.example.test"
  }
  expect_failures = [var.ingestion_endpoint]
}
