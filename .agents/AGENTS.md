# Global Project Rules & Lessons Learned

## ToolHive & MCP Server Operations

1. **ToolHive Transport Architecture**:
   - Container binaries that run over standard I/O (e.g. `github-mcp-server`, `mcp/kubernetes`, `mcp-memory`, `ha-mcp`, `flux-operator-mcp`, `mcp-arr-server`) MUST be configured in `MCPServer` CRDs with `transport: stdio` and `proxyMode: streamable-http` (on port `8080`).
   - ToolHive proxy runner executes stdio binaries locally inside the pod and exposes a streamable HTTP/SSE endpoint on port 8080.

2. **Flux & Bitwarden Secret Mapping**:
   - Always verify secret key names in `cluster/flux/meta/cluster-secrets.sops.yaml`.
   - GitHub API token variable is `${BW_GITHUB}`.
   - Home Assistant API token variable is `${BW_HOMEASSISTANT}`.
   - ExternalSecrets matching custom fields in Bitwarden must reference property names explicitly (e.g., `property: "flux-notifier-apikey"` or `property: "token"`).

3. **Kubernetes StatefulSet Lifecycle**:
   - Updating `MCPServer` CRDs updates deployment proxy runners, but existing `statefulset.apps/mcp-<name>` pods do NOT automatically restart or pick up spec changes.
   - Recycle statefulset pods via `kubectl delete pod mcp-<name>-0 -n ai` after CRD generation updates to force clean reconciliation.

4. **Resource Limits & Admission Policies**:
   - Every `MCPServer` spec MUST include container resource requests (`cpu: 50m`, `memory: 64Mi`) and memory limits (`memory: 256Mi`) to comply with cluster Kyverno admission policies (`require-requests-limits`).

5. **Image Tagging & Maintenance**:
   - Never use mutable `latest` tags without immutable SHA256 digests.
   - Keep renovate annotations `# renovate: depName=... datasource=docker` above image declarations.
