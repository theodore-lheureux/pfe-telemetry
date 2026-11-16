mock_provider "oci" {
  mock_data "oci_core_instance" {
    defaults = {
      defined_tags = { "Oracle-Tags.CreatedOn" = "2026-01-01T00:00:00Z" }
    }
  }
  mock_data "oci_core_security_lists" {
    defaults = {
      security_lists = [{
        id                     = "ocid1.securitylist.oc1.test"
        compartment_id         = "ocid1.compartment.oc1.test"
        defined_tags           = { "Oracle-Tags.CreatedOn" = "2026-01-02T00:00:00Z" }
        freeform_tags          = {}
        display_name           = "synthetic-security-list"
        ingress_security_rules = []
        egress_security_rules  = []
        state                  = "AVAILABLE"
        time_created           = null
        vcn_id                 = "ocid1.vcn.oc1.test"
      }]
    }
  }
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
    condition     = endswith(oci_identity_policy.cd.statements[3], "where all {target.resource.tag.Oracle-Tags.CreatedOn = '2026-01-01T00:00:00Z', request.permission = 'INSTANCE_ATTACH_VOLUME'}")
    error_message = "Instance attachment permission must use the supported tag condition for the selected VM."
  }
  assert {
    condition     = endswith(oci_identity_policy.cd.statements[5], "where all {request.operation = 'AttachVolume', request.permission = 'VOLUME_ATTACHMENT_CREATE'}")
    error_message = "Attachment-object creation is permitted only for AttachVolume, with no detach/delete grant."
  }
  assert {
    condition     = endswith(oci_identity_policy.cd.statements[8], "where all {target.resource.tag.Oracle-Tags.CreatedOn = '2026-01-02T00:00:00Z', request.permission = 'SECURITY_LIST_UPDATE'}")
    error_message = "Only the marked security list can be updated; creation and deletion must remain denied."
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

run "missing_target_marker_fails_closed" {
  command = plan
  override_data {
    target = data.oci_core_instance.authorization_target
    values = { defined_tags = {} }
  }
  expect_failures = [oci_identity_policy.cd]
}
