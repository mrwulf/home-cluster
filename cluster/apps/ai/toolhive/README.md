# ToolHive & Model Context Protocol (MCP) Integration Guide

This application deploys **ToolHive** as an enterprise-grade control plane and runtime for managing containerized Model Context Protocol (MCP) servers in the cluster.

---

## Architecture Overview

ToolHive operates in two distinct tiers:

1. **Operator (`operator/`)**: Manages CRDs (`kind: MCPServer`), metrics scraping, Prometheus alerts, Grafana dashboards, and Gateway API routes protected by Pocket ID OIDC authentication.
2. **Servers (`servers/`)**: Contains declarative manifests for isolated production MCP servers and dedicated ExternalSecrets enforcing least privilege.

---

## Connecting External IDEs & Workstation Agents

ToolHive aggregates all active backend MCP servers behind a single **Virtual MCP Server (vMCP)** gateway (`toolhive-gateway`). Instead of configuring multiple endpoints, point your client to the unified SSE gateway URL.

### 1. Claude Desktop & Claude Code

Add the unified vMCP endpoint to your configuration file (e.g., `~/.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "toolhive": {
      "url": "https://toolhive.home.${SECRET_DOMAIN}/sse",
      "transport": "sse"
    }
  }
}
```

### 2. Antigravity / Cursor / Windsurf

Add a single SSE MCP server under your IDE settings:

- **Type**: SSE
- **URL**: `https://toolhive.home.${SECRET_DOMAIN}/sse`

_Note: If connecting outside your LAN, authenticating through Pocket ID OIDC is required via browser redirect or cookie session._

---

## Connecting In-Cluster Local LLM Deployments

For AI frameworks running directly inside the Kubernetes cluster (e.g., **Open WebUI** or **OpenClaw** in the `ai` namespace), connect over high-speed internal Kubernetes DNS.

### Internal Endpoint Format

`http://vmcp-toolhive-gateway.ai.svc.cluster.local:4483/sse`

### Open WebUI Setup

1. Navigate to **Admin Panel** $\rightarrow$ **Settings** $\rightarrow$ **Tools / MCP**.
2. Add the internal cluster URL: `http://vmcp-toolhive-gateway.ai.svc.cluster.local:4483/sse`.
3. Save and verify tool availability across chat sessions.

---

## Active MCP Tool Inventory

| Server Name              | Purpose                                        | Credentials Source          |
| :----------------------- | :--------------------------------------------- | :-------------------------- |
| **`mcp-kubernetes`**     | Pod logs, crashes, events, resource status     | Cluster RBAC                |
| **`mcp-github`**         | GitHub PRs, issues & workflow status           | `mcp-github-secret`         |
| **`mcp-memory`**         | Persistent AI knowledge graph storage          | In-Memory / PVC             |
| **`mcp-flux`**           | Flux GitOps reconciliation & drift auditing    | `mcp-flux` RBAC             |
| **`mcp-home-assistant`** | Home Assistant IoT entity & automation control | `mcp-home-assistant-secret` |
| **`mcp-arr-stack`**      | Sonarr, Radarr, Prowlarr management            | Flux Secrets / Env          |

---

## Planned & Desired MCP Servers Roadmap (Backlog)

The following target servers are desired for future deployment once verified public images or official solutions are established:

| Server Name               | Target Purpose                                     | Desired Integration            |
| :------------------------ | :------------------------------------------------- | :----------------------------- |
| **`mcp-talos`**           | Talos Linux OS cluster node management             | Sidero / Official Talos Server |
| **`mcp-postgres`**        | Read-only SQL schema inspection and queries        | CloudNative-PG Cluster         |
| **`mcp-forgejo`**         | Self-hosted Forgejo repositories and pull requests | Forgejo Service                |
| **`mcp-gatus`**           | Endpoint health checks and uptime monitoring       | Gatus Dashboard                |
| **`mcp-victoriametrics`** | PromQL metrics queries and alert inspection        | VictoriaMetrics Cluster        |
| **`mcp-cloudflare`**      | Public DNS and Zero Trust tunnel auditing          | Cloudflare API                 |
| **`mcp-traefik`**         | Ingress routing and middleware inspection          | Traefik Controller             |
| **`mcp-kyverno`**         | Policy violation auditing and security compliance  | Kyverno Engine                 |
| **`mcp-searxng`**         | Privacy-focused local web search integration       | SearXNG AI Instance            |
