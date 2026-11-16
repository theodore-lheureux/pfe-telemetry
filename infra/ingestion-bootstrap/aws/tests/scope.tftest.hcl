mock_provider "aws" {
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/recount-collectors-region-tags-and-state" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/recount-collector" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::123456789012:instance-profile/recount-collector" }
  }
}

variables {
  expected_account_id = "123456789012"
  state_bucket        = "example-state"
}

run "collectors_are_region_tag_and_state_scoped" {
  command = plan
  variables {
    collectors_vpc_id = "vpc-synthetic"
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.enrollment[0].policy).Statement[1].Effect == "Deny" && jsondecode(aws_iam_role_policy.enrollment[0].policy).Statement[1].NotResource == "arn:aws:ssm:us-east-2:123456789012:parameter/recount/collectors/enrollment"
    error_message = "The managed SSM policy must not broaden reads to other parameters."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.collector_ssm[0].policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "Collectors need managed SSM agent permissions, not inbound SSH."
  }
  assert {
    condition     = length(aws_iam_user_policy.collector_transfer[0].policy) <= 2048 && jsondecode(aws_iam_user_policy.collector_transfer[0].policy).Statement[0].Resource == "arn:aws:s3:::recount-collector-transfer-123456789012"
    error_message = "CD may manage only the exact transfer bucket and its inline policy must fit IAM limits."
  }
  assert {
    condition     = aws_iam_user.collectors_cd[0].name == "recount-collectors-cd"
    error_message = "Collectors must not reuse the ingestion CD identity."
  }
  assert {
    condition     = jsondecode(aws_iam_policy.collectors_cd[0].policy).Statement[1].Resource == "arn:aws:s3:::example-state/aws/collectors/terraform.tfstate"
    error_message = "Collectors may write only their own state."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_policy.collectors_cd[0].policy).Statement :
      statement.Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
      if startswith(statement.Action[0], "ec2:") || startswith(statement.Action[0], "ssm:")
    ])
    error_message = "All EC2/SSM permissions must be restricted to Ohio."
  }
  assert {
    condition     = length(aws_iam_policy.collectors_cd[0].policy) <= 6144
    error_message = "Keep the collector identity's customer-managed policy within the IAM policy limit."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_policy.collectors_cd[0].policy).Statement : statement if statement.Sid == "PassOnlyCollectorRole"]).Resource == aws_iam_role.collector[0].arn
    error_message = "Collectors CD may pass only its dedicated runtime role."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_policy.collectors_cd[0].policy).Statement : statement if statement.Sid == "LaunchInSelectedNetwork"]).Condition.ArnEquals["ec2:Vpc"] == "arn:aws:ec2:us-east-2:123456789012:vpc/vpc-synthetic"
    error_message = "Launch permission must be constrained to the explicitly selected network."
  }
  assert {
    condition     = local.collector_create.StringEquals["aws:RequestTag/project"] == "recount" && local.collector_owned.StringEquals["ec2:ResourceTag/project"] == "recount"
    error_message = "Tag-on-create and existing-resource tag conditions are mandatory."
  }
  assert {
    condition     = jsondecode(aws_iam_user_policy.state.policy).Statement[0].Condition.StringEquals["s3:prefix"] == ["oci/ingestion/terraform.tfstate", "oci/ingestion/workspaces/"]
    error_message = "The existing ingestion identity must keep its own state-prefix condition."
  }
}

run "only_state_and_native_lock" {
  command = plan
  assert {
    condition     = length(jsondecode(aws_iam_user_policy.state.policy).Statement) == 3
    error_message = "The CD identity must have no permissions outside state listing, state access and native locking."
  }
  assert {
    condition     = jsondecode(aws_iam_user_policy.state.policy).Statement[1].Resource == "arn:aws:s3:::example-state/oci/ingestion/terraform.tfstate"
    error_message = "Only the ingestion state is writable."
  }
  assert {
    condition     = jsondecode(aws_iam_user_policy.state.policy).Statement[1].Action == ["s3:GetObject", "s3:PutObject"]
    error_message = "CD must not delete state objects."
  }
  assert {
    condition     = jsondecode(aws_iam_user_policy.state.policy).Statement[2].Resource == "arn:aws:s3:::example-state/oci/ingestion/terraform.tfstate.tflock"
    error_message = "Deletion permission is limited to the native lock object."
  }
}
