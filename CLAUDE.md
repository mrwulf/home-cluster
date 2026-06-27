# CLAUDE.md

Guidance for working in this repository. Read this before adding or changing anything.

## What this repo is

A GitOps-managed home Kubernetes cluster. The cluster runs on **Talos Linux**; everything in the cluster is reconciled from this Git repo by **Flux**.
There is no `kubectl apply` workflow — you change YAML, it gets committed, and Flux applies it. Talos node/control-plane config is declared in [talos/talconfig.yaml](talos/talconfig.yaml) and rendered with `talhelper`.

## Non-negotiable rules

These apply to **every** change. Do not check anything in that violates them.

1. **Tests must pass before commit.** Run:

   ```sh
   mise x -- task test:all
   ```

   This is `lint:all` (markdown, yaml, kubeconform, prettier/format) + `flux:validate`, which runs `flux build kustomization --dry-run` over each top-level kustomization (flux-system, crds, core, apps) and then `flux check`.
   Note: the `flux:*` steps are `ignore_error: true`, so `lint:all` is the hard gate. `flux-local` is only used by the separate `flux:diff:*` tasks (not part of `test:all`). CI runs the same task — keep it green.

2. **Every external artifact must be tracked by Renovate.** Charts, container images, GitHub-release tarballs, CRDs — all of it. If you add a dependency Renovate can't see, you've created drift.
   Make it trackable (see the Renovate section) and confirm it shows up on the **Renovate Dashboard** issue after the first run. Pin exact versions; never use `latest` for anything that ships to the cluster.

3. **Secrets are always SOPS-encrypted (age).** Never commit plaintext secrets. Files are `*.sops.yaml`; only `data`/`stringData` are encrypted. The age recipient is configured in [.sops.yaml](.sops.yaml). Use `task sops:...` helpers.

4. **Conventional commits, kept short.** `feat(scope): ...`, `fix(scope): ...`, etc. — Renovate relies on semantic commits. Keep messages to a few lines; do **not** add `Co-Authored-By` or other AI-attribution trailers.

5. **Keep documentation current.** A change that makes [README.md](README.md) or this file wrong is not done until the docs are fixed in the same change.
   When you add/remove a component, change the repo layout, swap a tool, or alter the workflow, update the affected docs.
   Docs must stay factual — describe what the repo actually does, not what it used to or might.

6. **Never set CPU limits.** CPU limits can cause unnecessary throttling in Kubernetes. Always define CPU requests to guarantee resources, but avoid setting CPU limits.

7. **Protect PII and local paths.** Never commit local filesystem paths, personal usernames, or any Personally Identifiable Information (PII).
   Since this repository is public, all local paths and personal metadata must be kept strictly out of committed code and documentation.

