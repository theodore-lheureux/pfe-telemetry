variable "region" {
  type    = string
  default = "ca-montreal-1"
}

variable "oci_profile" {
  type    = string
  default = "pfe"
}

variable "oci_auth" {
  type    = string
  default = "SecurityToken"
  validation {
    condition     = contains(["SecurityToken", "APIKey"], var.oci_auth)
    error_message = "Use the owner's session for inspection or the dedicated CD API key."
  }
}

variable "instance_id" {
  type = string
  validation {
    condition     = startswith(var.instance_id, "ocid1.instance.")
    error_message = "Set the existing instance OCID."
  }
}

variable "vnic_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "vcn_id" {
  type = string
}

variable "boot_volume_id" {
  type = string
}

variable "network_security_group_ids" {
  type    = set(string)
  default = []
}

variable "storage_compartment_id" {
  description = "Dedicated project compartment from local identity bootstrap; never the VM's root compartment."
  type        = string
  default     = null
}
