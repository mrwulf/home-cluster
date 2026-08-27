# Global Project Rules & Lessons Learned

## Non-Negotiable Cluster & Workspace Rules (CLAUDE.md)

1. **GitOps Workflow**: Never perform direct `kubectl apply` commands; all cluster state is managed via Flux GitOps. Validate all changes using `mise x -- task test:all`.
2. **Renovate Tracking**: Every external image and chart dependency must be pinned and tracked by Renovate.
3. **SOPS Encryption**: Secrets committed to git must be SOPS-encrypted using age.
4. **Conventional Commits**: Use semantic commit headers (`feat:`, `fix:`, etc.) without AI attribution trailers.
5. **Documentation Integrity**: Keep all documentation (`README.md`, etc.) up to date with implementation changes.
6. **No CPU Limits**: Guarantee resources with CPU requests, but never define CPU limits to avoid unnecessary throttling.
7. **Protect PII & Local Paths**: Keep local filesystem paths, personal usernames, and PII out of commits.
8. **DRY Principle**: Never duplicate configurations, secrets, or credentials across components.
9. **Least Privilege**: Workloads must strictly receive minimal RBAC and secret access required.
10. **Fulfill Implementation Plans**: Verify all design components (auth, secrets, networking, observability) before completion.
11. **Pin Container Tags**: Never use unpinned `latest` tags without immutable SHA256 digests.
12. **End-to-End GitOps Runtime Verification**: In GitOps-managed components (Flux, OpenTofu Controller), never declare a task complete based on local file edits, git commit/push, or CR `Ready` status alone. You MUST wait for Flux/OpenTofu reconciliation to complete and perform live empirical runtime verification (e.g. SSH into host, `kubectl exec`, or inspecting active container/service status) on the target workload.
13. **Definition of Done for Agents**: An agent is not done with a task in this repository until changes have been committed, pushed to git, and validated (including end-to-end runtime verification where applicable).

## Mandatory Tool Usage & Operation Rules

1. **Tool-First Policy**: NEVER write bespoke Python scripts, shell scripts, or raw HTTP/curl scripts to interact with systems covered by active MCP tools. Dedicated MCP tools MUST always be used first. Writing custom scripts is strictly prohibited unless an MCP tool explicitly lacks the required capability.

2. **MCP Server Tool Matrix**:
   - **`mcp-kubernetes`**: Inspecting pods, deployments, services, events, logs, and metrics in the cluster. Prefer over raw `kubectl`.
   - **`mcp-github`**: Searching code, checking commits, managing pull requests/issues, and inspecting GHCR.io container registries.
   - **`mcp-flux`**: Inspecting Flux `GitRepository`, `Kustomization`, and `HelmRelease` statuses or debugging reconciliation failures.
   - **`mcp-grafana`**: Querying Loki logs, inspecting Grafana dashboards, viewing panels, and checking alert manager routing/rules.
   - **`mcp-victoriametrics`**: Running PromQL queries to inspect cluster memory/CPU usage trends, node statistics, and metrics.
   - **`mcp-searxng`**: Web searching via private internal SearXNG meta-search engine for documentation, releases, or troubleshooting.
   - **`mcp-kubesearch`**: Searching upstream Helm charts, chart values (`values.yaml`), release history, and container image versions.
   - **`mcp-arr-stack`**: Checking Radarr/Sonarr download queues, reviewing media libraries, searching missing episodes/movies, and indexer status via Prowlarr.
   - **`mcp-home-assistant`**: Inspecting smart home entity states, listing devices/areas, evaluating HA templates, and triggering automation events.
   - **`mcp-memory`**: Storing and retrieving entity relationships, complex project context, and long-term knowledge across agent sessions.

## Topic & Subsystem Documentation Index

> [!IMPORTANT]
> **Mandatory Reference Directive**: Before researching, planning, designing, modifying, or troubleshooting any subsystem or service, you MUST review its dedicated guide in [`docs/`](docs/). Detailed operational procedures, networking topologies, edge watchdogs, and configuration invariants reside in these guides:

