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

variable "security_list_id" {
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

data "oci_core_instance" "authorization_target" {
  instance_id = var.instance_id
}

data "oci_core_security_lists" "authorization_targets" {
  compartment_id = var.compartment_id
}

locals {
  instance_created_on = lookup(data.oci_core_instance.authorization_target.defined_tags, "Oracle-Tags.CreatedOn", "")
  security_list_created_on = try(one([
    for security_list in data.oci_core_security_lists.authorization_targets.security_lists :
    security_list if security_list.id == var.security_list_id
  ]).defined_tags["Oracle-Tags.CreatedOn"], "")
}

# Core ID predicates are not supported here. AttachVolume separately checks the
# marked instance, a project-compartment volume, and creation of its new attachment.
resource "oci_identity_policy" "cd" {
  compartment_id = var.compartment_id
  name           = "recount-ingestion-cd"
  description    = "Ingestion data-plane infrastructure only; no identities, policies or keys"
  statements = [
    "Allow group id ${oci_identity_group.cd.id} to read instance-family in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to read instance-images in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to read virtual-network-family in compartment id ${var.compartment_id}",
    "Allow group id ${oci_identity_group.cd.id} to use instances in compartment id ${var.compartment_id} where all {target.resource.tag.Oracle-Tags.CreatedOn = '${local.instance_created_on}', request.permission = 'INSTANCE_ATTACH_VOLUME'}",
    "Allow group id ${oci_identity_group.cd.id} to manage volumes in compartment id ${oci_identity_compartment.storage.id}",
    "Allow group id ${oci_identity_group.cd.id} to manage volume-attachments in compartment id ${var.compartment_id} where all {request.operation = 'AttachVolume', request.permission = 'VOLUME_ATTACHMENT_CREATE'}",
    "Allow group id ${oci_identity_group.cd.id} to manage backup-policies in compartment id ${oci_identity_compartment.storage.id}",
    "Allow group id ${oci_identity_group.cd.id} to manage backup-policy-assignments in compartment id ${oci_identity_compartment.storage.id}",
    "Allow group id ${oci_identity_group.cd.id} to manage security-lists in compartment id ${var.compartment_id} where all {target.resource.tag.Oracle-Tags.CreatedOn = '${local.security_list_created_on}', request.permission = 'SECURITY_LIST_UPDATE'}",
    "Allow group id ${oci_identity_group.cd.id} to use instance-agent-commands in compartment id ${oci_identity_compartment.storage.id} where all {target.instance.id = '${var.instance_id}', request.permission = 'INSTANCE_AGENT_COMMAND_CREATE'}",
    "Allow group id ${oci_identity_group.cd.id} to read volumes in compartment id ${var.compartment_id} where request.operation = 'GetBootVolume'",
    "Allow group id ${oci_identity_group.cd.id} to read instance-agent-commands in compartment id ${oci_identity_compartment.storage.id} where any {request.permission = 'INSTANCE_AGENT_COMMAND_READ', request.permission = 'INSTANCE_AGENT_COMMAND_EXECUTION_INSPECT'}",
    "Allow group id ${oci_identity_group.cd.id} to read instance-agent-command-execution-family in compartment id ${var.compartment_id} where target.instance.id = '${var.instance_id}'",
  ]
  lifecycle {
    precondition {
      condition     = can(formatdate("YYYY", local.instance_created_on)) && can(formatdate("YYYY", local.security_list_created_on))
      error_message = "The existing VM and security list must retain valid Oracle creation markers; do not fall back to broader permissions."
    }
    precondition {
      condition = length([
        for security_list in data.oci_core_security_lists.authorization_targets.security_lists :
        security_list if try(security_list.defined_tags["Oracle-Tags.CreatedOn"], "") == local.security_list_created_on
      ]) == 1
      error_message = "The selected security-list marker is not unique in its compartment; stop rather than expanding access."
    }
  }
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
