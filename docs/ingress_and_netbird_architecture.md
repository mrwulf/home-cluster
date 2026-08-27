# Edge Ingress & NetBird Mesh Architecture & Operations Guide

This document provides an operational, architectural, and troubleshooting guide
for the **Edge Ingress VPS Nodes**, **Self-Hosted NetBird Mesh & Control Plane**,
and **Dynamic Cloudflare Failover** infrastructure in `home-cluster`.

---

## 1. Overview & Architectural Vision

The cluster ingress infrastructure provides highly available, secure, and
performant public and private ingress without requiring public port forwarding
at the home gateway.

```mermaid
graph TD
    User["Public Traffic"] --> DNS["Cloudflare DNS"]
    DNS -->|Public Services| IngressCNAME["ingress.domain"]

    subgraph FailoverEngine["Failover Monitor Worker"]
        IngressCNAME -->|Healthy VPS| ProxyTarget["proxy.domain (Direct A)"]
        IngressCNAME -->|Both Down| TunnelTarget["external.domain (CF Tunnel)"]
    end

    subgraph EdgeVPS["Dual Edge VPS Ingress Layer"]
        ProxyTarget --> OVH["OVH VPS (Primary)<br/>Traefik Edge SNI Proxy"]
        ProxyTarget --> Hetzner["Hetzner VPS (Backup)<br/>Traefik Edge SNI Proxy"]
    end

    subgraph OverlayMesh["Encrypted Private Transport"]
        OVH <-->|WireGuard wg0| K8sGW11["Traefik GW VIP 10.0.10.11:443"]
        OVH <-->|NetBird wt0| Router["NetworkRouter / k8s Peer"]
        Hetzner <-->|NetBird wt0| Router
        Router --> K8sGW20["Traefik GW VIP 10.0.10.20:443"]
    end

    subgraph K8sCluster["Kubernetes Cluster (networking namespace)"]
        K8sGW11 --> TraefikPods["Traefik Ingress Controller"]
        K8sGW20 --> TraefikPods
        TunnelTarget --> CFTunnelPod["Cloudflare Tunnel Connector"]
        CFTunnelPod --> TraefikPods

        TraefikPods --> AppHTTPRoutes["HTTPRoutes / Workloads"]

        subgraph ControlPlane["NetBird Control Plane"]
            Mgmt["NetBird Management (:8080)"]
            Signal["NetBird Signal (:10000)"]
            Dash["NetBird Dashboard"]
            PocketID["Pocket ID SSO"] --> Mgmt
        end
    end
```

---

## 2. Multi-Tier Failover Hierarchy

Traffic routing follows a strict, zero-downtime failover model:

| Tier                  | Path                                              | Description                                                                      | DNS              |
| :-------------------- | :------------------------------------------------ | :------------------------------------------------------------------------------- | :--------------- |
| **Tier 1 (Edge VPS)** | `ingress.domain` ➔ `proxy.domain` ➔ OVH & Hetzner | Requests hit edge VPS nodes; Traefik forwards TLS over WireGuard / NetBird mesh. | `proxied: false` |
| **Tier 2 (Fallback)** | `ingress.domain` ➔ `external.domain` (CF Tunnel)  | If both VPS nodes fail probes, Worker switches `ingress.domain` to Tunnel.       | `proxied: true`  |

### 2.1 Cloudflare Failover Monitor Worker (`failover-monitor.js`)

Deployed declaratively via OpenTofu (`cloudflare_workers_script.failover_monitor`)
and triggered every minute (`cloudflare_workers_cron_trigger.failover_cron`):

1. **Active Probing**:
   - Probes `https://vps-us.${SECRET_DOMAIN}` (OVH US).
   - Probes `https://vps-eu.${SECRET_DOMAIN}` (Hetzner EU).
   - _Why direct hostnames are probed_: Probing `proxy.${SECRET_DOMAIN}` directly
     would round-robin across both VPS nodes and mask single-node outages.
     Probing direct unproxied hostnames isolates individual node health.
