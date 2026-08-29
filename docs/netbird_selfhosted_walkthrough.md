# Self-Hosted NetBird Deployment & Migration Walkthrough

## Overview

This document tracks the live implementation status, empirical verification
results, and operational details for the self-hosted NetBird overlay stack
(`nb.${SECRET_DOMAIN}`) deployed in the `networking` namespace.

---

## Roadmap & Milestone Status

- **Phase 1: Control Plane Deployment**
  - **Status**: ✅ Complete & Verified
  - **Deliverables**: PocketID OIDC integration (`PocketIDOIDCClient`), NetBird
    Management with PostgreSQL backing, WebRTC Signal server, Web Dashboard,
    Traefik Gateway API routes (`HTTPRoute`), Prometheus scraping, and Gatus
    monitors.
- **Phase 2: Dual VPS NetBird Clients & Relays**
  - **Status**: ✅ Complete & Verified
  - **Deliverables**: OpenTofu IPv6 AAAA records, `netbird-selfhosted.service`
    (`wt1` on `100.110.0.0/16`), `netbird-relay` container with embedded STUN
    on VPS, `crowdsec-firewall-bouncer-nftables` upgrade, and VPS setup key
    enrollment.
- **Phase 3: Cluster Routing, Dual-Mesh Architecture & Operator Switch**
  - **Status**: ✅ Complete & Verified
  - **Deliverables**: Resolved upstream operator multi-instance watch collision,
    switched primary Kubernetes `netbird-operator` to manage Self-Hosted NetBird
    control plane (`http://netbird-management.networking.svc.cluster.local:8080`),
    deployed standalone `netbird-cloud-client` for Cloud NetBird fallback
    (`100.100.0.0/16`), and verified dual in-cluster routing peers.
- **Phase 4: NetBird BYOP Reverse Proxy Deployment (`proxy.${SECRET_DOMAIN}`)**
  - **Status**: ⏳ In Progress (Deployed & Reconciling)
  - **Deliverables**: Parameterized `netbirdio/reverse-proxy:0.77.1` systemd container
    service on dual VPS nodes, stripped Towonel and Cloud NetBird (`wt0`), enabled
    dual-STUN and dual-Relay geo-redundancy, configured Cloudflare DNS for
    `proxy.${SECRET_DOMAIN}` and `*.proxy.${SECRET_DOMAIN}`, and mapped
    `NB_PROXY_API_KEY` token.
- **Phase 5: Production Failover & Towonel Retirement**
  - **Status**: 📋 Planned
  - **Deliverables**: Direct public services migration (Plex, Immich, Restic),
    failover monitor update, 72-hour traffic soak, and Towonel decommissioning.

---

## Phase 1 Implementation & Verification Details

### 1. Active Workloads & Health

- **`netbird-dashboard`**: `1/1 Running` (0 restarts)
  - Next.js React frontend serving the NetBird Web UI at `https://nb.${SECRET_DOMAIN}/`.
  - Pinned to `docker.io/netbirdio/dashboard:v2.91.1` (tracked via Renovate).
  - Configured with dynamic OIDC Client ID and Audience from `netbird-oidc-credentials`.
  - Updated to use `/auth` and `/silent-auth` redirect paths with `groups` scope enabled.
- **`netbird-management`**: `1/1 Running` (0 restarts)
  - Management Server v0.77.1 pinned to `docker.io/netbirdio/management:0.77.1` (tracked via Renovate).
  - Connected to CloudNativePG PostgreSQL instance (`postgres17-rw`).
  - Automatically ran database schema migrations and created unique indexes.
  - Dynamically loaded OIDC configuration from `https://id.${SECRET_DOMAIN}/.well-known/openid-configuration`.
  - PocketID IdP Management synchronization configured via `IdpManagerConfig.ExtraConfig` (`ManagementEndpoint` + `ApiToken` from Bitwarden item `Netbird Service Credentials`).
  - Configured with `PKCEAuthorizationFlow` (`http://localhost:53000`, `/auth`, `/silent-auth`) and `DeviceAuthorizationFlow: { "Provider": "none" }` for seamless PocketID SSO authentication.
  - Configured STUN (`stun:vps-eu.${SECRET_DOMAIN}:3478`) and Relay (`rels://vps-eu.${SECRET_DOMAIN}:33073`) endpoints in `management.json`.
  - Listening on port `8080` for API/gRPC traffic, port `33073` for backward compatibility, and port `9090` for metrics.
