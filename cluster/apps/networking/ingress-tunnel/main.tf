variable "hcloud_token" { type = string }
variable "CLOUDFLARE_APIKEY" { type = string }
variable "cloudflare_tunnel_cname" { type = string }
variable "secret_domain" { type = string }
variable "tunnel_handshake_token" { type = string }
variable "smtp_server" { type = string }
variable "smtp_username" { type = string }
variable "smtp_password" { type = string }


terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.CLOUDFLARE_APIKEY
}

# Fetch home public IP dynamically for firewall rules
data "http" "home_ip" {
  url = "https://api.ipify.org"
}

locals {
  home_ip_cidr = "${chomp(data.http.home_ip.response_body)}/32"
}

# 1. Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zone" "domain_zone" {
  name = var.secret_domain
}

# 2. Look up all available SSH keys in the Hetzner Cloud project
data "hcloud_ssh_keys" "all_keys" {}

# 3. Create the Hetzner Server (IPv4 enabled, IPv6 disabled)
resource "hcloud_server" "tunnel_vps" {
  name        = "ingress-tunnel-vps"
  # renovate: datasource=docker depName=debian
  image       = "debian-12"
  server_type = "cx23"
  location    = "nbg1" # Nuremberg, Germany (Includes 20TB traffic limit)
  ssh_keys    = data.hcloud_ssh_keys.all_keys.ssh_keys[*].id

  public_net {
    ipv4_enabled = true
    ipv6_enabled = false
  }

  user_data = templatefile("${path.module}/vps-cloud-init.yaml", {
    TUNNEL_HANDSHAKE_TOKEN = var.tunnel_handshake_token
  })
}

# 3. Create Declarative Firewall for the Server (Allow 22 & 8080 to home IP, 443 to all)
resource "hcloud_firewall" "tunnel_firewall" {
  name = "ingress-tunnel-firewall"

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = [local.home_ip_cidr]
    description = "Allow SSH from home only"
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
    port        = "8080"
    source_ips  = [local.home_ip_cidr]
    description = "Allow tunnel control channel from home only"
  }
}

# 4. Attach Firewall to the VPS Server
resource "hcloud_firewall_attachment" "firewall_attach" {
  firewall_id = hcloud_firewall.tunnel_firewall.id
  server_ids  = [hcloud_server.tunnel_vps.id]
}

# 5. Create the Primary DNS Record (CNAME pointing to direct VPS domain)
resource "cloudflare_record" "ingress" {
  zone_id = data.cloudflare_zone.domain_zone.id
  name    = "ingress"
  value   = cloudflare_record.vps_direct.hostname
  type    = "CNAME"
  proxied = false

  lifecycle {
    ignore_changes = [
      value,
      type,
    ]
  }
}

# 5b. Create the Direct DNS Record (always pointing to VPS IP)
resource "cloudflare_record" "vps_direct" {
  zone_id = data.cloudflare_zone.domain_zone.id
  name    = "vps-direct"
  value   = hcloud_server.tunnel_vps.ipv4_address
  type    = "A"
  proxied = false
}

# 6. Deploy the Cloudflare Worker Script & Bindings Declaratively
resource "cloudflare_workers_script" "failover_monitor" {
  account_id = data.cloudflare_zone.domain_zone.account_id
  name       = "ingress-tunnel-failover-monitor"
  content    = file("${path.module}/failover-monitor.js")
  module     = true

  plain_text_binding {
    name = "VPS_PUBLIC_IP"
    text = hcloud_server.tunnel_vps.ipv4_address
  }
  plain_text_binding {
    name = "VPS_DIRECT_HOST"
    text = cloudflare_record.vps_direct.hostname
  }
  plain_text_binding {
    name = "TUNNEL_CNAME"
    text = var.cloudflare_tunnel_cname
  }
  plain_text_binding {
    name = "CLOUDFLARE_ZONE_ID"
    text = data.cloudflare_zone.domain_zone.id
  }
  plain_text_binding {
    name = "CLOUDFLARE_RECORD_ID"
    text = cloudflare_record.ingress.id
  }
  plain_text_binding {
    name = "RECORD_NAME"
    text = "ingress.${var.secret_domain}"
  }
  plain_text_binding {
    name = "SMTP_SERVER"
    text = var.smtp_server
  }
  plain_text_binding {
    name = "SMTP_USERNAME"
    text = var.smtp_username
  }

  secret_text_binding {
    name = "CLOUDFLARE_API_TOKEN"
    text = var.CLOUDFLARE_APIKEY
  }
  secret_text_binding {
    name = "SMTP_PASSWORD"
    text = var.smtp_password
  }
}

# 7. Create the Cron Trigger for the Worker (runs every minute)
resource "cloudflare_workers_cron_trigger" "failover_cron" {
  account_id  = data.cloudflare_zone.domain_zone.account_id
  script_name = cloudflare_workers_script.failover_monitor.name
  schedules   = ["* * * * *"]
}

# 8. Output VPS public IP to expose it to tf-controller
output "VPS_PUBLIC_IP" {
  value       = hcloud_server.tunnel_vps.ipv4_address
  description = "The public IPv4 address of the Ingress Tunnel VPS"
}
