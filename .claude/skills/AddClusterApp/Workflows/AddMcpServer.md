# AddMcpServer Workflow

Register a new MCP server through ToolHive. This is a different scaffold from the standard app-template path in `AddApp.md` — don't write a bespoke HelmRelease for an MCP server. See [CLAUDE.md § Adding an MCP server (ToolHive)](../../../../CLAUDE.md) for the full pattern and [cluster/apps/ai/toolhive/README.md](../../../../cluster/apps/ai/toolhive/README.md) for the connection model (single aggregated vMCP gateway, LAN-only for MCP paths, Pocket ID OIDC for anything else on that route).

## Steps

1. **Find the exact deployment facts for the upstream MCP server** before writing anything — image/registry, exact digest, listening port, whether it needs persistent storage, whether it has a health endpoint. Don't guess from a project's marketing page; check its actual Dockerfile/compose file/README.
2. **Pick the transport** by what the upstream image actually does:
   - Wraps a CLI tool with no HTTP server of its own → `transport: stdio`, `proxyMode: streamable-http`, `proxyPort: 8080`. Most existing servers in this repo use this. Example: `cluster/apps/ai/toolhive/servers/mcp-searxng.yaml`.
   - Already serves MCP over HTTP itself → `transport: streamable-http` (or `sse`), `mcpPort: <the container's real port>`. `proxyMode` is ignored for this case. Example: `cluster/apps/ai/toolhive/servers/mcp-pullmd.yaml`.
3. **`groupRef.name: toolhive-servers`** on every `MCPServer`.
4. **Secrets**, if any: `spec.secrets[]` reads a key from a named `Secret`/`ExternalSecret` straight into an env var. Example: `cluster/apps/ai/toolhive/servers/mcp-github.yaml` + its `externalsecret-github.yaml`.
5. **Persistent storage**, if any: a plain `PersistentVolumeClaim` resource (not VolSync, unless the data is worth backing up) referenced from `podTemplateSpec.spec.volumes[].persistentVolumeClaim.claimName`, mounted on the container named `mcp`. Top-level `spec.volumes` on `MCPServer` only supports `hostPath` — don't use it. Example: `cluster/apps/ai/toolhive/servers/pullmd-pvc.yaml`.
6. **Resources**: `requests.cpu`/`requests.memory` + `limits.memory` only — never a CPU limit (rule 6). `50m`/`64Mi` request and `256Mi` limit is the repo's default for lightweight stdio wrappers; size up for anything running its own runtime (Node/Python service, not just a CLI).
7. **Renovate**: add a `# renovate: depName=<image> datasource=docker` comment above `image:` — `MCPServer` isn't a HelmRelease, so the `flux` manager doesn't see it.
8. **Register** the new file(s) in `cluster/apps/ai/toolhive/servers/kustomization.yaml`.
9. **Don't add** a per-server `HTTPRoute`, OIDC client, `ServiceMonitor`, or `GrafanaDashboard` — the operator-level ones in `cluster/apps/ai/toolhive/operator/` already cover every registered server generically.
10. **Update** the "Active MCP Tool Inventory" table in `cluster/apps/ai/toolhive/README.md`.
11. Sanity-check the rendered manifest before running the full suite: `kubectl kustomize cluster/apps/ai/toolhive/servers | kubectl apply --dry-run=server -f -` catches CRD-schema mistakes (wrong field names, disallowed volume types) faster than a full lint pass.
12. Run `mise x -- task test:all`.
