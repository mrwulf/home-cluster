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
# pushes). Kept separate from the human keys picked up via data.hcloud_ssh_keys below.
resource "tls_private_key" "tf_admin" {
  algorithm = "ED25519"
}

resource "hcloud_ssh_key" "tf_admin" {
  name       = "ingress-vps-eu-tf-admin-key"
  public_key = tls_private_key.tf_admin.public_key_openssh
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
      PROBE_HOSTNAME               = "vps-eu.${var.secret_domain}"
      WG_PRIVATE_KEY               = var.peer_eu_private_key
      WG_PEER_PUBLIC_KEY           = var.wg_public_key
      WG_ADDRESS                   = "10.13.13.11/32"
      NB_ADDR                      = "10.0.10.11"
      TF_ADMIN_SSH_PUBLIC_KEY      = tls_private_key.tf_admin.public_key_openssh
    })
  }
}

resource "hcloud_server" "eu_vps" {
  name        = "ingress-vps-eu-hetzner"
  image       = "debian-${split(".", local.debian_version)[0]}"
  server_type = "cx23"
  location    = "nbg1" # Nuremberg, Germany (Includes 20TB traffic limit)
  ssh_keys    = distinct(concat(data.hcloud_ssh_keys.all_keys.ssh_keys[*].id, [hcloud_ssh_key.tf_admin.id]))

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

# Proxy IPv4 A record for EU VPS (shared round-robin name: see note on proxy_us in us/main.tf)
resource "cloudflare_dns_record" "proxy_eu" {
  zone_id = data.cloudflare_zones.domain_zones.result[0].id
  name    = "proxy.${var.secret_domain}"
  content = hcloud_server.eu_vps.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 1
}

# Note: no separate region-specific "proxy-eu" record — vps-eu.${domain} below already
# is one (single IP, same content), so the failover workers just target that directly.

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
    instance_id = hcloud_server.eu_vps.id
  }

  connection {
    type        = "ssh"
    host        = hcloud_server.eu_vps.ipv4_address
    user        = "root"
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
      "install -o root -g root -m 0644 /tmp/tls.crt /etc/traefik/certs/tls.crt",
      "install -o root -g root -m 0600 /tmp/tls.key /etc/traefik/certs/tls.key",
      "rm -f /tmp/tls.crt /tmp/tls.key",
      "systemctl restart traefik",
    ]
  }

  depends_on = [
    data.http.vps_eu_healthcheck
  ]
}

# Push the current home egress IP into CrowdSec's whitelist and reload it in place.
# Triggered only by home_ip, so a residential IP change never touches user_data / replaces the instance.
resource "null_resource" "home_ip_whitelist_sync" {
  triggers = {
    home_ip = local.home_ip
    # Also re-run whenever the instance itself gets replaced - see the matching note on
    # cert_sync's instance_id trigger above.
    instance_id = hcloud_server.eu_vps.id
  }

  connection {
    type        = "ssh"
    host        = hcloud_server.eu_vps.ipv4_address
    user        = "root"
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
      "install -o root -g root -m 0644 /tmp/00-whitelist.yaml /etc/crowdsec/parsers/s02-enrich/00-whitelist.yaml",
      "rm -f /tmp/00-whitelist.yaml",
      "docker exec crowdsec kill -SIGHUP 1",
    ]
  }

  depends_on = [
    data.http.vps_eu_healthcheck
  ]
}
