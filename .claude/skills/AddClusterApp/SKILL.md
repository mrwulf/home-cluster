---
name: AddClusterApp
version: 1.0.0
description: Scaffold a new application or MCP server into this repo's GitOps-managed Talos+Flux Kubernetes cluster, following its established conventions for HelmReleases, ToolHive MCP servers, Postgres, Pocket ID OIDC, PVC storage, smtp-relay, and monitoring. USE WHEN adding a new app to the cluster, deploying a new service, scaffolding a HelmRelease, adding an MCP server, registering a ToolHive MCPServer, wiring Postgres/OIDC/PVC/smtp-relay/Grafana for a cluster app. NOT FOR general Kubernetes questions unrelated to this repo's own conventions.
---

# AddClusterApp

Fast on-ramp for adding a workload to this cluster. [CLAUDE.md](../../../CLAUDE.md) is the source of truth for every convention referenced here — this skill is a decision router and gotcha list, not a second copy of it. Read CLAUDE.md's "Adding an app" and "Pattern reference" sections before writing manifests.

## Workflow Routing

| Situation                                                                         | Workflow                    |
| --------------------------------------------------------------------------------- | --------------------------- |
| New workload that isn't an MCP server (web UI, background service, exporter, ...) | `Workflows/AddApp.md`       |
| New MCP server (anything an AI agent calls as a tool)                             | `Workflows/AddMcpServer.md` |

## Decision Checklist

Before writing any YAML, resolve each of these against CLAUDE.md's "Pattern reference" table and pick the canonical example to copy:

- **Chart source**: OCIRepository preferred over HelmRepository (`cluster/flux/meta/repositories/oci/`).
- **Database**: shared `postgres17` unless the app specifically needs PostGIS (`postgres17-postgis`) — never a bespoke instance.
- **Auth**: native OIDC via `PocketIDOIDCClient` if the app supports it; Traefik forward-auth middleware if it doesn't. Never ship an app with no auth layer if it exposes a browser UI outside a LAN-only route.
- **Storage**: `emptyDir` by default for disposable/cache state — cheaper and simpler than a PVC, and a cold cache after restart is fine unless it measurably hurts startup time. VolSync-backed PVC (`templates/volsync/primary` component + `scripts/stagger-volsync.py`) if the data is worth restoring after a rebuild. Plain `PersistentVolumeClaim` — with a rule-8 comment explaining why — only when startup time actually suffers from `emptyDir`, or the volume must be shared (`ReadWriteMany`) across replicas.
- **Outbound mail**: `smtp-relay.system.svc.cluster.local:2525`, no auth, never an external SMTP provider.
- **Observability**: `ServiceMonitor` + `GrafanaDashboard` (dashboard always in `namespace: monitoring`, `dashboards: grafana` label) unless the app's subsystem (e.g. ToolHive) already covers it generically.
- **Renovate**: every image/chart/tarball must be trackable — native manager (flux/helm-values/kubernetes) where possible, else a `# renovate: depName=... datasource=...` comment. Verify it lands on the Renovate Dashboard issue.
- **Gate**: `mise x -- task test:all` must exit 0 before commit.

## Gotchas

- **`mise x -- task test:all` prints `✗` lines from the `flux:build`/`flux:check` steps even on success** — those are `ignore_error: true`. The real gate is `lint:all`; check the task's exit code, not its `✗` output, to know if it actually failed.
- **`kubectl explain <crd>.spec --recursive` against the live cluster beats guessing a CRD's fields from existing examples alone.** Existing `MCPServer` examples all use `transport: stdio`; the schema also supports `streamable-http`/`sse` for servers that already speak MCP over HTTP, which no example in the repo shows.
- **`MCPServer`'s top-level `spec.volumes` only supports `hostPath`** (not node-portable, don't use it for real storage). Use `podTemplateSpec.spec.volumes` instead — `emptyDir` for disposable/cache state (the default), or `persistentVolumeClaim` only when a cold cache would meaningfully hurt startup time — plus a matching `volumeMounts` entry on the container named `mcp`.
- **A GrafanaDashboard's `namespace:` is independent of the app's own `targetNamespace`** — it's wherever the Grafana instance lives (`monitoring` in this cluster), regardless of where the workload runs.
- **Traefik resolves `ExtensionRef` middleware in the route's own namespace**, not `networking` where middlewares are defined. If a new namespace needs `rfc1918-ips` or `traefik-middleware-chain-pocket-id`, add it to the Kyverno `sync-middlewares.yaml` clone policy first or the `HTTPRoute` will fail to resolve the filter.
- **CPU limits get silently stripped by a Kyverno policy** (`remove-cpu-limit.yaml`) even if you set one — but don't rely on that; just don't set one (rule 6).
- **Docs drift**: verify any version number or instance name CLAUDE.md states (e.g. a Postgres major version) against the actual live manifest before trusting it as fact — this skill was created after finding one such drift.

## Examples

**Example 1: Add a new self-hosted web app**

```
User: "Add <some app> to the cluster"
→ AddApp.md walks OCIRepository/HelmRelease/ks.yaml scaffold
→ Decision Checklist resolves DB/auth/storage/mail/monitoring choices
→ mise x -- task test:all passes before commit
```

**Example 2: Add a new MCP server**

```
User: "Add an MCP server for <some tool>"
→ AddMcpServer.md walks the ToolHive MCPServer scaffold
→ Picks transport (stdio+proxy vs native streamable-http/sse) from what the upstream image actually speaks
→ Registers in servers/kustomization.yaml, updates the toolhive README inventory table
```