2. **Decision Engine**:
   - If either VPS is healthy (`status < 500`): sets `ingress.${SECRET_DOMAIN}`
     CNAME to `proxy.${SECRET_DOMAIN}` (`proxied: false`).
   - If both VPS nodes are unhealthy: patches `ingress.${SECRET_DOMAIN}`
     CNAME to `external.${SECRET_DOMAIN}` (`proxied: true`).
3. **Alerting**:
   - On state transitions, sends an SMTP notification via Mailgun to
     `postmaster@${SECRET_DOMAIN}` containing attempt latency and HTTP diagnostics.

---

## 3. Kubernetes Gateway API & DNS Architecture

All external traffic enters the cluster via `Gateway/external-gateway` in the
`networking` namespace.

### 3.1 Gateway Configuration (`gateway.yaml`)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: external-gateway
  namespace: networking
  labels:
    gateway.home-operations.io/type: external
  annotations:
    external-dns.kubernetes.io/target: "ingress.${SECRET_DOMAIN}"
    gatus.io/endpoint: |
      group: external
      client:
        dns-resolver: "udp://1.1.1.1:53"
spec:
  gatewayClassName: traefik-external
  addresses:
    - type: IPAddress
      value: "10.0.10.20"
```

- **Unified Gateway**: Consolidates standard and high-bandwidth services (`plex`,
  `photos`, `backups`, `docs`, `sp`, `id`, `nb`, etc.) under a single Gateway.
- **Dynamic Ingress Resolution**: `external-dns.kubernetes.io/target: "ingress.${SECRET_DOMAIN}"`
  instructs `external-dns` to publish all attached `HTTPRoute` hostnames as
  unproxied CNAME records pointing to `ingress.${SECRET_DOMAIN}`.
- **Decoupled Architecture**: `external-dns` manages service CNAMEs (`service ➔ ingress`);
  the Cloudflare Worker exclusively manages `ingress ➔ proxy / external`. There
  is zero DNS thrashing or competition.
- **Label Filter Parity**: Uses `gateway.home-operations.io/type: external`
  (masking domain names in CR metadata).

### 3.2 Dual-VIP Binding (`traefik-external`)

Traefik External Service is allocated two distinct VIPs via Cilium BGP
(`io.cilium/lb-ipam-ips: "10.0.10.20,10.0.10.11"`):

- `10.0.10.11`: Direct WireGuard uplink interface for primary VPS edge transport.
- `10.0.10.20`: Primary external ingress VIP reachable across the NetBird mesh
  and LAN.

---

## 4. Self-Hosted NetBird Architecture (`nb.${SECRET_DOMAIN}`)

The NetBird control plane runs natively inside the cluster backed by CloudNativePG.

### 4.1 Subnet Allocation & CGNAT Compliance

- **Self-Hosted NetBird Subnet**: **`100.110.0.0/16`** (resides in RFC 6598
  Carrier-Grade NAT block `100.64.0.0/10`).
- **Cloud NetBird Subnet (Fallback)**: `100.100.0.0/16`.
- **LAN / Services**: `10.0.0.0/16`.

### 4.2 Control Plane Workloads

1. **`netbird-management`**:
   - Version: `docker.io/netbirdio/management:0.77.1` (tracked via Renovate).
   - Database: PostgreSQL (`postgres17-rw`).
   - IdP & Auth: Authenticates against Pocket ID (`https://id.${SECRET_DOMAIN}`)
     via PKCE and OIDC discovery. Auto-syncs users and groups.
   - Ports: `8080` (HTTP/gRPC API), `9090` (Prometheus metrics).
2. **`netbird-signal`**:
   - Version: `docker.io/netbirdio/signal:0.77.1` (port `10000`).
   - Provides WebRTC signaling for P2P connection negotiation.
3. **`netbird-dashboard`**:
   - Version: `docker.io/netbirdio/dashboard:v2.91.1`.
   - Web UI accessible at `https://nb.${SECRET_DOMAIN}`.
