variable "lab_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.lab_id))
    error_message = "Use a new lowercase lab ID, at most 24 characters."
  }
}

variable "preset" {
  type = string
  validation {
    condition     = var.preset == "gpu-l4"
    error_message = "Select the one-L4 preset."
  }
}

variable "collector_count" {
  type = number
  validation {
    condition     = var.collector_count == 1
    error_message = "Only one GPU collector is allowed."
  }
}

variable "ttl_seconds" {
  type = number
  validation {
    condition     = contains([900, 1800, 3600, 7200, 14400], var.ttl_seconds)
    error_message = "Select a TTL from 15 minutes to 4 hours."
  }
}

variable "zone" {
  type = string
  validation {
    condition = contains([
      "us-central1-a", "us-central1-b", "us-central1-c", "us-east1-b",
      "us-east1-c", "us-east1-d", "northamerica-northeast1-a", "northamerica-northeast1-c"
    ], var.zone)
    error_message = "Zone is outside the demo allocation."
  }
}

variable "subnets" {
  type = map(string)
  validation {
    condition     = length(var.subnets) > 0 && alltrue([for value in values(var.subnets) : can(regex("^recount-demo-[a-z0-9-]+$", value))])
    error_message = "Use only pre-created recount-demo subnets."
  }
}

variable "ssh_public_key" {
  type = string
  validation {
    condition     = can(regex("^ssh-ed25519 [A-Za-z0-9+/=]+( [^\\r\\n]+)?$", trimspace(var.ssh_public_key)))
    error_message = "A dedicated Ed25519 public key is required."
  }
}
