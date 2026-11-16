terraform {
  required_version = ">= 1.12.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71.0"
    }
  }

  backend "s3" {
    key          = "bootstrap/state-backend.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  profile             = var.aws_profile
  region              = var.region
  allowed_account_ids = [var.expected_account_id]

  default_tags {
    tags = {
      Project   = "pfe-telemetry"
      ManagedBy = "OpenTofu"
      Purpose   = "infrastructure-state"
    }
  }
}
