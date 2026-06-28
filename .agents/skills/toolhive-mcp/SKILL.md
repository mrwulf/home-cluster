---
name: toolhive-mcp
description: Instructions for deploying, configuring, debugging, and maintaining containerized MCP servers under ToolHive in Kubernetes.
---

# ToolHive MCP Server Management Skill

This skill provides operational workflows for working with ToolHive and Model Context Protocol (MCP) servers in Kubernetes.

## Core Rules & Transport Configuration

1. **Stdio vs SSE Transport**:
   - Most containerized MCP servers (`github`, `kubernetes`, `memory`, `ha-mcp`, `flux-operator-mcp`, `mcp-arr-server`) operate natively as `stdio` binaries.
   - Configure them with `transport: stdio`, `proxyMode: streamable-http`, and `proxyPort: 8080`.
   - ToolHive proxy runner executes the container via stdin/stdout and serves an HTTP/SSE endpoint.

2. **Secret Management**:
   - Use `ExternalSecret` custom resources in namespace `ai` targeting `ClusterSecretStore` `bitwarden-fields`.
   - Map secrets into `MCPServer` spec using `secrets:` array with `key:` and `targetEnvName:`.

3. **Cluster RBAC**:
   - Tools requiring cluster inspection (`mcp-flux`) require dedicated `ServiceAccount` and `ClusterRoleBinding` configurations.

4. **Debugging Stuck Workloads**:
   - Check `kubectl get pods,mcpserver -n ai`.
   - If StatefulSet pods show stale errors, recycle them with `kubectl delete pod mcp-<name>-0 -n ai`.
