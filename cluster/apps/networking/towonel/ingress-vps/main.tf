variable "hcloud_token" {
  type      = string
  sensitive = true
}
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
variable "netbird_proxy_token" {
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

provider "ovh" {
  endpoint           = var.ovh_endpoint
  application_key    = var.ovh_application_key
  application_secret = var.ovh_application_secret
  consumer_key       = var.ovh_consumer_key
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.CLOUDFLARE_APIKEY
}

provider "kubernetes" {}

# Fetch home public IP dynamically for firewall rules
data "http" "home_ip" {
  url = "https://api.ipify.org"
}

locals {
  home_ip      = chomp(data.http.home_ip.response_body)
  home_ip_cidr = "${local.home_ip}/32"
}

# 1. Look up Cloudflare Zone details dynamically using domain name
data "cloudflare_zones" "domain_zones" {
  name = var.secret_domain
}

# 2. OVH Public Cloud Primary Ingress VPS
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

resource "ovh_cloud_project_ssh_key" "primary_key" {
  service_name = var.ovh_service_name
  name         = "ingress-tunnel-key"
  public_key   = data.hcloud_ssh_keys.all_keys.ssh_keys[0].public_key
}

resource "terraform_data" "cloud_init_primary" {
  input = templatefile("${path.module}/vps-cloud-init.yaml", {
    NETBIRD_SELFHOSTED_SETUP_KEY = var.netbird_selfhosted_setup_key
    NETBIRD_SELFHOSTED_MGMT_URL  = "https://nb.${var.secret_domain}"
    NETBIRD_RELAY_AUTH_SECRET    = var.netbird_relay_auth_secret
    NETBIRD_PROXY_TOKEN          = var.netbird_proxy_token
    SECRET_DOMAIN                = var.secret_domain
    HOME_IP                      = local.home_ip
    PROBE_HOSTNAME               = "vps-primary.${var.secret_domain}"
  })
}

resource "ovh_cloud_project_instance" "primary_vps" {
  service_name   = var.ovh_service_name
  region         = var.ovh_region
  name           = "ingress-tunnel-primary-ovh"
  billing_period = "hourly"

  flavor {
    flavor_id = tolist(data.ovh_cloud_project_flavors.flavor.flavors)[0].id
  }

  boot_from {
    image_id = [for img in data.ovh_cloud_project_images.debian.images : img.id if can(regex("Debian 12|Debian 13", img.name))][0]
  }

  network {
    public = true
  }

  ssh_key {
    name = ovh_cloud_project_ssh_key.primary_key.name
  }

  user_data = terraform_data.cloud_init_primary.output

  lifecycle {
    replace_triggered_by = [
      terraform_data.cloud_init_primary
    ]
  }
}

locals {
  ovh_primary_ipv4 = try(
    [for addr in ovh_cloud_project_instance.primary_vps.addresses : addr.ip if addr.version == 4][0],
    ""
  )
  ovh_primary_ipv6 = try(
    [for addr in ovh_cloud_project_instance.primary_vps.addresses : addr.ip if addr.version == 6][0],
    ""
  )
}

# 3. Hetzner Cloud Backup Ingress VPS
data "hcloud_ssh_keys" "all_keys" {}

resource "terraform_data" "cloud_init_backup" {
  input = templatefile("${path.module}/vps-cloud-init.yaml", {
    NETBIRD_SELFHOSTED_SETUP_KEY = var.netbird_selfhosted_setup_key
    NETBIRD_SELFHOSTED_MGMT_URL  = "https://nb.${var.secret_domain}"
    NETBIRD_RELAY_AUTH_SECRET    = var.netbird_relay_auth_secret
    NETBIRD_PROXY_TOKEN          = var.netbird_proxy_token
    SECRET_DOMAIN                = var.secret_domain
    HOME_IP                      = local.home_ip
    PROBE_HOSTNAME               = "vps-backup.${var.secret_domain}"
  })
}

resource "hcloud_server" "backup_vps" {
  name = "ingress-tunnel-backup-hetzner"
  # renovate: datasource=docker depName=debian
  image       = "debian-13"
  server_type = "cx23"
  location    = "nbg1" # Nuremberg, Germany (Includes 20TB traffic limit)
  ssh_keys    = data.hcloud_ssh_keys.all_keys.ssh_keys[*].id

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  user_data = terraform_data.cloud_init_backup.output

  lifecycle {
    replace_triggered_by = [
      terraform_data.cloud_init_backup
    ]
  }
}

# 4. Create Declarative Firewall for the Backup Server (Allow 22 & 9090 to home IP, 443 to all)
resource "hcloud_firewall" "backup_firewall" {
  name = "ingress-tunnel-backup-firewall"

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
    port        = "9090"
    source_ips  = [local.home_ip_cidr, "172.56.0.0/16", "75.50.127.0/24"]
    description = "Allow metrics scraping from home only"
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

# Attach Firewall to the Backup Server
resource "hcloud_firewall_attachment" "backup_firewall_attach" {
  firewall_id = hcloud_firewall.backup_firewall.id
  server_ids  = [hcloud_server.backup_vps.id]
}

# 5. Create Cloudflare DNS Records
# Ingress CNAME (initially pointing to direct primary hostname)
resource "cloudflare_dns_record" "ingress" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "ingress.${var.secret_domain}"
  content = "vps-primary.${var.secret_domain}"
  type    = "CNAME"
  proxied = false
  ttl     = 1

  lifecycle {
    ignore_changes = [
      content,
      type,
      proxied,
    ]
  }
}

# NetBird Self-Hosted proxied DNS via Cloudflare Tunnel
resource "cloudflare_dns_record" "netbird_direct" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "nb.${var.secret_domain}"
  content = "external.${var.secret_domain}"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# Primary VPS direct A record
resource "cloudflare_dns_record" "vps_primary" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-primary.${var.secret_domain}"
  content = local.ovh_primary_ipv4
  type    = "A"
  proxied = false
  ttl     = 1
}