- **[docs/ingress_and_netbird_architecture.md](docs/ingress_and_netbird_architecture.md)**: Edge ingress VPS architecture, dual-tier failover hierarchy, self-hosted NetBird mesh & control plane, STUN/Relay, CrowdSec protection, and operational runbooks.
- **[docs/netbird_selfhosted_walkthrough.md](docs/netbird_selfhosted_walkthrough.md)**: Live deployment status, empirical verification logs, and Phase 1-5 progress tracking for self-hosted NetBird.
- **[docs/storage.md](docs/storage.md)**: Cluster storage, Rook-Ceph pools, Ceph-CSI, key rotation sequence, Bluestore activation, and Talos krbd recovery.
- **[docs/backups.md](docs/backups.md)**: Volsync, Restic backup schedules, replication repositories, snapshot retention, and restoration runbooks.
- **[docs/secrets_management_options.md](docs/secrets_management_options.md)**: External Secrets Operator (Bitwarden sync) and SOPS age encryption patterns.
- **[docs/tdarr_optimization_guide.md](docs/tdarr_optimization_guide.md)**: Hardware-accelerated media transcoding (Intel QuickSync / i915 GPU parameters and HandBrake/FFmpeg presets).
- **[docs/renovate_self_hosting.md](docs/renovate_self_hosting.md)**: Self-hosted Renovate runner setup, schedules, and regex managers.
- **[docs/tor_ingress_egress_notes.md](docs/tor_ingress_egress_notes.md)**: Tor onion services and private ingress/egress configurations.

## Operational & Maintenance Procedures

### Weekly Cluster Workload Resource Optimization

- **Schedule & Frequency**: Perform a comprehensive cluster-wide workload resource optimization review weekly.
- **Telemetry Sources**: Query VictoriaMetrics (`query_prometheus`) for 7-day peak memory working sets (`max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{container!=""}[7d]))`) and Loki for OOMKill events.
- **Governance Alignment**:
  - Right-size CPU requests to prevent node over-commit while ensuring hardware offloading (e.g. Intel GPU i915) is accounted for.
  - Enforce No CPU Limits (Rule 6 in CLAUDE.md) across all non-system containers.
  - Right-size memory requests/limits based on actual peak telemetry buffers to eliminate OOMKills and reclaim unused node allocations.
- **Execution Tool**: Recommend using the `/schedule` command or setting background timers when initiating multi-phase resource analyses.

## Grafana Dashboard Deployment Workflow

When asked to add or audit Grafana dashboards in this cluster:

### 1. Audit live Grafana FIRST (before any file changes)

- Use `mcp-grafana` `search_dashboards` (with an empty query to list all) to enumerate what is currently deployed.
- Cross-reference against the git YAML files in `cluster/apps/monitoring/grafana/instance/dashboards/` to confirm parity.
- Do NOT add a dashboard that is already present. Do NOT assume git = live.

### 2. GrafanaDashboard CR pattern (grafana.com dashboards)

```yaml
---
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: <slug>
spec:
  instanceSelector:
    matchLabels:
      dashboards: grafana # mandatory — matches the Grafana instance
  folder: <folder-name> # must match an existing GrafanaFolder in folders.yaml
  # renovate: depName=<ID>  # required for Renovate tracking of grafana.com IDs
  url: https://grafana.com/api/dashboards/<ID>/revisions/<rev>/download
  datasources:
    - inputName: DS_PROMETHEUS
      datasourceName: Prometheus
```

- **Datasource mapping**: The standard input is `DS_PROMETHEUS` → `Prometheus`.
- **Raw JSON dashboards** (GitHub-hosted) omit the `# renovate:` comment but pin to a specific git tag/SHA in the URL.
- **Folder must pre-exist**: verify the `folder:` value exists as a `GrafanaFolder` in `cluster/apps/monitoring/grafana/instance/folders/folders.yaml` before referencing it.