- **`netbird-signal`**: `1/1 Running` (0 restarts)
  - WebRTC signaling service pinned to `docker.io/netbirdio/signal:0.77.1` (tracked via Renovate) running on port `10000`.
- **`ExternalSecret/netbird-control-plane-secrets`**: `SecretSynced: True`
  - Reliably syncing database credentials, superuser credentials, `NB_POCKETID_MANAGEMENT_APIKEY`, `NB_SELFHOSTED_API_KEY`, and `K8S_SELFHOSTED_SETUP_KEY` from Bitwarden.
- **Traefik `HTTPRoute` (`netbird-control-plane`)**:
  - Bound to `external-gateway` with `Accepted: True` and `ResolvedRefs: True`.

### 2. Empirical Verification Results

1. **Dashboard Root (`/`)**:

   ```text
   HTTP/2 200
   <title>NetBird Dashboard</title>
   ```

2. **Management API & IdP Service Initialization**:

   ```text
   INFO management server version 0.77.1
   INFO running HTTP and gRPC server on the same port: [::]:8080
   INFO running gRPC backward compatibility server: [::]:33073
   INFO 1 entries received from IdP management
   INFO warmed up IDP cache with 1 entries for 1 accounts
   INFO single account mode enabled, accounts number 1
   ```

3. **Management API Authentication (`/api/users`)**:

   ```text
   HTTP/2 401
   {"message":"no valid authentication provided","code":401}
   ```

4. **OIDC Discovery & JWKS**:
   - Successfully loaded JWKS keys from `https://id.${SECRET_DOMAIN}/.well-known/jwks.json`.
   - Single-account mode enabled under `100.110.0.0/16`.

5. **Telemetry & Metrics**:
   - Metrics endpoints active on `:9090` (Management) and `:10000` (Signal) for Prometheus / VictoriaMetrics scraping.

---

## Phase 2: VPS Dual-Daemon NetBird Client & Relay (Hetzner Backup VPS)

### 1. Architectural Strategy

- **Isolation Principle**: To ensure 0 downtime on the production ingress pipeline, Phase 2 deployment is strictly isolated to **`vps-eu` (Hetzner EU)**.
- **Components Tested**:
  - `tofu.yaml` (`ingress-vps-eu`) provisioned `hcloud_server.eu_vps` without affecting `ovh_cloud_project_instance.us_vps`.
  - Cloud-init script provisioned Docker, WireGuard (`wg0`), NetBird (`wt0`), NetBird Relay (`:33073` / `:3478`), Prometheus Node Exporter (`:9100`), Traefik proxy (`:80`/`:443`), and CrowdSec container.
- **Empirical Host Verification (Hetzner EU)**:
  - `hcloud_server.eu_vps` provisioned at `${VPS_EU_PUBLIC_IP}` with direct `AAAA` DNS record `vps-eu.${SECRET_DOMAIN}`.
  - `netbird.service`: Cloud NetBird mesh on interface `wt0` (`100.100.0.0/16`, UDP 51821) - **Active & Connected (2/2 peers)**.
  - `netbird-selfhosted.service`: Self-Hosted NetBird mesh on interface `wt1` (`100.110.0.0/16`, UDP 51822) connected to `https://nb.${SECRET_DOMAIN}` via setup key `VPS_SELFHOSTED_SETUP_KEY` (group `vps-nodes`).
  - `netbird-relay.service`: Containerized NetBird Relay & embedded STUN (`docker.io/netbirdio/relay:0.77.1`, ports 3478/udp and 33073/tcp).
  - `crowdsec-firewall-bouncer-nftables`: Kernel-level packet filtering for SSH, WireGuard, and Relay ports.

### 2. Empirical Verification & Invariants Discovered

1. **OpenTofu Reconciliation**:
   - `Terraform/ingress-tunnel-infra`: Reconciled cleanly (`Ready: True`, `No drift`).
   - `hcloud_server.eu_vps` provisioned at `${VPS_EU_PUBLIC_IP}` with direct `AAAA` DNS record `vps-eu.${SECRET_DOMAIN}`.
   - Hetzner Cloud firewall rules active for STUN `3478/udp`, Relay `33073/tcp`, and WireGuard `51822/udp`.
