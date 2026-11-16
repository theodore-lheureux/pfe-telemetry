mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::pfe-opentofu-state-123456789012-us-east-2"
      id  = "pfe-opentofu-state-123456789012-us-east-2"
    }
  }
}

variables {
  expected_account_id = "123456789012"
}

run "state_protections" {
  command = plan
  assert {
    condition     = aws_s3_bucket.state.force_destroy == false && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State must preserve version history and refuse forced deletion."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls &&
      aws_s3_bucket_public_access_block.state.block_public_policy &&
      aws_s3_bucket_public_access_block.state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "All public access protections must remain enabled."
  }
  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "State must remain encrypted."
  }
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_s3_bucket_policy.state.policy).Statement :
      statement.Effect == "Deny"
    ]) && aws_s3_bucket_ownership_controls.state.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "Keep ACLs disabled and TLS/deletion denial policies intact."
  }
}
