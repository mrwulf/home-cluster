---
name: toolhive-mcp
description: Instructions for deploying, configuring, debugging, and maintaining containerized MCP servers and Virtual MCP Gateways under ToolHive in Kubernetes.
---

# ToolHive MCP Server Management Skill

This skill provides operational workflows for working with ToolHive and Model Context Protocol (MCP) servers in Kubernetes.

## Architecture & Transport Configuration

1. **Virtual MCP Server (vMCP) Unified Aggregation**:
   - Backend `MCPServer` workloads belong to an `MCPGroup` (`toolhive-servers`).
   - A `VirtualMCPServer` (`toolhive-gateway`) aggregates all backend tools into a single catalog (92+ tools).
   - AI clients (Claude Code, Antigravity, Cursor) connect to a single unified SSE URL (`https://toolhive.home.${SECRET_DOMAIN}/sse`). Individual per-server client configs are unnecessary and should not be used.

2. **Stdio vs SSE Transport**:
   - Most containerized MCP servers (`github`, `kubernetes`, `memory`, `ha-mcp`, `flux-operator-mcp`, `mcp-arr-server`) operate natively as `stdio` binaries.
   - Configure them with `transport: stdio`, `proxyMode: streamable-http`, and `proxyPort: 8080`.
   - ToolHive proxy runner executes the container via stdin/stdout and serves an HTTP/SSE endpoint internally.

3. **Secret Management & RBAC**:
   - Use `ExternalSecret` custom resources in namespace `ai` targeting `ClusterSecretStore` `bitwarden-fields`.
   - Workloads requiring cluster inspection (`mcp-flux`) require dedicated `ServiceAccount` and `ClusterRoleBinding` configurations.

4. **Python Workloads (`/tmp` storage)**:
   - Python-based MCP servers (e.g. `ha-mcp` / `fastmcp`) require a writable `/tmp` directory. Mount an `emptyDir` volume at `/tmp` via `podTemplateSpec`.

5. **Debugging Stuck Workloads**:
   - Check `kubectl get pods,mcpserver,virtualmcpserver -n ai`.
   - If StatefulSet pods show stale errors, recycle them with `kubectl delete pod mcp-<name>-0 -n ai`.