2. **Systemd Service Invariants**:
   - `netbird service run` does not accept `--interface-name` (flag belongs strictly to `netbird up --interface-name wt1`).
   - `netbird-relay` container strictly requires both `NB_EXPOSED_ADDRESS` (e.g. `rel://${PROBE_HOSTNAME}:33073`) and `NB_AUTH_SECRET` (matching `Relay.Secret` in `management.json`).
3. **Cloudflare WAF Invariant for gRPC / Headless Clients**:
   - When external datacenter IPs connect to `https://nb.${SECRET_DOMAIN}`, Cloudflare's Bot Management / Managed Challenge returns `HTTP/2 403 Forbidden` (`cf-mitigated: challenge`).
   - A Cloudflare WAF Custom Rule / Skip Rule (or IP Access Rule) skipping security challenges for hostname `nb.${SECRET_DOMAIN}` is required for headless NetBird gRPC agent enrollment.

---

## Phase 3: Cluster Routing, Dual-Mesh Architecture & Operator Switch

### 1. Upstream Operator Multi-Instance Conflict Resolution

During dual-operator deployment, upstream `netbird-operator`'s
controller-runtime informers were discovered to hardcode cluster-wide
List/Watch calls across all namespaces without a namespace-filter flag. When two
operators ran simultaneously:

- The self-hosted operator hijacked `NetworkRouter/k8s` in `networking`,
  repointing pods to `100.111.x.x` instead of `100.100.x.x`.
- The Cloud operator hit `DuplicateName` retry loops and 429 rate-limiting on
  `api.netbird.io`.
- Stripping `ClusterRoleBinding` from the secondary operator caused
  `HTTP 403 Forbidden` cache panics at startup.

**Resolution Architecture**:

- **Single Operator Target**: Switched the primary in-cluster `netbird-operator`
  to point to the local self-hosted management server
  (`http://netbird-management.networking.svc.cluster.local:8080`) using
  `NB_SELFHOSTED_API_KEY`.
- **Standalone Fallback Cloud Client**: Deployed `Deployment/netbird-cloud-client`
  directly in `networking` namespace connected to `https://api.netbird.io:443`
  using `SETUP_KEY` from `Secret/netbird`.
- **Consolidated GitOps Structure**: Consolidated into 3 Flux Kustomizations
  (`netbird-control-plane` ➔ `netbird` ➔ `netbird-resources`) and removed
  obsolete secondary operator manifests.

### 2. Empirical Verification

#### Cloud NetBird Fallback Client (`netbird-cloud-client`)

```text
Management: Connected (https://api.netbird.io:443)
Signal: Connected
Relays: 4/4 Available
NetBird IP: 100.100.237.92/16
Networks: *.home.${SECRET_DOMAIN}, *.${SECRET_DOMAIN}, 0.0.0.0/0, 10.0.0.1/32, 10.0.0.2/32,
          10.0.0.3/32, 10.0.1.1/32, 10.0.1.15/32, 10.0.1.48/29, 10.0.10.20/32,
          10.0.10.201/32, 10.0.10.30/32, 10.96.0.10/32,
          towonel-hub.networking.svc.cluster.local
Peers count: 5/6 Connected
```

#### Self-Hosted In-Cluster Router (`networkrouter-k8s`)

```text
Management: Connected (http://netbird-management.networking.svc.cluster.local:8080)
Signal: Connected (https://nb.${SECRET_DOMAIN}:443)
Relays: 1/2 Available (rel://vps-eu.${SECRET_DOMAIN}:33073)
NetBird IP: 100.111.210.203/16
NetBird IPv6: fdc7:6f6a:eb1c:709d:88b2:b244:3e04:61a/64
Networks: *.home.${SECRET_DOMAIN}, *.${SECRET_DOMAIN}, 0.0.0.0/0, 10.0.0.1/32, 10.0.0.2/32,
          10.0.0.3/32, 10.0.1.1/32, 10.0.1.15/32, 10.0.1.48/29, 10.0.10.20/32,
          10.0.10.201/32, 10.0.10.30/32, 10.96.0.10/32, ::/0,
          towonel-hub.networking.svc.cluster.local
Peers count: 4/4 Connected
```

### 3. Split-Horizon DNS & Relay Resolution Invariant

- **Discovery**: In environments with split-horizon wildcard DNS (`*.${SECRET_DOMAIN}` -> internal Traefik VIP `10.0.10.20`),
  in-cluster pods and LAN clients resolve public VPS hostnames (e.g. `vps-eu.${SECRET_DOMAIN}`) to the local
  ingress VIP instead of the public VPS IP. This prevented `networkrouter-k8s` from reaching the containerized
  NetBird Relay on port `33073` and STUN on port `3478`.
