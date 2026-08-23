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
  - **Status**: ⏳ In Progress
  - **Deliverables**: OpenTofu IPv6 AAAA records, `netbird-selfhosted.service`
    (`wt1` on `100.110.0.0/16`), `netbird-relay` container with embedded STUN
    on VPS, `crowdsec-firewall-bouncer-nftables` upgrade, and VPS setup key
    enrollment.
- **Phase 3: Cluster Routing & Mesh Access Policies**
  - **Status**: 📋 Planned
  - **Deliverables**: In-cluster routing peer, declarative WireGuard access
    policies (`NBResource` / groups), and iperf3 bandwidth benchmarks.
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
  - Reliably syncing database credentials, superuser credentials, and `NB_POCKETID_MANAGEMENT_APIKEY` from Bitwarden.
- **Traefik `HTTPRoute` (`netbird-control-plane`)**:
  - Bound to `internal-gateway` and `external-gateway` with `Accepted: True` and `ResolvedRefs: True`.

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