4. **`netbird-operator` & In-Cluster Routing**:
   - Operates in the `networking` namespace connected to
     `http://netbird-management.networking.svc.cluster.local:8080`.
   - Reconciles `NetworkRouter/k8s` (`networkrouter-k8s-*` pods in group
     `routing-peers`).
   - Advertises internal routes (`10.0.0.0/16`, `10.0.10.20/32`, `10.0.10.11/32`,
     `*.${SECRET_DOMAIN}`) to authorized peers.

---

## 5. Edge VPS Infrastructure & Services

Edge VPS nodes are provisioned with Debian 12 (Bookworm) via OpenTofu
(`cluster/apps/networking/ingress-vps/main.tf`) and initialized via
`vps-cloud-init.yaml`.

```text
Edge VPS Node
├── Traefik (:80, :443) -> SNI TLS Passthrough to 10.0.10.20:443
├── NetBird Relay & STUN (:3478/udp, :33073/tcp, :9091/metrics)
├── NetBird Client (wt0, 100.110.0.0/16, UDP 51822)
├── WireGuard Uplink (wg0 -> dynamic.${SECRET_DOMAIN}:51821)
├── CrowdSec LAPI & Container Engine
├── crowdsec-firewall-bouncer-nftables (Host packet filtering)
└── Node Exporter (:9100)
```

### 5.1 Security & Threat Mitigation (CrowdSec + nftables)

- **Edge Dropping**: `crowdsec-firewall-bouncer-nftables` runs natively on the
  host, querying the containerized CrowdSec LAPI.
- **Attack Parsing**: Parses Traefik container access logs and system SSH logs,
  automatically inserting offending IPs into nftables drop sets before traffic
  touches the tunnel.
- **Whitelists**: Whitelists home IPs, private RFC 1918 subnets, and NetBird
  CGNAT ranges (`100.64.0.0/10`).

### 5.2 Split-Horizon DNS & VPS Relay Invariant

- **Split-Horizon Invariant**: Wildcard DNS (`*.${SECRET_DOMAIN}`) resolves to
  `10.0.10.20` internally. In-cluster pods and LAN services cannot resolve
  public VPS IPs via internal DNS.
- **Remediation**: `NetworkRouter/k8s` configures declarative `hostAliases`
  mapping `vps-eu.${SECRET_DOMAIN}` and `vps-us.${SECRET_DOMAIN}`
  directly to their public IPs.
- **Relay Invariant**: NetBird Relay containers require
  `NB_EXPOSED_ADDRESS=rel://${PROBE_HOSTNAME}:33073` and `NB_AUTH_SECRET` matching
  `Relay.Secret` in `management.json`.

---

## 6. Verification & Troubleshooting Runbook

### 6.1 Testing Public Ingress Endpoints

Because split-horizon DNS resolves `*.${SECRET_DOMAIN}` to `10.0.10.20` locally,
always test public VPS ingress using `--resolve`:

```bash
# Test primary OVH VPS ingress
curl -Iv https://plex.${SECRET_DOMAIN} --resolve plex.${SECRET_DOMAIN}:443:40.160.4.4

# Test backup Hetzner VPS ingress
curl -Iv https://photos.${SECRET_DOMAIN} --resolve photos.${SECRET_DOMAIN}:443:94.130.99.118

# Test NetBird Control Plane through VPS
curl -Iv https://nb.${SECRET_DOMAIN} --resolve nb.${SECRET_DOMAIN}:443:40.160.4.4
```

### 6.2 Inspecting Edge VPS Services (SSH)

```bash
# Connect to Hetzner Backup VPS
ssh -i ~/.ssh/id_ed25519.personal debian@94.130.99.118

# Check services
systemctl status traefik netbird netbird-relay crowdsec
netbird status
docker ps
```

### 6.3 Checking Cloudflare Failover Status

```bash
# Query public DNS resolver for ingress and service targets
dig +short ingress.${SECRET_DOMAIN} @1.1.1.1
dig +short proxy.${SECRET_DOMAIN} @1.1.1.1
dig +short nb.${SECRET_DOMAIN} @1.1.1.1
```
