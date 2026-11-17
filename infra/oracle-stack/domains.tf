variable "cloudflare_api_token" {
  description = "Existing repository CLOUDFLARE_API_TOKEN secret, mapped through TF_VAR_cloudflare_api_token in CI."
  type        = string
  sensitive   = true
  default     = null
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "cloudflare_zones" "recount" {
  count  = var.deployment_enabled ? 1 : 0
  name   = "recount.cloud"
  status = "active"
  lifecycle {
    postcondition {
      condition     = length(self.result) == 1 && alltrue([for zone in self.result : zone.name == "recount.cloud" && zone.status == "active"])
      error_message = "The existing token must resolve exactly one active recount.cloud zone."
    }
  }
}

resource "cloudflare_dns_record" "ingestion" {
  for_each = var.deployment_enabled ? toset(["app", "ingest"]) : toset([])
  zone_id  = one(data.cloudflare_zones.recount[0].result[*].id)
  name     = "${each.key}.recount.cloud"
  type     = "A"
  content  = data.oci_core_vnic.ingestion.public_ip_address
  ttl      = 300
  proxied  = false
  lifecycle {
    precondition {
      condition     = can(cidrhost("${data.oci_core_vnic.ingestion.public_ip_address}/32", 0))
      error_message = "Public DNS records require the inspected VM's IPv4 address."
    }
  }
}
