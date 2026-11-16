terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.13.0"
    }
  }
  backend "s3" {
    key          = "bootstrap/ingestion-oci.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

variable "tenancy_id" {
  type = string
}

variable "compartment_id" {
  type = string
}

variable "home_region" {
  type = string
}

variable "oci_profile" {
  type    = string
  default = "pfe"
}

variable "oci_auth" {
  type    = string
  default = "SecurityToken"
}

variable "public_key" {
  description = "Public PEM key only. Generate and retain the private key outside OpenTofu."
  type        = string
  validation {
    condition     = strcontains(var.public_key, "BEGIN PUBLIC KEY") && !strcontains(var.public_key, "PRIVATE KEY")
    error_message = "Supply only the deployment identity's public key."
  }
}

variable "instance_id" {
  type = string
}

variable "cd_email" {
  description = "Owner-selected primary service-account email required by OCI Identity Domains."
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.cd_email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.cd_email))
    error_message = "Specify the owner-approved service-account email."
  }
}

provider "oci" {
  auth                = var.oci_auth
  config_file_profile = var.oci_profile
  region              = var.home_region
}

resource "oci_identity_user" "cd" {
  compartment_id = var.tenancy_id
  name           = "recount-ingestion-cd"
  email          = var.cd_email
  description    = "GitHub ingestion infrastructure and release deployment; no IAM management"
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.cd_email != null
      error_message = "An owner-selected primary service-account email is required before creating the CD user."
    }
  }
}

resource "oci_identity_compartment" "storage" {
  compartment_id = var.tenancy_id
  name           = "recount-ingestion-data"
  description    = "Only Recount ingestion data volumes and backup policies"
  enable_delete  = false
  freeform_tags  = { project = "recount", component = "ingestion" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_identity_group" "cd" {
  compartment_id = var.tenancy_id
  name           = "recount-ingestion-cd"
  description    = "Scoped ingestion infrastructure and Run Command permissions"
}

resource "oci_identity_user_group_membership" "cd" {
  user_id  = oci_identity_user.cd.id
  group_id = oci_identity_group.cd.id
}

resource "oci_identity_api_key" "cd" {
  user_id   = oci_identity_user.cd.id
  key_value = var.public_key
}

resource "oci_identity_policy" "cd" {
  compartment_id = var.compartment_id
  name           = "recount-ingestion-cd"
  description    = "Ingestion data-plane infrastructure only; no identities, policies or keys"
  statements = [
    "Allow group id ${oci_identity_group.cd.id} to manage instance-family in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to manage virtual-network-family in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to manage volume-family in compartment id ${oci_identity_compartment.storage.id}",
    "Allow group id ${oci_identity_group.cd.id} to read volumes in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to manage instance-agent-command-family in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to manage instance-agent-command-execution-family in compartment id ${var.compartment_id}",
  ]
}

resource "oci_identity_dynamic_group" "agent" {
  compartment_id = var.tenancy_id
  name           = "recount-ingestion-agent"
  description    = "Only the existing ingestion VM may receive its own Run Commands"
  matching_rule  = "instance.id = '${var.instance_id}'"
}

resource "oci_identity_policy" "agent" {
  compartment_id = var.compartment_id
  name           = "recount-ingestion-agent"
  description    = "Permit the selected Oracle agent to execute commands addressed to itself"
  statements = [
    "Allow dynamic-group id ${oci_identity_dynamic_group.agent.id} to use instance-agent-command-execution-family in compartment id ${var.compartment_id} where request.instance.id = target.instance.id",
  ]
}

output "cd_user_id" {
  value = oci_identity_user.cd.id
}

output "cd_key_fingerprint" {
  value = oci_identity_api_key.cd.fingerprint
}

output "storage_compartment_id" {
  value = oci_identity_compartment.storage.id
}