- **Remediation**: Configured declarative `hostAliases` in `NetworkRouter/k8s` (`workloadOverride.podTemplate.spec`)
  mapping `vps-eu.${SECRET_DOMAIN}` and `vps-us.${SECRET_DOMAIN}` directly to their respective public
  VPS IPs (`${VPS_EU_PUBLIC_IP}` and `${VPS_US_PUBLIC_IP}`).
- **VPS Enrollment Retry**: Updated `vps-cloud-init.yaml` to include an idempotent retry loop for `netbird up`
  to guard against initial boot DNS/network startup latency.

### 4. PocketID Group Synchronization & Access Control Policies

- **Group Case Resolution**: PocketID OIDC auto-synced user groups `admin` and `users` (lowercase), while initial manual groups were titled `Admin Users` and `Users`.
- **Policy Mapping**: Updated all 16 access control policies in `/api/policies` on the self-hosted management server to include `admin`, `users`, and `All` as authorized source groups.
- **Resource Routing**: Network resources (`k8s-api-access`, `nas-storage`, `public-services`,
  `private-services`, `internal-ingress`, `external-ingress`, `clusterdns`) are bound to
  `routing-peers` as a NetBird Resource Group, providing zero-trust connectivity for authenticated peers.

### 5. NetworkRouter Ephemeral Peer Lifecycle & Teardown Invariant

- **Discovery**: In-cluster `networkrouter-k8s` pods are ephemeral routing peers
  (`ephemeral: true`). When pods were rotated or replaced during Kubernetes
  rollouts, the pod network interface was detached before the `netbird` daemon
  could send an explicit gRPC termination message. NetBird Management retained
  `peer_status_connected = true` in PostgreSQL, preventing the 10-minute
  ephemeral cleaner from purging terminated pods and leaving zombie router
  peers in the console.
- **Remediation**: Added declarative `lifecycle.preStop: exec: command: ["netbird", "down"]`
  to `NetworkRouter/k8s` (`workloadOverride.podTemplate.spec.containers[name: netbird]`).
  Before container termination, kubelet executes `netbird down`, gracefully
  closing the gRPC session so NetBird marks the peer as offline and
  immediately purges it.
- **Setup Key Consolidation**: Removed obsolete manual `NBSetupKey/k8s-setup-key`
  since `netbird-operator` dynamically creates and rotates its own dedicated
  `SetupKey` for `NetworkRouter`.

---

## Phase 4: NetBird BYOP Reverse Proxy Deployment (`proxy.${SECRET_DOMAIN}`)

### 1. Architectural Strategy & Complete VPS Modernization

- **Complete Legacy Stripping**: Stripped Cloud NetBird (`wt0`) and Towonel from both Primary (OVH) and Backup (Hetzner) VPS instances. Both nodes now operate exclusively on self-hosted WireGuard mesh `wt1`.
- **Integrated Reverse Proxy**: Deployed `docker.io/netbirdio/reverse-proxy:0.77.1` as `netbird-proxy.service` listening on ports `80` and `443` with `--net=host` and `NB_PROXY_PRIVATE=true`.
- **Geo-Distributed Redundancy**: Configured dual STUN (`:3478`) and dual Relay (`:33073`) on OVH (North America) and Hetzner (Europe).
- **DNS Topology**: Configured multi-origin round-robin `A` and `AAAA` records for `proxy.${SECRET_DOMAIN}` and wildcard CNAME `*.proxy.${SECRET_DOMAIN}` on Cloudflare.

### 2. Operational Procedures & Runbook

1. **Proxy Token Management**:
   - Token `NB_PROXY_API_KEY` stored in Bitwarden under `Netbird Service Credentials` and synced via ExternalSecrets to `ingress-tunnel-secrets`.
   - Token is injected into `netbird-proxy.service` as `NB_PROXY_TOKEN`.
2. **Cluster & Service Creation**:
   - The cluster `proxy.${SECRET_DOMAIN}` dynamically registers with management as **Online** upon container startup.
   - Services are created in the NetBird Web Console (`Reverse Proxy > Services > Add Service`) or via `POST /api/reverse-proxies/services` targeting `networkrouter-k8s:443` (peer) or `10.0.10.20:443` (resource).
