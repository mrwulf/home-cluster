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
- **Edge Tunnel SNI Route Parity**: Custom probe hostnames (e.g. `vps-direct.${SECRET_DOMAIN}`) used for edge health checks must be authorized in both the edge tunnel agent (`TowonelAgent` CR) and have an active `HTTPRoute`/`Ingress` on `traefik-external` so the full TLS SNI pipeline resolves to a valid HTTP status code (`< 500`).
- **Metrics Scrape Firewalling & Relabeling**: Never expose metrics scrape ports to `0.0.0.0/0`. Restrict firewall rules (`main.tf`) to internal CIDRs (`local.home_ip_cidr`) or private overlay meshes (NetBird). Always attach consistent `relabelConfigs` (e.g., `targetLabel: cluster`) in `VMStaticScrape` manifests.
- **Event-Sourced Log Replay**: Do not misinterpret startup event-replay `WARN` logs (e.g. Towonel Hub's `skipping unauthorized hostname claim`) as active outages. Always verify active CR statuses and live edge HTTP probes first.
- **CrowdSec Docker Mount Initialization**: The official CrowdSec container entrypoint populates base `/etc/crowdsec/config.yaml` on first boot ONLY if `/etc/crowdsec` is empty. Pre-creating custom parser or acquisition subdirectories on the host before container start skips `config.yaml` creation and causes CrowdSec to crash on startup. Always let the container start on a clean `/etc/crowdsec` mount first, wait for `cscli config show` readiness, then dynamically inject custom parsers/whitelists and call `cscli reload`.
- **CrowdSec Volume & Collection Invariants**: CrowdSec v1.7+ Docker containers require `-v /var/lib/crowdsec/data:/var/lib/crowdsec/data` for SQLite/hub persistence; omitting this volume causes immediate container exit. Additionally, use valid hub collection names (`crowdsecurity/http-cve`, `crowdsecurity/linux`, `crowdsecurity/sshd`) as invalid collection names (e.g. `base-http`) fail container entrypoint execution.
- **Debian Testing (Trixie) PackageCloud Repos**: Upstream PackageCloud third-party repositories (e.g. CrowdSec bouncers) often lack release files for Debian testing (`trixie`). Explicitly configure `/etc/apt/sources.list.d/crowdsec_crowdsec.list` to pin the stable `debian bookworm` release line.
- **MCP Connection Resilience & Lazy Gateway Invocation**: Large MCP aggregators (e.g. `local-mcp-gateway`) are loaded lazily via `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`). Never fall back to CLI scripts when an MCP tool fails due to stream timeouts or disconnection; prompt the user to restart the connection in the IDE (**... > MCP Servers > Restart**) to preserve the Tool-First mandate.