# Backup VPS direct A record
resource "cloudflare_dns_record" "vps_backup" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-backup.${var.secret_domain}"
  content = hcloud_server.backup_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# Backup VPS direct AAAA record
resource "cloudflare_dns_record" "vps_backup_v6" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "vps-backup.${var.secret_domain}"
  content = hcloud_server.backup_vps.ipv6_address
  type    = "AAAA"
  proxied = false
  ttl     = 1
}

# Proxy Cluster direct IPv4 A records
resource "cloudflare_dns_record" "proxy_primary_v4" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = local.ovh_primary_ipv4
  type    = "A"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "proxy_backup_v4" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = hcloud_server.backup_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# Proxy Cluster direct IPv6 AAAA record (Backup Hetzner VPS)
resource "cloudflare_dns_record" "proxy_backup_v6" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = hcloud_server.backup_vps.ipv6_address
  type    = "AAAA"
  proxied = false
  ttl     = 1
}

# Wildcard CNAME for *.proxy.${SECRET_DOMAIN} -> proxy.${SECRET_DOMAIN}
resource "cloudflare_dns_record" "proxy_wildcard" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "*.proxy.${var.secret_domain}"
  content = "proxy.${var.secret_domain}"
  type    = "CNAME"
  proxied = false
  ttl     = 1
}


# 6. Deploy the Cloudflare Worker Script & Bindings Declaratively
# resource "cloudflare_workers_script" "failover_monitor" {
#   account_id  = data.cloudflare_zones.domain_zones.result[0].account.id
#   script_name = "ingress-tunnel-failover-monitor"
#   content     = file("${path.module}/failover-monitor.js")
#   main_module = "failover-monitor.js"

#   bindings = [
#     {
#       name = "VPS_PRIMARY_HOST"
#       type = "plain_text"
#       text = "vps-primary.${var.secret_domain}"
#     },
#     {
#       name = "VPS_BACKUP_HOST"
#       type = "plain_text"
#       text = "vps-backup.${var.secret_domain}"
#     },
#     {
#       name = "TUNNEL_CNAME"
#       type = "plain_text"
#       text = var.cloudflare_tunnel_cname
#     },
#     {
#       name = "CLOUDFLARE_ZONE_ID"
#       type = "plain_text"
#       text = data.cloudflare_zones.domain_zones.result[0].id
#     },
#     {
#       name = "CLOUDFLARE_RECORD_ID"
#       type = "plain_text"
#       text = cloudflare_dns_record.ingress.id
#     },
#     {
#       name = "RECORD_NAME"
#       type = "plain_text"
#       text = "ingress.${var.secret_domain}"
#     },
#     {
#       name = "SMTP_SERVER"
#       type = "plain_text"
#       text = var.smtp_server
#     },
#     {
#       name = "SMTP_USERNAME"
#       type = "plain_text"
#       text = var.smtp_username
#     },
#     {
#       name = "CLOUDFLARE_API_TOKEN"
#       type = "secret_text"
#       text = var.CLOUDFLARE_APIKEY
#     },
#     {
#       name = "SMTP_PASSWORD"
#       type = "secret_text"
#       text = var.smtp_password
#     }
#   ]
# }

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

# 8. Output VPS public IPs to expose to tf-controller
output "VPS_PRIMARY_PUBLIC_IP" {
  value       = local.ovh_primary_ipv4
  description = "The public IPv4 address of the Primary OVHcloud Ingress VPS"
}

output "VPS_BACKUP_PUBLIC_IP" {
  value       = hcloud_server.backup_vps.ipv4_address
  description = "The public IPv4 address of the Backup Hetzner Ingress VPS"
}

# 9. Sync VPS public IPs to flux-system secret for Kustomization postBuild substitution
resource "kubernetes_secret_v1" "vps_tunnel_output_flux" {
  metadata {
    name      = "vps-tunnel-output"
    namespace = "flux-system"
  }

  data = {
    VPS_PRIMARY_PUBLIC_IP = local.ovh_primary_ipv4
    VPS_BACKUP_PUBLIC_IP  = hcloud_server.backup_vps.ipv4_address
  }
}
