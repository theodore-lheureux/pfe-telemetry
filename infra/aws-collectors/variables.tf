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
    condition     = length(var.subnet_ids) == 2
    error_message = "Select exactly two existing public subnets."
  }
}

variable "instance_profile_name" {
  type    = string
  default = "recount-collector"
}

variable "ssh_cidrs" {
  type    = set(string)
  default = []
  validation {
    condition     = alltrue([for cidr in var.ssh_cidrs : can(cidrnetmask(cidr))])
    error_message = "Use explicit IPv4 CIDRs; the default opens no inbound port."
  }
}

variable "ingestion_endpoint" {
  type    = string
  default = "https://ingest.recount.cloud"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:443)?/?$", var.ingestion_endpoint))
    error_message = "Use the verified Oracle HTTPS gRPC endpoint on port 443."
  }
}

variable "enrollment_url" {
  type    = string
  default = "https://app.recount.cloud"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:443)?/?$", var.enrollment_url))
    error_message = "Use the HTTPS web application's enrollment origin."
  }
}

variable "enrollment_parameter_name" {
  type    = string
  default = "/recount/collectors/enrollment"
}

variable "collector_release_url" {
  type = string
  validation {
    condition     = can(regex("^https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/recount-collector-arm64.tar.gz$", var.collector_release_url))
    error_message = "Select a published, immutable native ARM64 collector release archive."
  }
}

variable "collector_release_sha256" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.collector_release_sha256))
    error_message = "Supply the approved release archive checksum."
  }
}

variable "oracle_endpoint_verified" {
  type    = bool
  default = false
}
