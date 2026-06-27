# Secrets Management & Webhook Evaluation

This document evaluates the existing self-hosted Vaultwarden + External Secrets
Operator (ESO) integration and explores alternative architectures to address the
brittleness of the current `bw serve` API implementation.

---

## 1. Diagnosis of the Current Setup

The current setup utilizes a community container running the Bitwarden CLI in
server mode (`bw serve`) inside the Kubernetes cluster, defined in
[bitwarden-api-helm-release.yaml](../cluster/apps/system/external-secrets/app/bitwarden-api-helm-release.yaml).
This setup suffers from several critical failure modes:

1. **Liveness Probe Cascading Failure**:
   The liveness probe runs:

   ```yaml
   probes:
     liveness:
       enabled: true
       custom: true
       spec:
         exec:
           command:
             - sh
             - -c
             - |
               curl -X POST -s http://127.0.0.1:8087/sync \
                 | jq -e '.success == true'
   ```

   Calling `/sync` forces the `bw` CLI to connect to the self-hosted
   Vaultwarden instance over the network to pull changes. If Vaultwarden is
   down, starting up, or experiencing network latency exceeding the 5-second
   timeout, the liveness probe fails. After 3 failures (30 seconds),
   Kubernetes terminates the `bitwarden-api` pod.

2. **The `emptyDir` Cache Wipe**:
   The `cache` volume is configured as an `emptyDir` mounted at `/.config`.
   When Kubernetes restarts the container (due to the failed liveness probe),
   the entire local configuration cache (including session credentials and the
   downloaded vault SQLite database) is wiped out. On startup, the container
   must re-authenticate (`bw login --apikey`) and re-download the vault. If
   Vaultwarden is still offline, the startup login fails, and the pod enters a
   permanent `CrashLoopBackOff`.

3. **Circular Boot Deadlock**:
   If Vaultwarden itself depends on credentials managed by ESO, and ESO cannot
   retrieve secrets because the `bitwarden-api` container is crash-looping, the
   cluster cannot bootstrap from a cold start.

4. **Dual Replicas with Split Sessions**:
   With `replicas: 2` and `emptyDir` storage, the two replicas run independent
   caching states and must log in and sync separately. This doubles the auth
   traffic to Vaultwarden and increases the risk of concurrency issues or rate
   limits.

---

## 2. Evaluation of Alternatives

Here are 10 alternatives to resolve the current issues, ranging from hardening
the existing setup to migrating to alternative platforms.

### Option 1: Hardening the Current Setup (Minimal Refactoring)

- **Mechanism**: Keep Vaultwarden, `bw serve`, and ESO, but resolve the bugs:
  1. Change the liveness/readiness probes to check local process status (e.g.,
     `curl -s http://127.0.0.1:8087/status` or a basic TCP check) instead of
     executing `/sync`.
  2. Change the cache mount from `emptyDir` to a `PersistentVolumeClaim` (PVC)
     or hostPath to persist local credentials across restarts.
  3. Reduce `replicas` to `1` to avoid login races.
  4. Ensure core system secrets (databases, storage, etc.) are encrypted via
     SOPS + Age directly in Git rather than relying on ESO.
- **Pros**:
  - 100% self-hosted and independent.
  - Retains your existing Vaultwarden vault with zero migration work.
- **Cons**:
  - Still relies on `bw serve` (Node.js wrapping a CLI tool), which is not
    designed for high-availability daemonized service.

### Option 2: Bitwarden Secrets Manager (BWS) — Cloud Tier

- **Mechanism**: Migrate machine secrets out of Vaultwarden to Bitwarden's
  official cloud Secrets Manager. BWS uses native Access Tokens and has an
  official provider in ESO.
- **Pros**:
  - Native integration with ESO (no local CLI daemon wrapper container needed).
  - High availability and stability managed by Bitwarden.
  - Generous free tier (up to 3 users, 2 projects, 25 secrets).
- **Cons**:
  - Not self-hosted; secrets are stored on third-party cloud infrastructure.
  - Requires active internet connection to pull secrets.
- **Note**: _Vaultwarden does not support the BWS API_, so this requires using
  the official Bitwarden Cloud.

### Option 3: Bitwarden Secrets Manager (BWS) — Self-Hosted (Official Stack)

- **Mechanism**: Deploy the official self-hosted Bitwarden server stack (which
  supports BWS) and connect ESO to it.
- **Pros**:
  - 100% self-hosted and independent.
  - Native ESO integration without `bw serve`.
- **Cons**:
  - The official self-hosted Bitwarden stack is extremely heavy (requires SQL
    Server, multiple Docker containers) and is highly resource-intensive
    compared to Vaultwarden.

### Option 4: Pure GitOps-Native Secrets (SOPS + Age)

- **Mechanism**: Completely eliminate the database/API dependency for
  Kubernetes secrets. Encrypt all secrets in your repository using SOPS + Age
  and let Flux decrypt them directly.
- **Pros**:
  - Incredibly robust; zero run-time dependencies or API containers.
  - If your cluster goes completely offline, it can bootstrap itself with no
    external database or API available.
  - Perfect for disaster recovery.
- **Cons**:
  - No web UI or browser extension; managing/updating secrets is purely
    command-line driven.
  - Painful for credentials shared with desktop/mobile devices.

### Option 5: OpenBao (Self-Hosted Open-Source Vault)

