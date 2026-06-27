# ToolHive & Model Context Protocol (MCP) Integration Guide

This application deploys **ToolHive** as an enterprise-grade control plane and runtime for managing containerized Model Context Protocol (MCP) servers in the cluster.

---

## Architecture Overview

ToolHive operates in two distinct tiers:

1. **Operator (`operator/`)**: Manages CRDs (`kind: MCPServer`), metrics scraping, Prometheus alerts, Grafana dashboards, and Gateway API routes protected by Pocket ID OIDC authentication.
2. **Servers (`servers/`)**: Contains declarative manifests for 13 isolated MCP servers (`mcp-kubernetes`, `mcp-flux`, `mcp-postgres`, `mcp-github`, `mcp-memory`, etc.) and dedicated ExternalSecrets enforcing least privilege.

---

## Connecting External IDEs & Workstation Agents

To connect workstation AI clients (Claude Code, Antigravity, Cursor, Claude Desktop) to cluster-hosted MCP tools, configure SSE transport pointing to your internal Gateway API endpoint.

### 1. Claude Desktop & Claude Code

Add the SSE endpoints to your configuration file (e.g., `~/.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "toolhive-kubernetes": {
      "url": "https://toolhive.home.${SECRET_DOMAIN}/sse/mcp-kubernetes",
      "transport": "sse"
    },
    "toolhive-postgres": {
      "url": "https://toolhive.home.${SECRET_DOMAIN}/sse/mcp-postgres",
      "transport": "sse"
    },
    "toolhive-memory": {
      "url": "https://toolhive.home.${SECRET_DOMAIN}/sse/mcp-memory",
      "transport": "sse"
    }
  }
}
```

### 2. Antigravity / Cursor / Windsurf

Add new SSE MCP servers under your IDE settings:

- **Type**: SSE
- **URL**: `https://toolhive.home.${SECRET_DOMAIN}/sse/<server-name>` (e.g. `mcp-flux`, `mcp-cloudflare`)

_Note: If connecting outside your LAN, authenticating through Pocket ID OIDC is required via browser redirect or cookie session._

---

## Connecting In-Cluster Local LLM Deployments

For AI frameworks running directly inside the Kubernetes cluster (e.g., **Open WebUI** or **OpenClaw** in the `ai` namespace), connect over high-speed internal Kubernetes DNS without public ingress overhead.

### Internal Endpoint Format

`http://toolhive-operator-proxy.ai.svc.cluster.local:8080/sse/<server-name>`

### Open WebUI Setup

1. Navigate to **Admin Panel** $\rightarrow$ **Settings** $\rightarrow$ **Tools / MCP**.
2. Add the internal cluster URL: `http://toolhive-operator-proxy.ai.svc.cluster.local:8080/sse/mcp-kubernetes`.
3. Save and verify tool availability across chat sessions.

---

## Active MCP Tool Inventory

| Server Name               | Purpose                                    | Credentials Source      |
| :------------------------ | :----------------------------------------- | :---------------------- |
| **`mcp-kubernetes`**      | Pod logs, crashes, events, resource status | Cluster RBAC            |
| **`mcp-flux`**            | GitOps reconciliation & drift detection    | Cluster RBAC            |
| **`mcp-postgres`**        | Read-only SQL schema & query execution     | `mcp-postgres-secret`   |
| **`mcp-forgejo`**         | Self-hosted Forgejo PRs & issues           | `mcp-forgejo-secret`    |
| **`mcp-github`**          | GitHub PRs, issues & workflow status       | `mcp-github-secret`     |
| **`mcp-victoriametrics`** | PromQL metrics, alerts & log queries       | Internal Cluster DNS    |
| **`mcp-gatus`**           | Endpoint health & uptime status            | Internal Cluster DNS    |
| **`mcp-home-assistant`**  | IoT entity state & automation control      | Local Network           |
| **`mcp-arr-stack`**       | Sonarr, Radarr, Prowlarr management        | `mcp-arr-secret`        |
| **`mcp-cloudflare`**      | Public DNS & Zero Trust tunnel audit       | `mcp-cloudflare-secret` |
| **`mcp-traefik`**         | Ingress route & middleware inspection      | Cluster RBAC            |
| **`mcp-kyverno`**         | Cluster policy compliance auditing         | Cluster RBAC            |
| **`mcp-memory`**          | Persistent AI knowledge graph storage      | In-Memory / PVC         |
| **`mcp-searxng`**         | Privacy-preserving web search & markdown   | Internal Cluster DNS    |
