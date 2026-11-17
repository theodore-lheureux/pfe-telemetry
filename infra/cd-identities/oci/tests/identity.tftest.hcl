mock_provider "oci" {
  mock_resource "oci_identity_compartment" {
    defaults = { id = "ocid1.compartment.oc1.storage" }
  }
  mock_resource "oci_identity_group" {
    defaults = { id = "ocid1.group.oc1.test" }
  }
}

variables {
  tenancy_id     = "ocid1.tenancy.oc1.test"
  compartment_id = "ocid1.compartment.oc1.test"
  home_region    = "ca-montreal-1"
  instance_id    = "ocid1.instance.oc1.test"
  public_key     = "-----BEGIN PUBLIC KEY-----\nsynthetic-only\n-----END PUBLIC KEY-----"
  cd_email       = "collector-cd@example.test"
}

run "approved_compartment_service_families_without_identity_management" {
  command = plan
  assert {
    condition = toset(oci_identity_policy.cd.statements) == toset([
      "Allow group id ocid1.group.oc1.test to manage instance-family in compartment id ocid1.compartment.oc1.test",
      "Allow group id ocid1.group.oc1.test to manage virtual-network-family in compartment id ocid1.compartment.oc1.test",
      "Allow group id ocid1.group.oc1.test to manage volume-family in compartment id ocid1.compartment.oc1.storage",
      "Allow group id ocid1.group.oc1.test to read volumes in compartment id ocid1.compartment.oc1.test",
      "Allow group id ocid1.group.oc1.test to manage instance-agent-command-family in compartment id ocid1.compartment.oc1.test",
      "Allow group id ocid1.group.oc1.test to manage instance-agent-command-execution-family in compartment id ocid1.compartment.oc1.test",
    ])
    error_message = "Use only the approved service families and compartments, without fragile resource predicates or IAM management."
  }
  assert {
    condition = alltrue([
      for statement in oci_identity_policy.cd.statements :
      !strcontains(statement, "all-resources") &&
      !strcontains(statement, "in tenancy") &&
      !strcontains(statement, "to manage users") &&
      !strcontains(statement, "to manage groups") &&
      !strcontains(statement, "to manage policies")
    ])
    error_message = "The CD identity must not gain tenancy-wide identity/policy administration."
  }
}
