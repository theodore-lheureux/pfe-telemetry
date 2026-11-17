terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71.0"
    }
  }
  backend "s3" {
    key          = "bootstrap/ingestion-aws.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Select the intended 12-digit AWS account."
  }
}

variable "state_bucket" {
  type = string
}

provider "aws" {
  region              = "us-east-2"
  allowed_account_ids = [var.expected_account_id]
}

resource "aws_iam_user" "cd" {
  name          = "recount-ingestion-cd"
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_user_policy" "state" {
  name = "ingestion-state-only"
  user = aws_iam_user.cd.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListIngestionState"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${var.state_bucket}"
        Condition = { StringEquals = {
          "s3:prefix" = ["oci/ingestion/terraform.tfstate", "oci/ingestion/workspaces/"]
        } }
      },
      {
        Sid      = "ReadWriteIngestionState"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::${var.state_bucket}/oci/ingestion/terraform.tfstate"
      },
      {
        Sid      = "NativeStateLock"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.state_bucket}/oci/ingestion/terraform.tfstate.tflock"
      }
    ]
  })
}

output "cd_user_name" {
  value = aws_iam_user.cd.name
}
