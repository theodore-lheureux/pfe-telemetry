terraform {
  required_version = "= 1.13.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.11.0"
    }
  }
  backend "s3" {}
}

provider "google" {
  project = "recount-cloud"
  zone    = var.zone
}

locals {
  presets = {
    gpu-l4 = { kind = "gpu", machine = "g2-standard-4" }
  }
  selected = local.presets[var.preset]
  region   = join("-", slice(split("-", var.zone), 0, 2))
}

data "google_compute_image" "collector" {
  family  = "common-cu129-ubuntu-2204-nvidia-580"
  project = "deeplearning-platform-release"
}

resource "google_compute_instance" "collector" {
  count        = var.collector_count
  project      = "recount-cloud"
  zone         = var.zone
  name         = format("demo-%s-%02d", var.lab_id, count.index + 1)
  machine_type = local.selected.machine
  tags         = ["recount-demo"]
  labels = {
    recount-owner  = "recount-demo-semaphore"
    recount-demo   = "true"
    recount-lab    = var.lab_id
    recount-kind   = local.selected.kind
    recount-preset = var.preset
    recount-ttl    = tostring(var.ttl_seconds)
  }

  boot_disk {
    auto_delete = true
    initialize_params {
      image = data.google_compute_image.collector.self_link
      size  = 60
      type  = "pd-balanced"
    }
  }

  network_interface {
    network    = "projects/recount-cloud/global/networks/recount-demo"
    subnetwork = "projects/recount-cloud/regions/${local.region}/subnetworks/${var.subnets[local.region]}"
    access_config {}
  }

  scheduling {
    provisioning_model          = "SPOT"
    preemptible                 = true
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    instance_termination_action = "DELETE"
    max_run_duration {
      seconds = var.ttl_seconds
    }
  }

  dynamic "guest_accelerator" {
    for_each = local.selected.kind == "gpu" ? [1] : []
    content {
      type  = "nvidia-l4"
      count = 1
    }
  }

  metadata = {
    enable-oslogin          = "FALSE"
    block-project-ssh-keys  = "TRUE"
    enable-guest-attributes = "TRUE"
    ssh-keys                = "recount:${trimspace(var.ssh_public_key)}"
  }

  # No service_account block: the insert request contains no service accounts.
  lifecycle {
    postcondition {
      condition     = length(self.service_account) == 0
      error_message = "Temporary collectors must have no service account."
    }
    precondition {
      condition     = local.selected.kind != "gpu" || var.collector_count == 1
      error_message = "A lab may contain at most one GPU collector."
    }
  }
}

output "collectors" {
  value = [for instance in google_compute_instance.collector : {
    name        = instance.name
    zone        = instance.zone
    instance_id = instance.instance_id
    address     = instance.network_interface[0].access_config[0].nat_ip
    kind        = local.selected.kind
    lab_id      = var.lab_id
    preset      = var.preset
    ttl_seconds = var.ttl_seconds
  }]
}
