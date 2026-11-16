mock_provider "oci" {
  mock_data "oci_core_instance" {
    defaults = {
      id                  = "ocid1.instance.oc1.test"
      compartment_id      = "ocid1.compartment.oc1.test"
      availability_domain = "test:CA-MONTREAL-1-AD-1"
      shape               = "VM.Standard.A1.Flex"
      source_details = [{
        source_id                            = "ocid1.image.oc1.test"
        source_type                          = "image"
        boot_volume_size_in_gbs              = null
        boot_volume_vpus_per_gb              = null
        instance_source_image_filter_details = []
        is_preserve_boot_volume_enabled      = null
        kms_key_id                           = null
      }]
    }
  }
  mock_data "oci_core_vnic" {
    defaults = {
      subnet_id         = "ocid1.subnet.oc1.test"
      nsg_ids           = []
      public_ip_address = "192.0.2.1"
    }
  }
  mock_data "oci_core_vnic_attachments" {
    defaults = { vnic_attachments = [{
      vnic_id             = "ocid1.vnic.oc1.test"
      id                  = "ocid1.vnicattachment.oc1.test"
      instance_id         = "ocid1.instance.oc1.test"
      availability_domain = null
      compartment_id      = null
      create_vnic_details = []
      display_name        = null
      nic_index           = 0
      state               = "ATTACHED"
      subnet_id           = "ocid1.subnet.oc1.test"
      time_created        = null
      vlan_id             = null
      vlan_tag            = null
    }] }
  }
  mock_data "oci_core_boot_volume" {
    defaults = { size_in_gbs = 50 }
  }
  mock_data "oci_core_boot_volume_attachments" {
    defaults = { boot_volume_attachments = [{
      boot_volume_id                      = "ocid1.bootvolume.oc1.test"
      id                                  = "ocid1.bootvolumeattachment.oc1.test"
      instance_id                         = "ocid1.instance.oc1.test"
      availability_domain                 = null
      compartment_id                      = null
      display_name                        = null
      encryption_in_transit_type          = null
      is_encryption_in_transit_enabled    = null
      is_pv_encryption_in_transit_enabled = null
      state                               = "ATTACHED"
      time_created                        = null
      time_updated                        = null
    }] }
  }
  mock_data "oci_core_subnet" {
    defaults = {
      vcn_id            = "ocid1.vcn.oc1.test"
      security_list_ids = ["ocid1.securitylist.oc1.test"]
    }
  }
}

mock_provider "cloudflare" {
  mock_data "cloudflare_zones" {
    defaults = {
      result = [{
        id                    = "00000000000000000000000000000001"
        name                  = "recount.cloud"
        status                = "active"
        type                  = "full"
        account               = null
        activated_on          = null
        cname_suffix          = null
        created_on            = null
        development_mode      = 0
        meta                  = null
        modified_on           = null
        name_servers          = []
        original_dnshost      = null
        original_name_servers = []
        original_registrar    = null
        owner                 = null
        paused                = false
        permissions           = []
        plan                  = null
        tenant                = null
        tenant_unit           = null
        vanity_name_servers   = []
        verification_key      = null
      }]
    }
  }
}

variables {
  instance_id    = "ocid1.instance.oc1.test"
  vnic_id        = "ocid1.vnic.oc1.test"
  subnet_id      = "ocid1.subnet.oc1.test"
  vcn_id         = "ocid1.vcn.oc1.test"
  boot_volume_id = "ocid1.bootvolume.oc1.test"
}

run "reference_existing_vm" {
  command = plan
  assert {
    condition     = length(cloudflare_dns_record.ingestion) == 0
    error_message = "Do not publish DNS while deployment is disabled."
  }
  assert {
    condition     = length(oci_core_volume.data) == 0 && length(oci_core_security_list.ingestion) == 0 && length(oci_core_volume_backup_policy.data) == 0
    error_message = "Uninspected deployment resources must remain disabled by default."
  }
  assert {
    condition     = output.inventory.shape == "VM.Standard.A1.Flex" && output.inventory.boot_volume_gib == 50
    error_message = "Report the existing VM and disk rather than proposing replacements."
  }
  assert {
    condition     = output.inventory.security_list_ids == tolist(["ocid1.securitylist.oc1.test"])
    error_message = "Read every security list associated with the subnet."
  }
}

