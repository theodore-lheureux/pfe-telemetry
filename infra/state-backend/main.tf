variable "aws_profile" {
  description = "Use pfe on the owner's machine, or select local credentials through AWS_PROFILE."
  type        = string
  default     = null
}

variable "region" {
  type    = string
  default = "us-east-2"
}

variable "expected_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Set expected_account_id to the intended 12-digit AWS account."
  }
}

locals {
  bucket_name = "pfe-opentofu-state-${var.expected_account_id}-${var.region}"
}

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket_name
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "RequireTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "ProtectBucket"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:DeleteBucket"
        Resource  = aws_s3_bucket.state.arn
      },
      {
        Sid       = "PreserveVersionHistory"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:DeleteObjectVersion"
        Resource  = "${aws_s3_bucket.state.arn}/*"
      },
    ]
  })
}

output "bucket_name" {
  value = aws_s3_bucket.state.id
}
