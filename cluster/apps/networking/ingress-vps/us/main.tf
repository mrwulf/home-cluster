variable "ovh_endpoint" {
  type      = string
  sensitive = true
  default   = "ovh-us"
}
variable "ovh_application_key" {
  type      = string
  sensitive = true
}
variable "ovh_application_secret" {
  type      = string
  sensitive = true
}
variable "ovh_consumer_key" {
  type      = string
  sensitive = true
}
variable "ovh_service_name" {
  type      = string
  sensitive = true
}
variable "ovh_region" {
  type        = string
  default     = "US-EAST-VA-1"
  description = "OVH Public Cloud region (e.g. US-WEST-OR-1 - Hillsboro, US-EAST-VA-1 - Vint Hill)"
}
variable "ovh_flavor_name" {
  type        = string
  default     = "d2-2"
  description = "OVH Public Cloud instance flavor name (e.g. d2-2, b2-7, s1-2)"
}
variable "CLOUDFLARE_APIKEY" {
  type      = string
  sensitive = true
}
variable "secret_domain" {
  type      = string
  sensitive = true
}
variable "ssh_public_key" {
  type      = string
  sensitive = true
  default   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhBCPhLP3Hd+hYkWk406IXNZmsj/QP8HLRmvqx8oLE6"
}
variable "netbird_selfhosted_setup_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "netbird_relay_auth_secret" {
  type      = string
  sensitive = true
  default   = ""
}
variable "peer_us_private_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "peer_us_public_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "wg_public_key" {
  type      = string
  sensitive = true
  default   = ""
}

terraform {
  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "2.19.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0"
    }
  }
}

provider "ovh" {
  endpoint           = var.ovh_endpoint
  application_key    = var.ovh_application_key
  application_secret = var.ovh_application_secret
  consumer_key       = var.ovh_consumer_key
}

provider "cloudflare" {
  api_token = var.CLOUDFLARE_APIKEY
}

provider "kubernetes" {}

# Fetch home public IP dynamically for firewall and cloud-init
data "http" "home_ip" {
  url = "https://api.ipify.org"
}

locals {
  home_ip = chomp(data.http.home_ip.response_body)
  # renovate: datasource=docker depName=debian
  debian_version = "13.6"
}

# Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zones" "domain_zones" {
  name = var.secret_domain
}

# OVH Public Cloud US Ingress VPS
data "ovh_cloud_project_images" "debian" {
  service_name = var.ovh_service_name
  region       = var.ovh_region
  os_type      = "linux"
}

data "ovh_cloud_project_flavors" "flavor" {
  service_name = var.ovh_service_name
  region       = var.ovh_region
  name_filter  = var.ovh_flavor_name
}

resource "ovh_cloud_project_ssh_key" "us_key" {
  service_name = var.ovh_service_name
  name         = "ingress-vps-us-key"
  public_key   = var.ssh_public_key
}

resource "terraform_data" "cloud_init_us" {
  input = {
    debian_version = local.debian_version
    user_data = templatefile("${path.module}/vps-cloud-init.yaml", {
      NETBIRD_SELFHOSTED_SETUP_KEY = var.netbird_selfhosted_setup_key
      NETBIRD_SELFHOSTED_MGMT_URL  = "https://nb.${var.secret_domain}"
      NETBIRD_RELAY_AUTH_SECRET    = var.netbird_relay_auth_secret
      SECRET_DOMAIN                = var.secret_domain
      HOME_IP                      = local.home_ip
      PROBE_HOSTNAME               = "vps-us.${var.secret_domain}"
      WG_PRIVATE_KEY               = var.peer_us_private_key
      WG_PEER_PUBLIC_KEY           = var.wg_public_key
      WG_ADDRESS                   = "10.13.13.10/32"
      NB_ADDR                      = "10.0.10.11"
    })
  }
}

resource "ovh_cloud_project_instance" "us_vps" {
  service_name   = var.ovh_service_name
  region         = var.ovh_region
  name           = "ingress-vps-us-ovh"
  billing_period = "hourly"

  flavor {
    flavor_id = tolist(data.ovh_cloud_project_flavors.flavor.flavors)[0].id
  }

  boot_from {
    image_id = [for img in data.ovh_cloud_project_images.debian.images : img.id if can(regex("^Debian ${split(".", local.debian_version)[0]}", img.name))][0]
  }

  network {
    public = true
  }

  ssh_key {
    name = ovh_cloud_project_ssh_key.us_key.name
  }

  user_data = terraform_data.cloud_init_us.output.user_data

  lifecycle {
    replace_triggered_by = [
      terraform_data.cloud_init_us
    ]
    postcondition {
      condition     = self.status == "ACTIVE"
      error_message = "OVH US VPS is not in ACTIVE state (current status: ${self.status})."
    }
  }
}

locals {
  ovh_us_ipv4 = try(
    [for addr in ovh_cloud_project_instance.us_vps.addresses : addr.ip if addr.version == 4][0],
    ""
  )
}

# US VPS direct A record
resource "cloudflare_dns_record" "vps_us" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-us.${var.secret_domain}"
  content = local.ovh_us_ipv4
  type    = "A"
  proxied = false
  ttl     = 1
}

# Proxy IPv4 A record for US VPS
resource "cloudflare_dns_record" "proxy_us" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = local.ovh_us_ipv4
  type    = "A"
  proxied = false
  ttl     = 1
}

# Output US VPS public IP
output "VPS_US_PUBLIC_IP" {
  value       = local.ovh_us_ipv4
  description = "The public IPv4 address of the US OVHcloud Ingress VPS"
}

# Wait for cloud-init and Traefik service readiness on US VPS before concluding apply
data "http" "vps_us_healthcheck" {
  url      = "https://vps-us.${var.secret_domain}"
  insecure = true
  retry {
    attempts     = 36
    min_delay_ms = 5000
    max_delay_ms = 10000
  }
  lifecycle {
    postcondition {
      condition     = self.status_code < 500
      error_message = "US Ingress VPS failed health check after cloud-init (HTTP status: ${self.status_code})."
    }
  }
  depends_on = [
    ovh_cloud_project_instance.us_vps,
    cloudflare_dns_record.vps_us
  ]
}

# Sync US VPS public IP to flux-system secret for Kustomization postBuild substitution
resource "kubernetes_secret_v1" "vps_us_output_flux" {
  metadata {
    name      = "vps-us-output"
    namespace = "flux-system"
  }

  data = {
    VPS_US_PUBLIC_IP = local.ovh_us_ipv4
  }

  depends_on = [
    data.http.vps_us_healthcheck
  ]
}
