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
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.CLOUDFLARE_APIKEY
}

# 1. Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zones" "domain_zones" {
  name = var.secret_domain
}

# 2. Fast-path CNAME: Cloudflare Tunnel by default, VPS as a degraded fallback.
#    Every externally-exposed app is on this record unless it explicitly overrides
#    external-dns.kubernetes.io/target back to ingress.${secret_domain} (see the
#    external-gateway default in cluster/apps/networking/traefik/external/gateway.yaml).
resource "cloudflare_dns_record" "fast" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "fast.${var.secret_domain}"
  content = var.cloudflare_tunnel_cname
  type    = "CNAME"
  proxied = true
  ttl     = 1

  lifecycle {
    ignore_changes = [
      content,
      proxied,
    ]
  }
}

# 3. Deploy the Cloudflare Worker Script & Bindings Declaratively
resource "cloudflare_workers_script" "fast_failover_monitor" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = "fast-ingress-failover-monitor"
  content     = file("${path.module}/fast-failover-monitor.js")
  main_module = "fast-failover-monitor.js"

  bindings = [
    {
      name = "TUNNEL_HOST"
      type = "plain_text"
      text = "external.${var.secret_domain}"
    },
    {
      name = "TUNNEL_CNAME"
      type = "plain_text"
      text = var.cloudflare_tunnel_cname
    },
    {
      name = "VPS_US_HOST"
      type = "plain_text"
      text = "vps-us.${var.secret_domain}"
    },
    {
      name = "VPS_EU_HOST"
      type = "plain_text"
      text = "vps-eu.${var.secret_domain}"
    },
    {
      name = "PROXY_US_CNAME"
      type = "plain_text"
      text = "proxy-us.${var.secret_domain}"
    },
    {
      name = "PROXY_EU_CNAME"
      type = "plain_text"
      text = "proxy-eu.${var.secret_domain}"
    },
    {
      name = "CLOUDFLARE_ZONE_ID"
      type = "plain_text"
      text = data.cloudflare_zones.domain_zones.result[0].id
    },
    {
      name = "CLOUDFLARE_RECORD_ID"
      type = "plain_text"
      text = cloudflare_dns_record.fast.id
    },
    {
      name = "RECORD_NAME"
      type = "plain_text"
      text = "fast.${var.secret_domain}"
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

# 4. Create the Cron Trigger for the Worker (runs every minute)
resource "cloudflare_workers_cron_trigger" "fast_failover_cron" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = cloudflare_workers_script.fast_failover_monitor.script_name
  schedules = [
    {
      cron = "* * * * *"
    }
  ]
}
