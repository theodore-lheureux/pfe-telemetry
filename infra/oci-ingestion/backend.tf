terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.13.0"
    }
  }
  backend "s3" {
    key                  = "oci/ingestion/terraform.tfstate"
    encrypt              = true
    use_lockfile         = true
    workspace_key_prefix = "oci/ingestion/workspaces"
  }
}

provider "oci" {
  region              = var.region
  auth                = var.oci_auth
  config_file_profile = var.oci_profile
}
