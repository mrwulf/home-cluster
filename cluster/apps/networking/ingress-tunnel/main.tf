variable "hcloud_token" {
  type      = string
  sensitive = true
}
variable "CLOUDFLARE_APIKEY" {
  type      = string
  sensitive = true
}
variable "cloudflare_tunnel_cname" {
  type      = string
  sensitive = true
}
variable "secret_domain" {
  type      = string
  sensitive = true
}
variable "tunnel_handshake_token" {
  type      = string
  sensitive = true
}
variable "smtp_server" {
  type      = string
  sensitive = true
}
variable "smtp_username" {
  type      = string
  sensitive = true
}
variable "smtp_password" {
  type      = string
  sensitive = true
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

# Fetch home public IP dynamically for firewall rules
data "http" "home_ip" {
  url = "https://api.ipify.org"
}

locals {
  home_ip_cidr = "${chomp(data.http.home_ip.response_body)}/32"
}

# 1. Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zones" "domain_zones" {
  name = var.secret_domain
}

# 2. Look up all available SSH keys in the Hetzner Cloud project
data "hcloud_ssh_keys" "all_keys" {}

# 3. Create the Hetzner Server (IPv4 enabled, IPv6 disabled)
resource "hcloud_server" "tunnel_vps" {
  name        = "ingress-tunnel-vps"
  # renovate: datasource=docker depName=debian
  image       = "debian-13"
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

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "7500"
    source_ips  = [local.home_ip_cidr]
    description = "Allow dashboard and metrics scraping from home only"
  }
}

# 4. Attach Firewall to the VPS Server
resource "hcloud_firewall_attachment" "firewall_attach" {
  firewall_id = hcloud_firewall.tunnel_firewall.id
  server_ids  = [hcloud_server.tunnel_vps.id]
}

# 5. Create the Primary DNS Record (CNAME pointing to direct VPS domain)
resource "cloudflare_dns_record" "ingress" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "ingress.${var.secret_domain}"
  content = "vps-direct.${var.secret_domain}"
  type    = "CNAME"
  proxied = false
  ttl     = 1

  lifecycle {
    ignore_changes = [
      content,
      type,
    ]
  }
}

# 5b. Create the Direct DNS Record (always pointing to VPS IP)
resource "cloudflare_dns_record" "vps_direct" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-direct.${var.secret_domain}"
  content = hcloud_server.tunnel_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# 6. Deploy the Cloudflare Worker Script & Bindings Declaratively
resource "cloudflare_workers_script" "failover_monitor" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = "ingress-tunnel-failover-monitor"
  content     = file("${path.module}/failover-monitor.js")
  main_module = "failover-monitor.js"

  bindings = [
    {
      name = "VPS_PUBLIC_IP"
      type = "plain_text"
      text = hcloud_server.tunnel_vps.ipv4_address
    },
    {
      name = "VPS_DIRECT_HOST"
      type = "plain_text"
      text = "vps-direct.${var.secret_domain}"
    },
    {
      name = "TUNNEL_CNAME"
      type = "plain_text"
      text = var.cloudflare_tunnel_cname
    },
    {
      name = "CLOUDFLARE_ZONE_ID"
      type = "plain_text"
      text = data.cloudflare_zones.domain_zones.result[0].id
    },
    {
      name = "CLOUDFLARE_RECORD_ID"
      type = "plain_text"
      text = cloudflare_dns_record.ingress.id
    },
    {
      name = "RECORD_NAME"
      type = "plain_text"
      text = "ingress.${var.secret_domain}"
    },
    {
      name = "SMTP_SERVER"
      type = "plain_text"
      text = var.smtp_server
    },
    {
      name = "SMTP_USERNAME"
      type = "plain_text"
      text = var.smtp_username
    },
    {
      name = "CLOUDFLARE_API_TOKEN"
      type = "secret_text"
      text = var.CLOUDFLARE_APIKEY
    },
    {
      name = "SMTP_PASSWORD"
      type = "secret_text"
      text = var.smtp_password
    }
  ]
}

# 7. Create the Cron Trigger for the Worker (runs every minute)
resource "cloudflare_workers_cron_trigger" "failover_cron" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = cloudflare_workers_script.failover_monitor.script_name
  schedules = [
    {
      cron = "* * * * *"
    }
  ]
}

# 8. Output VPS public IP to expose it to tf-controller
output "VPS_PUBLIC_IP" {
  value       = hcloud_server.tunnel_vps.ipv4_address
  description = "The public IPv4 address of the Ingress Tunnel VPS"
}

provider "kubernetes" {}

resource "kubernetes_endpoints" "frps_dashboard" {
  metadata {
    name      = "frps-dashboard"
    namespace = "networking"
  }

  subset {
    address {
      ip = hcloud_server.tunnel_vps.ipv4_address
    }

    port {
      name     = "http"
      port     = 7500
      protocol = "TCP"
    }
  }
}