### 3. File placement & kustomization

- Central dashboards file: `cluster/apps/monitoring/grafana/instance/dashboards/dashboards-<category>.yaml`
- Always add the new file to `cluster/apps/monitoring/grafana/instance/kustomization.yaml`.
- App-specific dashboards live alongside the app in its own namespace directory.

### 4. Validate before committing

- Run `mise x -- task test:all` to confirm the Flux kustomization compiles cleanly.

## Development & Infrastructure Lessons Learned

- **Prettier Ignore Paths**: Patterns in `--ignore-path` resolve relative to the ignore file. Prefix root ignores with `../../` (e.g. `../../.venv/`) when config lives in `.github/linters/`.
- **Kubeconform Caching**: Avoid `-cache` in CRD-heavy clusters. Upstream 404s cache as HTML, causing subsequent JSON parser crashes. Use concurrency (`-n 8`) instead.
- **RWO PVC Deployments**: Single-replica ReadWriteOnce PVC mounts require the `Recreate` strategy to prevent deadlocks. Explicitly define `rollingUpdate: null` to clear default API server fields during upgrades.
- **Helm/Kustomize Inline Script Variables**: In inline container `command` or `args` shell blocks within Flux `HelmRelease` or `Kustomization` manifests, do NOT use curly-braced syntax `${VAR_NAME}` for runtime container environment variables. Helm/Kustomize evaluates `${VAR_NAME}` as build-time template interpolation and strips unmapped variables to empty strings (`""`). Always use `$VAR_NAME` or `\$VAR_NAME` so variable evaluation occurs at pod runtime.
- **Cloudflare Failover Worker Probing**: Failover monitor scripts must probe dedicated unproxied A records (`vps-direct.${SECRET_DOMAIN}`) directly targeting the physical origin server. Never probe failover CNAME aliases, as requests will hit the backup tunnel during failover states, preventing automatic recovery detection.
- **Edge SNI Route Parity**: Custom probe hostnames (e.g. `vps-direct.${SECRET_DOMAIN}`) used for edge health checks must have an active `HTTPRoute`/`Ingress` on `traefik-external` so the full TLS SNI pipeline resolves to a valid HTTP status code (`< 500`).
- **Metrics Scrape Firewalling & Relabeling**: Never expose metrics scrape ports to `0.0.0.0/0`. Restrict firewall rules (`main.tf`) to internal CIDRs (`local.home_ip_cidr`) or private overlay meshes (NetBird). Always attach consistent `relabelConfigs` (e.g., `targetLabel: cluster`) in `VMStaticScrape` manifests.
- **CrowdSec Docker Mount Initialization**: The official CrowdSec container entrypoint populates base `/etc/crowdsec/config.yaml` on first boot ONLY if `/etc/crowdsec` is empty. Pre-creating custom parser or acquisition subdirectories on the host before container start skips `config.yaml` creation and causes CrowdSec to crash on startup. Always let the container start on a clean `/etc/crowdsec` mount first, wait for `cscli config show` readiness, then dynamically inject custom parsers/whitelists and call `cscli reload`.
- **CrowdSec Volume & Collection Invariants**: CrowdSec v1.7+ Docker containers require `-v /var/lib/crowdsec/data:/var/lib/crowdsec/data` for SQLite/hub persistence; omitting this volume causes immediate container exit. Additionally, use valid hub collection names (`crowdsecurity/http-cve`, `crowdsecurity/linux`, `crowdsecurity/sshd`) as invalid collection names (e.g. `base-http`) fail container entrypoint execution.
- **Debian Testing (Trixie) PackageCloud Repos**: Upstream PackageCloud third-party repositories (e.g. CrowdSec bouncers) often lack release files for Debian testing (`trixie`). Explicitly configure `/etc/apt/sources.list.d/crowdsec_crowdsec.list` to pin the stable `debian bookworm` release line.
- **MCP Connection Resilience & Lazy Gateway Invocation**: Large MCP aggregators (e.g. `local-mcp-gateway`) are loaded lazily via `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`). Never fall back to CLI scripts when an MCP tool fails due to stream timeouts or disconnection; prompt the user to restart the connection in the IDE (**... > MCP Servers > Restart**) to preserve the Tool-First mandate.
- **Zero Hardcoded Public Cloud IPs**: Never commit public VPS or dynamic cloud IP addresses directly into git YAML manifests in public repositories. Always export dynamic IPs via OpenTofu (`kubernetes_secret_v1` into `flux-system` or `writeOutputsToSecret`), and substitute them at build time using Flux `postBuild.substituteFrom`.
- **Decouple Infra Generation from Secret Consumers**: Manifests consuming dynamic secrets via `postBuild.substituteFrom` (e.g., `VMStaticScrape`) MUST be placed in a separate child Kustomization that `dependsOn` the infrastructure Kustomization. Bundling consumer manifests in the same Kustomization as the `Terraform` CR causes Flux envsubst strict mode to fail before the Terraform runner can execute and populate the secret.
- **Cluster Patch `substituteFrom` Parity**: The top-level cluster Kustomization (`cluster/flux/cluster/ks.yaml`) uses a cluster-wide patch that overwrites `postBuild.substituteFrom` in child Kustomizations. Any cluster-wide dynamic secret (e.g. `vps-tunnel-output`) must be included in `cluster/flux/cluster/ks.yaml` with `optional: true` so child Kustomizations inherit it.
- **Multi-Debian Cloud-Init Package Splits**: Debian 13 (`trixie`) splits Docker into `docker.io` and `docker-cli`, while Debian 12 (`bookworm`) has no `docker-cli` package. In cloud-init scripts targeting heterogeneous Debian releases, always install baseline packages first, then conditionally install release-specific packages (`apt-get install -y docker-cli || true`) to prevent apt transaction aborts.
- **Nuxt 3 / Nitro Runtime Env Prefixing**: Applications built on Nuxt 3 / Nitro runtime (`useRuntimeConfig(event)`) strictly bind environment variables prefixed with `NUXT_*` or `NITRO_*`. Unprefixed or bespoke vendor prefixes are ignored by the Nitro engine at runtime.
- **CephX Key Rotation Sequence**: Never enable declarative `spec.security.cephx` / `aes256k` key rotation in Rook-Ceph before all daemons (especially all OSDs) have fully completed their rolling image upgrade.
- **Ceph-CSI Key Type Invariant**: Ceph-CSI v3.17+ librados requires standard 128-bit `aes` keys. Never set `security.cephx.csi.keyType: aes256k`, only `security.cephx.daemon.keyType: aes256k`.
- **RBD / LVM Bluestore Activation Deadlock**: `ceph-volume raw activate` internally runs `lvs`, which scans `/dev/` without filtering `/dev/rbd*`. If an OSD is down and PGs are peering, `lvs` blocks in kernel `D` state (`folio_wait_writeback`), causing pods to stick in `Terminating` and device locks to hang. A node reboot (`talosctl reboot`) is required to clear kernel `D` state tasks.
- **Renovate Broken Release Suppression (`ignoreVersions`)**: When rolling back or pinning an image or chart dependency due to upstream runtime incompatibilities (e.g. Python base image mismatches), never rely on code comments or pinned tags alone. Always configure `ignoreVersions: ["<version>"]` in `.github/renovate.json5` and inline `# renovate:` comments so Renovate does not immediately re-generate pull requests for the broken release.
- **CephCluster `security.cephx` Immutability & Reversion**: The `CephCluster` CRD enforces OpenAPI schema rules (`!has(oldSelf.keyGeneration) || has(self.keyGeneration)` and `self >= oldSelf`). Never delete `spec.security.cephx` or decrease `keyGeneration` to revert a cipher change; instead, set `keyType: aes` and increment `keyGeneration` to trigger forward rotation back to standard AES.
- **Talos Safe Storage Reboot Invariants**: When recovering nodes experiencing kernel `D`-state deadlocks (such as stuck krbd mounts), never execute `shutdown` (risks remote node lockout). Always use `talosctl reboot` with `--mode=force` or `--mode=powercycle` and set an explicit `--timeout` (e.g. `5m`) to bypass hung graceful teardown.
- **Edge VPS Ingress & NetBird Invariants**: Refer to [docs/ingress_and_netbird_architecture.md](docs/ingress_and_netbird_architecture.md) for required edge container healthcheck parameters, watchdog timers, TCP keepalives, multi-region failover, and cloud-init SSH key invariants.
- **Split-Horizon DNS & VPS Relay Resolution (`hostAliases`)**: In networks where split-horizon wildcard DNS (`*.${SECRET_DOMAIN}`) resolves internal ingress VIPs (e.g. `10.0.10.20`), in-cluster pods and LAN services fail to reach external VPS endpoints (such as NetBird Relay on `:33073` and STUN on `:3478`). In Kubernetes workloads (such as `NetworkRouter/k8s` in `workloadOverride.podTemplate.spec` and `gatus`), always declare `hostAliases` mapping `vps-eu.${SECRET_DOMAIN}` to `${VPS_EU_PUBLIC_IP}` and `vps-us.${SECRET_DOMAIN}` to `${VPS_US_PUBLIC_IP}`. On physical firewalls (OPNsense), configure explicit Unbound Host Overrides to take precedence over domain wildcards.
- **Edge VPS SSH Credentials**: When performing administrative SSH tasks directly against Hetzner or OVH VPS edge infrastructure, always specify the personal ed25519 identity key (`-i ~/.ssh/id_ed25519.personal`).
- **Firewall Appliance Execution Boundaries**: Never attempt direct remote command execution, shell injection, or SSH scripts against physical or virtual network firewalls (e.g. OPNsense). Provide explicit configuration instructions for Web GUI adjustments (such as Unbound DNS Host Overrides).
- **Mise Toolchain Execution Discipline**: All repository linters, validators, and build tools (`task`, `yamllint`, `tofu`, `kubeconform`, `prettier`, `pre-commit`) must strictly be executed through `mise x -- <command>` to ensure correct virtual environment and binary version resolution. In agent environments where `mise` is not present in `$PATH`, the binary is available at `~/.local/bin/mise` (e.g. `~/.local/bin/mise x -- <command>`).
- **Cloud-Init Daemon Enrollment Retry Loops**: Cloud-init provisioning scripts that register mesh or tunnel daemons (`netbird up`) across the public internet must use idempotent retry loops rather than single-shot commands with `|| true` to prevent silent registration failures caused by early-boot DNS resolution delay.
- **External-DNS & Dynamic Failover Decoupling**: When using a dynamic failover monitor (e.g. Cloudflare Worker controlling an `ingress.<domain>` CNAME), configure `Gateway/external-gateway` with `external-dns.kubernetes.io/target: "ingress.<domain>"` and remove `--cloudflare-proxied` from `external-dns`. This ensures all service CNAMEs point unproxied to the failover target without conflicting with the worker.
- **Gateway Multi-Parent DNS Fallback**: If an `HTTPRoute` attaches to multiple Gateways or a Gateway missing `external-dns.kubernetes.io/target`, `external-dns` falls back to publishing literal Gateway `spec.addresses` as `A` records. Consolidate routes under a single annotated Gateway to prevent unexpected `A` record publication.
- **Secret Domain Masking in Labels & Annotations**: Never embed private `${SECRET_DOMAIN}` strings in Kubernetes label keys or selectors (e.g. `gateway.<domain>/type`). Always use standardized generic domain prefixes (such as `gateway.home-operations.io/type`) across GatewayClasses, Gateways, Traefik `--providers.kubernetesgateway.labelselector`, and External-DNS `--gateway-label-filter`.
