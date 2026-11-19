variable "lab_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.lab_id))
    error_message = "Use a new lowercase lab ID of at most 24 characters."
  }
}
variable "collector_count" {
  type = number
  validation {
    condition     = var.collector_count == floor(var.collector_count) && var.collector_count >= 1 && var.collector_count <= 200
    error_message = "CPU count must be an integer from 1 to 200."
  }
}
variable "ttl_seconds" {
  type = number
  validation {
    condition     = contains([900, 1800, 3600, 7200, 14400], var.ttl_seconds)
    error_message = "Select a TTL from 15 minutes to 4 hours."
  }
}
variable "created_at" {
  type = string
  validation {
    condition     = can(formatdate("YYYY-MM-DD", var.created_at))
    error_message = "Supply the creation attempt's fixed UTC timestamp."
  }
}
variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "Select the allocated AWS region."
  }
}
variable "subnet_id" {
  type = string
  validation {
    condition     = can(regex("^subnet-[a-f0-9]+$", var.subnet_id))
    error_message = "Select the isolated demo subnet."
  }
}
variable "security_group_id" {
  type = string
  validation {
    condition     = can(regex("^sg-[a-f0-9]+$", var.security_group_id))
    error_message = "Select the isolated demo security group."
  }
}
variable "instance_profile" {
  type = string
  validation {
    condition     = can(regex("^recount-demo-[a-z0-9-]+$", var.instance_profile))
    error_message = "Use a dedicated demo SSM profile."
  }
}
variable "network_mode" {
  type    = string
  default = "public"
  validation {
    condition     = contains(["public", "private"], var.network_mode)
    error_message = "Select public small-fleet or preconfigured private-NAT networking."
  }
}
variable "expiry_guard_ready" {
  type    = bool
  default = false
}
