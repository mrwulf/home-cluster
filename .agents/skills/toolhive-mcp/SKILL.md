---
name: toolhive-mcp
description: Instructions for deploying, configuring, debugging, and maintaining containerized MCP servers and Virtual MCP Gateways under ToolHive in Kubernetes.
---

# ToolHive MCP Server Management Skill

This skill provides operational workflows and technical implementation guardrails for working with ToolHive and Model Context Protocol (MCP) servers in Kubernetes.

## Architecture & Transport Configuration

1. **Virtual MCP Server (vMCP) Unified Aggregation**:
   - Backend `MCPServer` workloads belong to an `MCPGroup` (`toolhive-servers`).
   - A `VirtualMCPServer` (`toolhive-gateway`) aggregates all backend tools into a single unified catalog.
   - AI clients connect to a single unified SSE URL (`https://toolhive.home.${SECRET_DOMAIN}/sse`).

2. **Stdio vs SSE Transport Configuration**:
   - Most containerized MCP servers operate natively as `stdio` binaries.
   - Configure them in `MCPServer` CRDs with `transport: stdio`, `proxyMode: streamable-http`, and `proxyPort: 8080`.
   - Ensure container binaries output strictly valid JSON-RPC messages over stdout. If a container defaults to SSE mode (e.g. `grafana/mcp-grafana`), pass `args: ["-t", "stdio"]`. If log output leaks into stdout (e.g. `victoriametrics/mcp-victoriametrics`), set `MCP_LOG_LEVEL: error` in `env`.

3. **Gateway Ingress & HTTPRoute Routing**:
   - Traefik `HTTPRoute` machine-client unauthenticated rules MUST explicitly match all client communication paths (`/sse`, `/sse/`, `/mcp`, `/mcp/`, `/message`, `/message/`, `/messages`, `/messages/`).
   - Omitting `/message` or `/messages` causes POST requests from automated MCP clients to hit OIDC middleware rules, returning `302 Found` redirects and triggering `session not found` errors.

4. **Resource Sizing & Memory Headroom**:
   - Every `MCPServer` and `VirtualMCPServer` spec MUST include container resource requests (`cpu: 50m`, `memory: 64Mi`) and memory limits to comply with cluster admission policies.
   - `VirtualMCPServer` gateways holding active streams across 10+ backends require at least `memory: 512Mi` limit (and `100m` CPU request) to prevent kernel OOMKills (`OOMKilled`).

5. **StatefulSet Lifecycle & Auto-Recycling**:
   - Updating `MCPServer` CRDs updates deployment proxy runners, but underlying StatefulSet pods (`mcp-<name>-0`) do not automatically restart.
   - Include `reloader.stakater.com/auto: "true"` under `podTemplateSpec.metadata.annotations` so Stakater Reloader triggers rolling updates automatically on configuration changes.

6. **Python Workloads (`/tmp` storage)**:
   - Python-based MCP servers (e.g. `ha-mcp` / `fastmcp`) require a writable `/tmp` directory. Under restricted security contexts, explicitly mount an `emptyDir` volume at `/tmp` via `podTemplateSpec`.
