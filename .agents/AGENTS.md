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

## ToolHive & MCP Server Operations

1. **ToolHive Transport Architecture**:
   - Container binaries that run over standard I/O (e.g., `github-mcp-server`, `mcp/kubernetes`, `mcp-memory`, `ha-mcp`, `flux-operator-mcp`, `mcp-arr-server`) MUST be configured in `MCPServer` CRDs with `transport: stdio` and `proxyMode: streamable-http` (port `8080`).
   - ToolHive proxy runner executes stdio binaries locally inside the pod and exposes a streamable HTTP/SSE endpoint on port 8080.

2. **Virtual MCP Server (vMCP) Gateway Aggregation**:
   - Instead of routing external Gateway API traffic to individual per-server proxy services or a non-existent central operator proxy, aggregate backend workloads into an `MCPGroup` (`toolhive-servers`).
   - Deploy a `VirtualMCPServer` (`toolhive-gateway`) with `incomingAuth.type: anonymous` and `groupRef.name: toolhive-servers`.
   - Point HTTPRoute backends to `vmcp-toolhive-gateway` on port `4483` so clients connect to a single unified SSE URL (`/sse`).

3. **Flux & Bitwarden Secret Mapping**:
   - Always verify secret key names in `cluster/flux/meta/cluster-secrets.sops.yaml`.
   - GitHub API token variable is `${BW_GITHUB}`.
   - Home Assistant API token variable is `${BW_HOMEASSISTANT}`.
   - ExternalSecrets matching custom fields in Bitwarden must reference property names explicitly (e.g., `property: "flux-notifier-apikey"` or `property: "token"`).

4. **Kubernetes StatefulSet Lifecycle**:
   - Updating `MCPServer` CRDs updates deployment proxy runners, but existing `statefulset.apps/mcp-<name>` pods do NOT automatically restart or pick up spec changes.
   - Recycle statefulset pods via `kubectl delete pod mcp-<name>-0 -n ai` after CRD generation updates to force clean reconciliation.

5. **Resource Limits & Admission Policies**:
   - Every `MCPServer` and `VirtualMCPServer` spec MUST include container resource requests (`cpu: 50m`, `memory: 64Mi`) and memory limits (`memory: 256Mi` / `512Mi`) to comply with cluster Kyverno admission policies (`require-requests-limits`).
