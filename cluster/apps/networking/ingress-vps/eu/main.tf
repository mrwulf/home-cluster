variable "hcloud_token" {
  type      = string
  sensitive = true
}
variable "CLOUDFLARE_APIKEY" {
  type      = string
  sensitive = true
}
variable "secret_domain" {
  type      = string
  sensitive = true
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
variable "peer_eu_private_key" {
  type      = string
  sensitive = true
  default   = ""
}
variable "peer_eu_public_key" {
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
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
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

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.CLOUDFLARE_APIKEY
}

provider "kubernetes" {}

# Fetch home public IP dynamically for firewall rules and cloud-init
data "http" "home_ip" {
  url = "https://api.ipify.org"
}

locals {
  home_ip      = chomp(data.http.home_ip.response_body)
  home_ip_cidr = "${local.home_ip}/32"
  # renovate: datasource=docker depName=debian
  debian_version = "13.6"
}

# Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zones" "domain_zones" {
  name = var.secret_domain
}

# Hetzner Cloud EU Ingress VPS
data "hcloud_ssh_keys" "all_keys" {}

resource "terraform_data" "cloud_init_eu" {
  input = {
    debian_version = local.debian_version
    user_data = templatefile("${path.module}/vps-cloud-init.yaml", {
      NETBIRD_SELFHOSTED_SETUP_KEY = var.netbird_selfhosted_setup_key
      NETBIRD_SELFHOSTED_MGMT_URL  = "https://nb.${var.secret_domain}"
      NETBIRD_RELAY_AUTH_SECRET    = var.netbird_relay_auth_secret
      SECRET_DOMAIN                = var.secret_domain
      HOME_IP                      = local.home_ip
      PROBE_HOSTNAME               = "vps-eu.${var.secret_domain}"
      WG_PRIVATE_KEY               = var.peer_eu_private_key
      WG_PEER_PUBLIC_KEY           = var.wg_public_key
      WG_ADDRESS                   = "10.13.13.11/32"
      NB_ADDR                      = "10.0.10.11"
    })
  }
}

resource "hcloud_server" "eu_vps" {
  name        = "ingress-vps-eu-hetzner"
  image       = "debian-${split(".", local.debian_version)[0]}"
  server_type = "cx23"
  location    = "nbg1" # Nuremberg, Germany (Includes 20TB traffic limit)
  ssh_keys    = data.hcloud_ssh_keys.all_keys.ssh_keys[*].id

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  user_data = terraform_data.cloud_init_eu.output.user_data

  lifecycle {
    replace_triggered_by = [
      terraform_data.cloud_init_eu
    ]
    postcondition {
      condition     = self.status == "running"
      error_message = "Hetzner EU VPS is not in running state (current status: ${self.status})."
    }
  }
}

# Declarative Firewall for EU Server
resource "hcloud_firewall" "eu_firewall" {
  name = "ingress-vps-eu-firewall"

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = [local.home_ip_cidr, "172.56.0.0/16", "75.50.127.0/24"]
    description = "Allow SSH from home and workstation"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow HTTP public proxy / ACME challenge traffic"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow HTTPS public proxy traffic"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "8082"
    source_ips  = [local.home_ip_cidr, "172.56.0.0/16", "75.50.127.0/24", "100.64.0.0/10"]
    description = "Allow Traefik metrics scraping from home and cluster"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "9091"
    source_ips  = [local.home_ip_cidr, "172.56.0.0/16", "75.50.127.0/24", "100.64.0.0/10"]
    description = "Allow NetBird Relay metrics scraping from home and cluster"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "9100"
    source_ips  = [local.home_ip_cidr, "172.56.0.0/16", "75.50.127.0/24", "100.64.0.0/10"]
    description = "Allow Node Exporter metrics scraping from home and cluster"
  }

  rule {
    direction   = "in"
    protocol    = "udp"
    port        = "51822"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow NetBird Self-Hosted WireGuard P2P UDP overlay traffic"
  }

  rule {
    direction   = "in"
    protocol    = "udp"
    port        = "3478"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow NetBird STUN NAT discovery traffic"
  }

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "33073"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow NetBird Relay WebSocket TCP transport traffic"
  }

  rule {
    direction   = "in"
    protocol    = "udp"
    port        = "33073"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "Allow NetBird Relay QUIC UDP transport traffic"
  }
}

# Attach Firewall to EU Server
resource "hcloud_firewall_attachment" "eu_firewall_attach" {
  firewall_id = hcloud_firewall.eu_firewall.id
  server_ids  = [hcloud_server.eu_vps.id]
}

# EU VPS direct A record
resource "cloudflare_dns_record" "vps_eu" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-eu.${var.secret_domain}"
  content = hcloud_server.eu_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# Proxy IPv4 A record for EU VPS
resource "cloudflare_dns_record" "proxy_eu" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = hcloud_server.eu_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# Output EU VPS public IP
output "VPS_EU_PUBLIC_IP" {
  value       = hcloud_server.eu_vps.ipv4_address
  description = "The public IPv4 address of the EU Hetzner Ingress VPS"
}

# Wait for cloud-init and Traefik service readiness on EU VPS before concluding apply
data "http" "vps_eu_healthcheck" {
  url      = "https://vps-eu.${var.secret_domain}"
  insecure = true
  retry {
    attempts     = 36
    min_delay_ms = 5000
    max_delay_ms = 10000
  }
  lifecycle {
    postcondition {
      condition     = self.status_code == 418
      error_message = "EU Ingress VPS failed health check after cloud-init (HTTP status: ${self.status_code})."
    }
  }
  depends_on = [
    hcloud_server.eu_vps,
    cloudflare_dns_record.vps_eu
  ]
}

# Sync EU VPS public IP to flux-system secret for Kustomization postBuild substitution
resource "kubernetes_secret_v1" "vps_eu_output_flux" {
  metadata {
    name      = "vps-eu-output"
    namespace = "flux-system"
  }

  data = {
    VPS_EU_PUBLIC_IP = hcloud_server.eu_vps.ipv4_address
  }

  depends_on = [
    data.http.vps_eu_healthcheck
  ]
}