run "reject_unrelated_network" {
  command = plan
  variables {
    subnet_id = "ocid1.subnet.oc1.other"
  }
  expect_failures = [data.oci_core_vnic.ingestion]
}

run "reject_unrelated_disk" {
  command = plan
  variables {
    boot_volume_id = "ocid1.bootvolume.oc1.other"
  }
  expect_failures = [data.oci_core_boot_volume_attachments.ingestion]
}

run "enabled_storage_and_restricted_ssh" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.test"
    ssh_source_cidrs       = ["192.0.2.0/24"]
  }
  assert {
    condition     = tonumber(oci_core_volume.data[0].size_in_gbs) == 150 && oci_core_volume.data[0].compartment_id == "ocid1.compartment.oc1.storage"
    error_message = "Use only the 150 GiB project-compartment data volume."
  }
  assert {
    condition     = oci_core_volume_attachment.data[0].is_pv_encryption_in_transit_enabled && oci_core_volume_attachment.data[0].instance_id == var.instance_id
    error_message = "Encrypt the attachment in transit and bind only the inspected VM."
  }
  assert {
    condition     = one(oci_core_volume_backup_policy.data[0].schedules).retention_seconds >= 172800
    error_message = "Daily backups need at least two days of overlap."
  }
  assert {
    condition = toset([
      for rule in oci_core_security_list.ingestion[0].ingress_security_rules :
      rule.source if rule.protocol == "6" && try(one(rule.tcp_options).min, 0) == 22
    ]) == toset(["192.0.2.0/24"])
    error_message = "SSH sources must remain independent of public HTTPS."
  }
  assert {
    condition = toset([
      for rule in oci_core_security_list.ingestion[0].ingress_security_rules :
      rule.source if rule.protocol == "6" && try(one(rule.tcp_options).min, 0) == 443
    ]) == toset(["0.0.0.0/0"])
    error_message = "Only HTTPS remains publicly exposed independently of the SSH selection."
  }
}

run "enabled_default_preserves_inspected_ssh" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.test"
  }
  assert {
    condition = toset([
      for rule in oci_core_security_list.ingestion[0].ingress_security_rules :
      rule.source if rule.protocol == "6" && try(one(rule.tcp_options).min, 0) == 22
    ]) == toset(["0.0.0.0/0"])
    error_message = "The default must preserve the currently inspected SSH rule, never silently restrict or expand it."
  }
}

run "enabled_rejects_oversized_boot_volume" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.test"
  }
  override_data {
    target = data.oci_core_boot_volume.ingestion
    values = { size_in_gbs = "100" }
  }
  expect_failures = [oci_core_volume.data]
}

run "enabled_rejects_unrelated_security_list" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.unrelated"
  }
  expect_failures = [oci_core_security_list.ingestion]
}

run "owned_public_dns_records_only" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.test"
  }
  assert {
    condition     = toset(keys(cloudflare_dns_record.ingestion)) == toset(["app", "ingest"])
    error_message = "Only the app and ingest records may be managed, never apex or landing records."
  }
  assert {
    condition     = toset([for record in cloudflare_dns_record.ingestion : record.name]) == toset(["app.recount.cloud", "ingest.recount.cloud"])
    error_message = "Public records must use the two owned hostnames."
  }
  assert {
    condition = alltrue([
      for record in cloudflare_dns_record.ingestion :
      record.type == "A" && record.proxied == false &&
      record.content == data.oci_core_vnic.ingestion.public_ip_address &&
      record.zone_id == one(data.cloudflare_zones.recount[0].result[*].id) &&
      record.ttl == 300
    ])
    error_message = "Both DNS-only A records must point directly at the VM in the zone found by name."
  }
}

run "missing_zone_fails_closed" {
  command = plan
  variables {
    deployment_enabled     = true
    storage_compartment_id = "ocid1.compartment.oc1.storage"
    security_list_id       = "ocid1.securitylist.oc1.test"
  }
  override_data {
    target = data.cloudflare_zones.recount[0]
    values = { result = [] }
  }
  expect_failures = [data.cloudflare_zones.recount]
}
