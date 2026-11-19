mock_provider "google" {}

variables {
  lab_id          = "test-gpu"
  preset          = "gpu-l4"
  collector_count = 1
  ttl_seconds     = 7200
  zone            = "us-central1-a"
  subnets         = { us-central1 = "recount-demo-us-central1" }
  ssh_public_key  = "ssh-ed25519 AAAAtest"
}

run "bounded_gpu" {
  command = plan
  assert {
    condition     = google_compute_instance.collector[0].scheduling[0].provisioning_model == "SPOT" && google_compute_instance.collector[0].scheduling[0].instance_termination_action == "DELETE" && google_compute_instance.collector[0].scheduling[0].max_run_duration[0].seconds == 7200
    error_message = "Spot expiry is mandatory."
  }
  assert {
    condition     = google_compute_instance.collector[0].boot_disk[0].auto_delete && length(google_compute_instance.collector[0].service_account) == 0
    error_message = "Boot disks must auto-delete and no service account may be attached."
  }
}

run "count_limit" {
  command = plan
  variables { collector_count = 2 }
  expect_failures = [var.collector_count]
}

run "ttl_limit" {
  command = plan
  variables { ttl_seconds = 18000 }
  expect_failures = [var.ttl_seconds]
}

run "path_injection" {
  command = plan
  variables { lab_id = "../permanent" }
  expect_failures = [var.lab_id]
}
