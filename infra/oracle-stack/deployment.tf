variable "deployment_enabled" {
  description = "Enable only after inspecting tenancy-wide Always Free capacity and the selected security list."
  type        = bool
  default     = false
}

variable "security_list_id" {
  description = "Existing subnet security list adopted after inspecting every rule."
  type        = string
  default     = null
  validation {
    condition     = !var.deployment_enabled || var.security_list_id != null
    error_message = "Select the inspected security list before enabling deployment."
  }
}

variable "ssh_source_cidrs" {
  description = "Preserves the inspected SSH rule by default. Restrict to approved operator CIDRs after verifying management access."
  type        = set(string)
  default     = ["0.0.0.0/0"]
  validation {
    condition     = alltrue([for cidr in var.ssh_source_cidrs : can(cidrnetmask(cidr))])
    error_message = "Supply valid IPv4 SSH source CIDRs, or an empty set to disable SSH ingress."
  }
}

resource "oci_core_volume" "data" {
  count               = var.deployment_enabled ? 1 : 0
  availability_domain = data.oci_core_instance.ingestion.availability_domain
  compartment_id      = var.storage_compartment_id
  display_name        = "recount-ingestion-data"
  size_in_gbs         = 150
  vpus_per_gb         = 10
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.storage_compartment_id != null && var.storage_compartment_id != data.oci_core_instance.ingestion.compartment_id
      error_message = "Data storage must be isolated in its dedicated project compartment."
    }
    precondition {
      condition     = tonumber(data.oci_core_boot_volume.ingestion.size_in_gbs) + 150 <= 200
      error_message = "The selected boot and data volumes must fit within 200 GiB; independently inspect all tenancy allocations."
    }
  }
}

resource "oci_core_volume_attachment" "data" {
  count                               = var.deployment_enabled ? 1 : 0
  attachment_type                     = "paravirtualized"
  instance_id                         = var.instance_id
  volume_id                           = oci_core_volume.data[0].id
  is_pv_encryption_in_transit_enabled = true
  display_name                        = "recount-ingestion-data"
  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_volume_backup_policy" "data" {
  count          = var.deployment_enabled ? 1 : 0
  compartment_id = var.storage_compartment_id
  display_name   = "recount-ingestion-daily"
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_DAY"
    retention_seconds = 172800
    hour_of_day       = 4
    time_zone         = "UTC"
  }
}

resource "oci_core_volume_backup_policy_assignment" "data" {
  count     = var.deployment_enabled ? 1 : 0
  asset_id  = oci_core_volume.data[0].id
  policy_id = oci_core_volume_backup_policy.data[0].id
}

resource "oci_core_security_list" "ingestion" {
  count          = var.deployment_enabled ? 1 : 0
  compartment_id = data.oci_core_subnet.ingestion.compartment_id
  vcn_id         = var.vcn_id
  display_name   = "recount-ingestion-network"
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "6"
    tcp_options {
      min = 443
      max = 443
    }
  }
  dynamic "ingress_security_rules" {
    for_each = var.ssh_source_cidrs
    content {
      source   = ingress_security_rules.value
      protocol = "6"
      tcp_options {
        min = 22
        max = 22
      }
    }
  }
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
  ingress_security_rules {
    source   = data.oci_core_vcn.ingestion.cidr_block
    protocol = "1"
    icmp_options {
      type = 3
    }
  }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [defined_tags, freeform_tags, display_name]
    precondition {
      condition     = contains(data.oci_core_subnet.ingestion.security_list_ids, var.security_list_id)
      error_message = "Only the inspected subnet's security list may be adopted."
    }
  }
}

output "data_volume_id" {
  value = one(oci_core_volume.data[*].id)
}

output "data_attachment_device" {
  value = one(oci_core_volume_attachment.data[*].device)
}