8. **Strictly adhere to the DRY (Don't Repeat Yourself) principle.** Never duplicate configurations, secrets, credentials, or code patterns across the cluster unless explicitly allowed to deviate.
   Any intentional deviation must be documented with a clear comment explaining why.

9. **Enforce least privilege and security isolation.** Workloads and tools must only have access to the bare minimum secrets, credentials, and network permissions required for their specific function.
   Never create monolithic shared secrets across multiple separate components.

10. **Completely fulfill approved implementation plans.** Before concluding execution, review the approved implementation plan to verify that
    all agreed-upon design details (authentication, secrets, networking, observability) are fully built and tested.

11. **Verify and pin container image tags.** Never use mutable `latest` image tags — always specify explicit, stable version tags for all container workloads and MCP servers.

## Toolchain

| Concern           | Choice                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OS / node config  | Talos Linux (`talhelper`, [talos/talconfig.yaml](talos/talconfig.yaml))                                                        |
| GitOps engine     | Flux                                                                                                                           |
| CNI / LB          | Cilium (BPF, no kube-proxy; L2/BGP LB)                                                                                         |
| Ingress           | Traefik via **Gateway API** (`internal-gateway` / `external-gateway` in `networking`)                                          |
| Auth              | Pocket ID (OIDC for capable apps; Traefik forward-auth via oauth2-proxy otherwise)                                             |
| Secrets           | SOPS+age (in-repo) and External Secrets Operator → Bitwarden (`ClusterSecretStore`)                                            |
| Policy            | Kyverno                                                                                                                        |
| Generic app chart | **bjw-s `app-template`** (OCI, pinned in [oci/app-template.yaml](cluster/flux/meta/repositories/oci/app-template.yaml))        |
| Metrics           | VictoriaMetrics + prometheus-operator (`ServiceMonitor` CRD)                                                                   |
| Dashboards        | grafana-operator (`GrafanaDashboard` CRD)                                                                                      |
| Timezone          | **k8tz** injects TZ cluster-wide — do **not** set per-app `TZ` env                                                             |
| Local tooling     | **mise** ([mise.toml](mise.toml)) pins kubectl, task, flux2, kubeconform, flux-local, etc. Run everything through `mise x --`. |
| Task runner       | go-task ([Taskfile.yml](Taskfile.yml) + [.taskfiles/](.taskfiles/))                                                            |

## Repository layout

```text
cluster/
  flux/meta/repositories/
    oci/     # OCIRepository sources (preferred)
    helm/    # HelmRepository sources (when no OCI exists)
  apps/
    <namespace>/             # one dir per namespace
      kustomization.yaml     # lists each app's ks.yaml + namespace.yaml
      <app>/
        ks.yaml              # Flux Kustomization (targetNamespace, path)
        app/
          kustomization.yaml # plain kustomize: lists the resources
          helmrelease.yaml   # (or helm-release.yaml — both spellings exist)
          httproute.yaml     # Gateway API route, if exposed
          *.sops.yaml        # SOPS secrets, if any
          externalsecret.yaml # ESO/Bitwarden, if used
talos/                       # talconfig.yaml, talsecret.sops.yaml
.taskfiles/                  # task definitions
.github/renovate*            # Renovate config + custom managers
```

## Adding an app — the standard pattern

1. **Source the chart.** Prefer an `OCIRepository` under `cluster/flux/meta/repositories/oci/` and register it in that dir's `kustomization.yaml`. Use `app-template` for most services.
   If a chart has no upstream OCI artifact, use the cosign-signed `ghcr.io/home-operations/charts-mirror/<chart>` OCI mirror before falling back to a `HelmRepository`. Pin the version on the `OCIRepository` `ref.tag`.
2. **HelmRelease.** For OCI sources, reference the source with `chartRef` (kind `OCIRepository`), **not** `chart.spec` — see [forgejo](cluster/apps/development/forgejo/app/helm-release.yaml)
   and [headlamp](cluster/apps/monitoring/headlamp/app/helmrelease.yaml) for the form.
3. **`ks.yaml`** — copy an existing one (e.g. [goldilocks](cluster/apps/monitoring/goldilocks/ks.yaml)): `targetNamespace`, `path: ./cluster/apps/<ns>/<app>/app`, `postBuild.substitute.APP`.
4. **`app/kustomization.yaml`** lists the resources.
5. **Register** the app's `ks.yaml` in `cluster/apps/<namespace>/kustomization.yaml`.
6. **Postgres database backups:** If the app uses a PostgreSQL database, you MUST add its database name to the `POSTGRES_DB` list in the `postgres16-backup` CronJob at [cronjob16.yaml](cluster/apps/databases/postgres/backups/cronjob16.yaml).
   Always prefer the postgres16 database instance - the postgres instance is mostly just used for immich since it needs vector extensions.
7. **Namespaces:** Do not specify `metadata.namespace` in application resource manifests (like Ingress, Service, ConfigMap, Secrets) unless absolutely necessary.
   Let the Flux `Kustomization`'s `targetNamespace` handle namespace assignment automatically.
8. **Stagger VolSync backups:** If the app uses VolSync, you MUST run `python3 scripts/stagger-volsync.py` to calculate and apply staggered backup start minutes to its `ks.yaml`.
9. Run `mise x -- task test:all`.

### Secrets

- Simple/global values: store in [cluster-secrets.sops.yaml](cluster/flux/meta/cluster-secrets.sops.yaml) and consume via Flux `postBuild` substitution as `${VAR}`
  (e.g. `${SECRET_DOMAIN}`, `${GRAFANA_OAUTH_CLIENTID}`). This is the lightest path for things like OIDC client IDs.
- App-scoped credentials from Bitwarden: use an `ExternalSecret` against a `bitwarden-*` `ClusterSecretStore` (see [paperless](cluster/apps/household/paperless/app/externalsecret.yaml)).
- App-local one-offs: a `*.sops.yaml` `Secret` in the app dir (see [minio](cluster/apps/databases/minio/app/)).

### Exposing a web UI (networking)

- Create an `HTTPRoute` (Gateway API), `parentRefs` → `internal-gateway` (or `external-gateway`) in `networking`, hostname `*.home.${SECRET_DOMAIN}` for internal.
- Attach Traefik middleware via `ExtensionRef` filters. `rfc1918-ips` restricts to LAN/VPN; `traefik-middleware-chain-pocket-id` adds Pocket ID forward-auth.
- Add `gatus.io/enabled: "true"` so the route is picked up by Gatus uptime monitoring.
- **Middleware availability:** Traefik resolves `ExtensionRef` middleware in the route's **own namespace**.
  Middlewares live in `networking` and are copied into other namespaces by the Kyverno policy [sync-middlewares.yaml](cluster/apps/system/kyverno/policies/sync-middlewares.yaml).
  If you reference a middleware in a namespace that doesn't yet receive it, add that namespace (or a new clone rule) to that policy.

### Monitoring an app

- Metrics: add a `ServiceMonitor` (prometheus-operator CRD) selecting the app's Service and port; no special labels are required for discovery.
- Dashboards: add a `GrafanaDashboard` CR with `instanceSelector.matchLabels.dashboards: grafana`.
  Use `url:`/`grafanaCom:` for published dashboards, or inline `json:` with a `datasources: [{inputName: DS_PROMETHEUS, datasourceName: Prometheus}]` mapping for hand-built ones.
  Keep it in the app's own dir (same namespace as the Grafana instance).

## Renovate — everything is tracked

Config: [.github/renovate.json5](.github/renovate.json5) + [.github/renovate/](.github/renovate/). Managers run over `cluster/**.ya?ml`, `talos/**`, and `.taskfiles/**`:

- **flux** — tracks `OCIRepository`/`HelmRepository` chart versions (the `ref.tag` and `HelmRelease` chart versions). This is why charts go through a pinned source.
- **helm-values** / **kubernetes** — track `image:` and `repository:`/`tag:` values inside HelmReleases and manifests (e.g. app-template `tag:`, raw `initContainers[].image`).
- **customManagers** — for anything else, annotate with a comment Renovate can parse:

  ```yaml
  # renovate: depName=owner/repo datasource=github-releases
  version: v1.2.3
  ```

  (regex defined in [customManagers.json5](.github/renovate/customManagers.json5)).

After adding a dependency, verify it appears on the **Renovate Dashboard** issue.
If it doesn't, it isn't being tracked — fix the source/annotation. Some Flux controller images are intentionally in `ignoreDeps` (managed by the Flux operator).

## Testing reference

- `mise x -- task test:all` — full suite (run before every commit).
- `mise x -- task test:flux:validate` — render + validate Flux resources only.
- `mise x -- task test:lint:all` — linters only.
- `mise x -- task test:flux:diff:all` — diff rendered manifests against the cluster.
