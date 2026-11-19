mock_provider "aws" {
  mock_data "aws_subnet" {
    defaults = { vpc_id = "vpc-12345678", tags = { component = "demo" } }
  }
  mock_data "aws_security_group" {
    defaults = { vpc_id = "vpc-12345678", tags = { component = "demo" } }
  }
}

variables {
  lab_id             = "test-cpu"
  collector_count    = 2
  ttl_seconds        = 7200
  created_at         = "2026-11-17T12:00:00Z"
  region             = "us-east-2"
  subnet_id          = "subnet-12345678"
  security_group_id  = "sg-12345678"
  instance_profile   = "recount-demo-nodes"
  expiry_guard_ready = true
}

run "small_on_demand_fleet" {
  command = plan
  assert {
    condition     = length(aws_instance.collector) == 2 && aws_instance.collector[0].instance_type == "t4g.nano"
    error_message = "Default fleet shape changed."
  }
  assert {
    condition     = aws_instance.collector[0].root_block_device[0].volume_size == 8 && aws_instance.collector[0].root_block_device[0].delete_on_termination && aws_instance.collector[0].root_block_device[0].encrypted
    error_message = "Each VM requires its own encrypted auto-deleting boot disk."
  }
  assert {
    condition     = length(aws_instance.collector[0].instance_market_options) == 0 && aws_instance.collector[0].tags["recount-expires"] == "2026-11-17T14:00:00Z"
    error_message = "CPU must use on-demand with a fixed absolute expiry tag."
  }
  assert {
    condition     = aws_instance.collector[0].user_data == null
    error_message = "No enrollment secret may enter user data."
  }
}

run "count_ceiling" {
  command = plan
  variables { collector_count = 201 }
  expect_failures = [var.collector_count]
}

run "fractional_count" {
  command = plan
  variables { collector_count = 1.5 }
  expect_failures = [var.collector_count]
}

run "expiry_guard_required" {
  command = plan
  variables { expiry_guard_ready = false }
  expect_failures = [aws_instance.collector]
}

run "ttl_limit" {
  command = plan
  variables { ttl_seconds = 18000 }
  expect_failures = [var.ttl_seconds]
}

run "path_injection" {
  command = plan
  variables { lab_id = "../permanent" }
  expect_failures = [var.lab_id]
}