- **Mechanism**: Deploy OpenBao (the fully open-source Linux Foundation fork
  of HashiCorp Vault, created after Vault transitioned to a BSL license) in
  your cluster.
- **Pros**:
  - The gold standard for secrets management.
  - Native ESO integration, extremely robust and secure.
  - Support for advanced features like dynamic, auto-rotating database
    credentials.
- **Cons**:
  - High operational complexity (must manage unsealing keys, PV backups, and
    security policies).

### Option 6: Infisical — Self-Hosted

- **Mechanism**: Host Infisical (a modern, open-source developer secrets
  platform written in Go) backed by a Postgres database in your cluster.
  Connect ESO to it natively.
- **Pros**:
  - Outstanding developer UI, designed specifically for machine/app secrets.
  - Active development, lightweight compared to official Bitwarden.
  - Native ESO provider and native Kubernetes Operator support.
- **Cons**:
  - Adds another database (Postgres) and set of services to maintain and back
    up locally.

### Option 7: Infisical — Cloud Tier

- **Mechanism**: Use Infisical's cloud SaaS to host secrets, pulling them via
  ESO.
- **Pros**:
  - Beautiful dashboard, zero local maintenance, high availability.
  - Native ESO integration.
- **Cons**:
  - Cloud dependency, potential cost if exceeding free tier.

### Option 8: 1Password Connect (Cloud + Local Gateway)

- **Mechanism**: Deploy the `1password-connect` API gateway in your cluster.
  It syncs with the 1Password cloud, and ESO pulls secrets from this local
  gateway.
- **Pros**:
  - Local gateway acts as a high-availability cache (keeps secrets accessible
    if the internet drops).
  - Outstanding UI and browser/mobile experience.
- **Cons**:
  - Requires a paid 1Password subscription.
  - Secrets are hosted on the cloud.

### Option 9: Doppler (Cloud-Hosted)

- **Mechanism**: Store secrets in Doppler Cloud and fetch them via their native
  Kubernetes operator or ESO.
- **Pros**:
  - Outstanding developer experience and automated sync.
  - High availability.
- **Cons**:
  - Completely proprietary cloud service with strict free-tier limits.
  - Internet dependency.

### Option 10: Vaultwarden + Local CLI Sync CronJob

- **Mechanism**: Stop running the persistent `bw serve` container. Instead,
  run a periodic Kubernetes CronJob (e.g., every 30 minutes) that boots a
  lightweight container, logs in using the `bw` CLI, retrieves the latest
  secrets, and creates/updates Kubernetes secrets directly.
- **Pros**:
  - Removes the long-running, brittle Node.js wrapper entirely.
  - Eliminates liveness probe crash-loops.
  - Keeps Vaultwarden as your single source of truth.
- **Cons**:
  - Bypasses the unified External Secrets Operator framework.
  - Secrets update on a delayed interval (cron) rather than on-demand.

---

## 3. Comparison Matrix

| Option                         | Self-Hosted | Reliability | Complexity | UI Experience | ESO Integration  |
| :----------------------------- | :---------: | :---------: | :--------: | :-----------: | :--------------: |
| **1. Hardened current setup**  |   ✅ Yes    |  🟡 Medium  |   🟢 Low   | 🟡 Good (VW)  |    🟡 Webhook    |
| **2. BWS (Cloud)**             |    ❌ No    |   🟢 High   |   🟢 Low   |   🟢 Great    |    ✅ Native     |
| **3. BWS (Self-Hosted)**       |   ✅ Yes    |   🟢 High   |  🔴 High   |   🟢 Great    |    ✅ Native     |
| **4. Pure SOPS + Age**         |   ✅ Yes    |   🟢 High   |   🟢 Low   | 🔴 None (CLI) | ✅ Native (Flux) |
| **5. OpenBao (Vault)**         |   ✅ Yes    |   🟢 High   |  🔴 High   | 🟡 Technical  |    ✅ Native     |
| **6. Infisical (Self-Hosted)** |   ✅ Yes    |   🟢 High   | 🟡 Medium  |   🟢 Great    |    ✅ Native     |
| **7. Infisical (Cloud)**       |    ❌ No    |   🟢 High   |   🟢 Low   |   🟢 Great    |    ✅ Native     |
| **8. 1Password Connect**       |  🟡 Hybrid  |   🟢 High   |   🟢 Low   |   🟢 Great    |    ✅ Native     |
| **9. Doppler (Cloud)**         |    ❌ No    |   🟢 High   |   🟢 Low   |   🟢 Great    |    ✅ Native     |
| **10. CLI Sync CronJob**       |   ✅ Yes    |  🟡 Medium  | 🟡 Medium  | 🟡 Good (VW)  |  ❌ Direct K8s   |

---

## 4. Recommendation Summary

- **If keeping 100% self-hosted & independent (Recommended)**:
  1. Move critical infrastructure bootstrap secrets to **SOPS + Age** (Git) to
     eliminate circular dependencies.
  2. Implement **Option 1 (Hardened Vaultwarden)** to fix `bw serve` liveness
     probe and session persistence issues.
- **If comfortable with hybrid/cloud-backed**:
  - **Option 2 (Bitwarden Secrets Manager Cloud)** is the path of least
    resistance. It offers a native ESO provider and is fully stable within
    Bitwarden's free tier limit.
