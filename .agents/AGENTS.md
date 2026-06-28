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
