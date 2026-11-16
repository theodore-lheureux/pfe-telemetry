data "oci_core_instance" "ingestion" {
  instance_id = var.instance_id
}

data "oci_core_image" "ingestion" {
  image_id = data.oci_core_instance.ingestion.source_details[0].source_id
}

data "oci_core_vnic" "ingestion" {
  vnic_id = var.vnic_id
  lifecycle {
    postcondition {
      condition     = self.subnet_id == var.subnet_id
      error_message = "The selected VNIC is not in the selected subnet."
    }
    postcondition {
      condition     = toset(self.nsg_ids) == var.network_security_group_ids
      error_message = "Inspect and record the actual VNIC NSGs before proceeding."
    }
  }
}

data "oci_core_vnic_attachments" "ingestion" {
  compartment_id = data.oci_core_instance.ingestion.compartment_id
  instance_id    = var.instance_id
  lifecycle {
    postcondition {
      condition     = contains([for attachment in self.vnic_attachments : attachment.vnic_id], var.vnic_id)
      error_message = "The selected VNIC is not attached to the existing VM."
    }
  }
}

data "oci_core_subnet" "ingestion" {
  subnet_id = var.subnet_id
  lifecycle {
    postcondition {
      condition     = self.vcn_id == var.vcn_id
      error_message = "The selected subnet is not in the selected VCN."
    }
  }
}

data "oci_core_vcn" "ingestion" {
  vcn_id = var.vcn_id
}

data "oci_core_boot_volume" "ingestion" {
  boot_volume_id = var.boot_volume_id
}

data "oci_core_boot_volume_attachments" "ingestion" {
  availability_domain = data.oci_core_instance.ingestion.availability_domain
  compartment_id      = data.oci_core_instance.ingestion.compartment_id
  instance_id         = var.instance_id
  lifecycle {
    postcondition {
      condition     = contains([for attachment in self.boot_volume_attachments : attachment.boot_volume_id], var.boot_volume_id)
      error_message = "The selected boot volume is not attached to the existing VM."
    }
  }
}

data "oci_core_security_lists" "ingestion" {
  compartment_id = data.oci_core_subnet.ingestion.compartment_id
  vcn_id         = var.vcn_id
  filter {
    name   = "id"
    values = data.oci_core_subnet.ingestion.security_list_ids
  }
}

data "oci_core_route_tables" "ingestion" {
  compartment_id = data.oci_core_subnet.ingestion.compartment_id
  vcn_id         = var.vcn_id
  filter {
    name   = "id"
    values = [data.oci_core_subnet.ingestion.route_table_id]
  }
}

data "oci_core_network_security_group" "ingestion" {
  for_each                  = var.network_security_group_ids
  network_security_group_id = each.value
}

data "oci_core_network_security_group_security_rules" "ingestion" {
  for_each                  = var.network_security_group_ids
  network_security_group_id = each.value
}

output "inventory" {
  value = {
    instance_id        = data.oci_core_instance.ingestion.id
    compartment_id     = data.oci_core_instance.ingestion.compartment_id
    shape              = data.oci_core_instance.ingestion.shape
    shape_config       = data.oci_core_instance.ingestion.shape_config
    image_os           = data.oci_core_image.ingestion.operating_system
    image_os_version   = data.oci_core_image.ingestion.operating_system_version
    boot_volume_gib    = tonumber(data.oci_core_boot_volume.ingestion.size_in_gbs)
    public_ip          = data.oci_core_vnic.ingestion.public_ip_address
    private_ip         = data.oci_core_vnic.ingestion.private_ip_address
    vcn_id             = data.oci_core_vcn.ingestion.id
    subnet_id          = data.oci_core_subnet.ingestion.id
    security_list_ids  = data.oci_core_subnet.ingestion.security_list_ids
    security_group_ids = var.network_security_group_ids
  }
}
