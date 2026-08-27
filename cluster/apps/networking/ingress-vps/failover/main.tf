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

# 2. Ingress CNAME (pointing to proxy or failover tunnel)
resource "cloudflare_dns_record" "ingress" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "ingress.${var.secret_domain}"
  content = "proxy.${var.secret_domain}"
  type    = "CNAME"
  proxied = false
  ttl     = 1

  lifecycle {
    ignore_changes = [
      content,
      proxied,
    ]
  }
}

# 3. Deploy the Cloudflare Worker Script & Bindings Declaratively
resource "cloudflare_workers_script" "failover_monitor" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = "ingress-tunnel-failover-monitor"
  content     = file("${path.module}/failover-monitor.js")
  main_module = "failover-monitor.js"

  bindings = [
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
      name = "PROXY_CNAME"
      type = "plain_text"
      text = "proxy.${var.secret_domain}"
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

# 4. Create the Cron Trigger for the Worker (runs every minute)
resource "cloudflare_workers_cron_trigger" "failover_cron" {
  account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
  script_name = cloudflare_workers_script.failover_monitor.script_name
  schedules = [
    {
      cron = "* * * * *"
    }
  ]
}
