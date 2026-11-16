mock_provider "oci" {
  mock_resource "oci_identity_compartment" {
    defaults = { id = "ocid1.compartment.oc1.storage" }
  }
  mock_resource "oci_identity_group" {
    defaults = { id = "ocid1.group.oc1.test" }
  }
}

variables {
  tenancy_id       = "ocid1.tenancy.oc1.test"
  compartment_id   = "ocid1.compartment.oc1.test"
  home_region      = "ca-montreal-1"
  instance_id      = "ocid1.instance.oc1.test"
  security_list_id = "ocid1.securitylist.oc1.test"
  public_key       = "-----BEGIN PUBLIC KEY-----\nsynthetic-only\n-----END PUBLIC KEY-----"
  cd_email         = "collector-cd@example.test"
}

run "no_iam_management_in_cd" {
  command = plan
  assert {
    condition = alltrue([
      for statement in oci_identity_policy.cd.statements :
      !strcontains(statement, "to manage all-resources") &&
      !strcontains(statement, "to manage users") &&
      !strcontains(statement, "to manage groups") &&
      !strcontains(statement, "to manage policies") &&
      !strcontains(statement, "in tenancy")
    ])
    error_message = "CI must never manage IAM or receive tenancy-wide access."
  }
  assert {
    condition     = strcontains(oci_identity_policy.cd.statements[9], "target.instance.id = 'ocid1.instance.oc1.test'")
    error_message = "Run Command must fail closed without the exact instance target."
  }
  assert {
    condition = alltrue([
      for index in [4, 6, 7] :
      endswith(oci_identity_policy.cd.statements[index], "in compartment id ocid1.compartment.oc1.storage")
    ])
    error_message = "Volume and backup management must never be unconditional in the VM's root compartment."
  }
  assert {
    condition     = endswith(oci_identity_policy.cd.statements[5], "where target.instance.id = 'ocid1.instance.oc1.test'")
    error_message = "Root-compartment attachment permissions must remain restricted to the selected instance."
  }
  assert {
    condition     = strcontains(oci_identity_policy.cd.statements[9], "in compartment id ocid1.compartment.oc1.storage") && strcontains(oci_identity_policy.cd.statements[9], "request.permission = 'INSTANCE_AGENT_COMMAND_CREATE'")
    error_message = "Only project-compartment commands addressed to the selected instance may be created."
  }
  assert {
    condition     = endswith(oci_identity_policy.cd.statements[10], "where request.operation = 'GetBootVolume'")
    error_message = "Root-volume inventory permission must remain read-only and operation-limited."
  }
  assert {
    condition     = strcontains(oci_identity_policy.cd.statements[11], "in compartment id ocid1.compartment.oc1.storage") && strcontains(oci_identity_policy.cd.statements[11], "request.permission = 'INSTANCE_AGENT_COMMAND_EXECUTION_INSPECT'") && strcontains(oci_identity_policy.cd.statements[11], "request.permission = 'INSTANCE_AGENT_COMMAND_READ'")
    error_message = "Status inspection must be limited to project commands, never root-wide command reads."
  }
  assert {
    condition     = endswith(oci_identity_policy.cd.statements[12], "where target.instance.id = 'ocid1.instance.oc1.test'")
    error_message = "Execution-family reads in the VM compartment must remain target-conditioned."
  }
}
