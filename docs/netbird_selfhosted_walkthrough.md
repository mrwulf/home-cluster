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
- **Phase 4: Edge Reverse Proxy Proof-of-Concept**
  - **Status**: 📋 Planned
  - **Deliverables**: NetBird Reverse Proxy (TLS passthrough) on `wt1` targeting
    `10.0.10.20:443`, `test-ingress` validation, and CrowdSec reputation
    filtering.
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
  - Configured STUN (`stun:vps-backup.${SECRET_DOMAIN}:3478`) and Relay (`rels://vps-backup.${SECRET_DOMAIN}:33073`) endpoints in `management.json`.
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

- **Isolation Principle**: To ensure 0 downtime on the production ingress pipeline, Phase 2 deployment is strictly isolated to **`vps-backup` (Hetzner EU)**.
- **Primary Node Preservation**: `primary_vps` (OVH NA) receives `NETBIRD_SELFHOSTED_SETUP_KEY = ""` in `main.tf`, keeping it running existing Towonel and Cloud NetBird daemons without any changes.
- **Dual-Daemon Mesh on Backup VPS**:
  - `netbird.service`: Cloud NetBird mesh on interface `wt0` (`100.100.0.0/16`, UDP 51821) - **Active & Connected (2/2 peers)**.
  - `netbird-selfhosted.service`: Self-Hosted NetBird mesh on interface `wt1` (`100.110.0.0/16`, UDP 51822) connected to `https://nb.${SECRET_DOMAIN}` via setup key `VPS_SELFHOSTED_SETUP_KEY` (group `vps-nodes`).
  - `netbird-relay.service`: Containerized NetBird Relay & embedded STUN (`docker.io/netbirdio/relay:0.77.1`, ports 3478/udp and 33073/tcp).
  - `crowdsec-firewall-bouncer-nftables`: Kernel-level packet filtering for SSH, WireGuard, and Relay ports.

### 2. Empirical Verification & Invariants Discovered

1. **OpenTofu Reconciliation**:
   - `Terraform/ingress-tunnel-infra`: Reconciled cleanly (`Ready: True`, `No drift`).
   - `hcloud_server.backup_vps` provisioned at `94.130.99.118` with direct `AAAA` DNS record `vps-backup.${SECRET_DOMAIN}`.
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
Relays: 1/2 Available (rel://vps-backup.${SECRET_DOMAIN}:33073)
NetBird IP: 100.111.210.203/16
NetBird IPv6: fdc7:6f6a:eb1c:709d:88b2:b244:3e04:61a/64
Networks: *.home.${SECRET_DOMAIN}, *.${SECRET_DOMAIN}, 0.0.0.0/0, 10.0.0.1/32, 10.0.0.2/32,
          10.0.0.3/32, 10.0.1.1/32, 10.0.1.15/32, 10.0.1.48/29, 10.0.10.20/32,
          10.0.10.201/32, 10.0.10.30/32, 10.96.0.10/32, ::/0,
          towonel-hub.networking.svc.cluster.local
Peers count: 4/4 Connected
```

### 3. Split-Horizon DNS & Relay Resolution Invariant

- **Discovery**: In environments with split-horizon wildcard DNS (`*.${SECRET_DOMAIN}` -> internal Traefik VIP `10.0.10.20`), in-cluster pods and LAN clients resolve public VPS hostnames (e.g. `vps-backup.${SECRET_DOMAIN}`) to the local ingress VIP instead of the public VPS IP. This prevented `networkrouter-k8s` from reaching the containerized NetBird Relay on port `33073` and STUN on port `3478`.
- **Remediation**: Configured declarative `hostAliases` in `NetworkRouter/k8s` (`workloadOverride.podTemplate.spec`) mapping `vps-backup.${SECRET_DOMAIN}` and `vps-primary.${SECRET_DOMAIN}` directly to their respective public VPS IPs (`${VPS_BACKUP_PUBLIC_IP}` and `${VPS_PRIMARY_PUBLIC_IP}`).
- **VPS Enrollment Retry**: Updated `vps-cloud-init.yaml` to include an idempotent retry loop for `netbird up` to guard against initial boot DNS/network startup latency.

### 4. PocketID Group Synchronization & Access Control Policies

- **Group Case Resolution**: PocketID OIDC auto-synced user groups `admin` and `users` (lowercase), while initial manual groups were titled `Admin Users` and `Users`.
- **Policy Mapping**: Updated all 16 access control policies in `/api/policies` on the self-hosted management server to include `admin`, `users`, and `All` as authorized source groups.
- **Resource Routing**: Network resources (`k8s-api-access`, `nas-storage`, `public-services`,
  `private-services`, `internal-ingress`, `external-ingress`, `clusterdns`) are bound to
  `routing-peers` (`networkrouter-k8s`), providing zero-trust connectivity for authenticated peers.

---

## Phase 4 Preparation: VPS Direct Edge Ingress & Towonel Retirement

### Target Ingress Flow on Hetzner VPS (`vps-backup`)

1. **Decommission Towonel Edge**: Remove `towonel-edge.service` and `towonel-watchdog` from `vps-cloud-init.yaml`.
2. **Direct Layer 4 SNI Proxy**: Deploy lightweight TLS passthrough reverse proxy listening on port `443` forwarding directly across WireGuard mesh `wt1` to Traefik External Gateway (`10.0.10.20:443`).
3. **Unproxied Direct DNS**: Update `main.tf` to configure unproxied direct DNS records for `nb.${SECRET_DOMAIN}` pointing to the VPS, bypassing Cloudflare proxy buffering for native gRPC and WebSocket throughput.
