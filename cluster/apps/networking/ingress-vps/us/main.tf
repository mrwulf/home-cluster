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
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
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

# Read the cluster's cert-manager-issued wildcard cert so TF can push it to the
# VPS whenever it renews, without that being part of the (replace-triggering)
# instance user_data.
data "kubernetes_secret_v1" "wildcard_cert" {
  metadata {
    name      = "wildcard-${replace(var.secret_domain, ".", "-")}-tls"
    namespace = "networking"
  }
}

# Dedicated automation keypair for TF-driven post-boot provisioning (cert/whitelist
# pushes). Kept separate from var.ssh_public_key, which remains the human/break-glass key.
resource "tls_private_key" "tf_admin" {
  algorithm = "ED25519"
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
      PROBE_HOSTNAME               = "vps-us.${var.secret_domain}"
      WG_PRIVATE_KEY               = var.peer_us_private_key
      WG_PEER_PUBLIC_KEY           = var.wg_public_key
      WG_ADDRESS                   = "10.13.13.10/32"
      NB_ADDR                      = "10.0.10.11"
      SSH_PUBLIC_KEY               = var.ssh_public_key
      TF_ADMIN_SSH_PUBLIC_KEY      = tls_private_key.tf_admin.public_key_openssh
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

# Proxy IPv4 A record for US VPS. Shared name with the EU stack's own record below
# (each region's own Terraform state independently manages its own record; Cloudflare
# adds both under the same name rather than one overwriting the other) — this gives a
# real round-robin RRset so clients can race both regions and land on whichever
# responds first, when both happen to be healthy.
resource "cloudflare_dns_record" "proxy_us" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = local.ovh_us_ipv4
  type    = "A"
  proxied = false
  ttl     = 1
}

# Note: no separate region-specific "proxy-us" record — vps-us.${domain} below already
# is one (single IP, same content), so the failover workers just target that directly.

# Output US VPS public IP
output "VPS_US_PUBLIC_IP" {
  value       = local.ovh_us_ipv4
  description = "The public IPv4 address of the US OVHcloud Ingress VPS"
}

# Wait for cloud-init and Traefik service readiness on US VPS before concluding apply
data "http" "vps_us_healthcheck" {
  url      = "https://vps-us.${var.secret_domain}"
  insecure = true
  # 90 attempts x up to 10s gives cloud-init a ~15m budget to finish (apt/docker pulls,
  # netbird's own 10x5s connect retry, crowdsec's apt repo setup) before Terraform gives
  # up; 36 attempts (~6m) was observed to be too tight on a cold boot and made a healthy
  # rebuild look like a failed apply.
  retry {
    attempts     = 90
    min_delay_ms = 5000
    max_delay_ms = 10000
  }
  lifecycle {
    postcondition {
      condition     = self.status_code == 418
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

# Push the current cert-manager wildcard cert to the VPS and reload Traefik.
# Triggered only by cert content, so a renewal never touches user_data / replaces the instance.
resource "null_resource" "cert_sync" {
  triggers = {
    cert_hash = sha256(join("", [
      data.kubernetes_secret_v1.wildcard_cert.data["tls.crt"],
      data.kubernetes_secret_v1.wildcard_cert.data["tls.key"],
    ]))
    # Also re-run whenever the instance itself gets replaced (e.g. a debian_version bump)
    # even if the cert content hasn't changed - otherwise the new box is stuck on its
    # bootstrap self-signed cert forever, since cert_hash alone never changes on its own.
    instance_id = ovh_cloud_project_instance.us_vps.id
  }

  connection {
    type        = "ssh"
    host        = local.ovh_us_ipv4
    user        = "debian"
    private_key = tls_private_key.tf_admin.private_key_openssh
    timeout     = "2m"
  }

  provisioner "file" {
    content     = data.kubernetes_secret_v1.wildcard_cert.data["tls.crt"]
    destination = "/tmp/tls.crt"
  }

  provisioner "file" {
    content     = data.kubernetes_secret_v1.wildcard_cert.data["tls.key"]
    destination = "/tmp/tls.key"
  }

  provisioner "remote-exec" {
    inline = [
      "sudo install -o root -g root -m 0644 /tmp/tls.crt /etc/traefik/certs/tls.crt",
      "sudo install -o root -g root -m 0600 /tmp/tls.key /etc/traefik/certs/tls.key",
      "rm -f /tmp/tls.crt /tmp/tls.key",
      "sudo systemctl restart traefik",
    ]
  }

  depends_on = [
    data.http.vps_us_healthcheck
  ]
}

# Push the current home egress IP into CrowdSec's whitelist and reload it in place.
# Triggered only by home_ip, so a residential IP change never touches user_data / replaces the instance.
resource "null_resource" "home_ip_whitelist_sync" {
  triggers = {
    home_ip = local.home_ip
    # Also re-run whenever the instance itself gets replaced - see the matching note on
    # cert_sync's instance_id trigger above.
    instance_id = ovh_cloud_project_instance.us_vps.id
  }

  connection {
    type        = "ssh"
    host        = local.ovh_us_ipv4
    user        = "debian"
    private_key = tls_private_key.tf_admin.private_key_openssh
    timeout     = "2m"
  }

  provisioner "file" {
    content     = <<-EOF
      name: local/whitelist
      description: "Whitelist trusted IPs and internal networks"
      filter: "1 == 1"
      whitelist:
        reason: "Whitelisted home IP and internal overlay networks"
        ip:
          - "${local.home_ip}"
          - "127.0.0.1"
          - "::1"
        cidr:
          - "100.64.0.0/10"
          - "10.0.0.0/8"
          - "172.16.0.0/12"
          - "192.168.0.0/16"
    EOF
    destination = "/tmp/00-whitelist.yaml"
  }

  provisioner "remote-exec" {
    inline = [
      "sudo install -o root -g root -m 0644 /tmp/00-whitelist.yaml /etc/crowdsec/parsers/s02-enrich/00-whitelist.yaml",
      "rm -f /tmp/00-whitelist.yaml",
      "sudo docker exec crowdsec kill -SIGHUP 1",
    ]
  }

  depends_on = [
    data.http.vps_us_healthcheck
  ]
}
