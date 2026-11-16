variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Select the intended AWS account."
  }
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.subnet_ids) == 2 && length(toset(var.subnet_ids)) == 2
    error_message = "Select exactly two distinct existing public subnets."
  }
}

variable "instance_profile_name" {
  type    = string
  default = "recount-collector"
}

variable "oracle_endpoint_verified" {
  type    = bool
  default = false
}
