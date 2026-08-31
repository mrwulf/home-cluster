# AddApp Workflow

Scaffold a standard app-template-based workload. Follow [CLAUDE.md § Adding an app — the standard pattern](../../../../CLAUDE.md) step by step; this workflow only adds the decision points CLAUDE.md leaves implicit.

## Steps

1. **Source the chart** as an `OCIRepository` under `cluster/flux/meta/repositories/oci/` (register it in that dir's `kustomization.yaml`), pinned to an exact `ref.tag`. Fall back to the `ghcr.io/home-operations/charts-mirror/<chart>` mirror, then a `HelmRepository`, only if no upstream OCI artifact exists.
2. **`ks.yaml`** — copy an existing simple one, e.g. `cluster/apps/monitoring/goldilocks/ks.yaml`. Set `targetNamespace`, `path: ./cluster/apps/<ns>/<app>/app`, `postBuild.substitute.APP`.
3. **`app/helmrelease.yaml`** — `chartRef` (kind `OCIRepository`), never `chart.spec`, for OCI sources.
4. **`app/kustomization.yaml`** lists the resources for this app.
5. **Register** the `ks.yaml` in `cluster/apps/<namespace>/kustomization.yaml`.
6. Resolve the Decision Checklist in `../SKILL.md` (DB, auth, storage, mail, monitoring) against CLAUDE.md's Pattern reference table — copy the matching example verbatim, then adapt.
7. If the app uses VolSync, run `python3 scripts/stagger-volsync.py` — do not skip this, unstaggered backups collide.
8. Run `mise x -- task test:all`. Fix everything `lint:all` reports; ignore `✗` lines that come only from the `flux:*` ignore_error steps.
9. Update CLAUDE.md's Pattern reference table if this app becomes the new canonical example for a pattern that didn't have a good one yet.

## Namespace choice

Pick the existing `cluster/apps/<namespace>/` that matches the app's domain (`household`, `media`, `monitoring`, `development`, `databases`, `ai`, ...). Don't invent a new namespace for a single app unless nothing existing fits.
