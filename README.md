# Basic Startup

```bash
# Install dependencies
# Install go-task on your own (https://taskfile.dev/installation/)
# If using macos, `brew install grep,awk`
# Install all the other dependencies
# (reference just the install taskfile so VARS don't need the dependencies)
task --taskfile .taskfiles/install.yml all

# Set up age/sops
task sops:init
## Replace the public key in .sops.yaml

# Friends don't let friends commit secrets
task pre-commit:init

# Configure your cluster
task talos:generate-secrets
## Edit ./talos/talconfig.yaml
task talos:generate-configs

# Boot nodes to talos

# Apply configuration to each node
task talos:apply-config -- <node>

# ONLY ONCE! Bootstrap a single node
talos -n $(task talos:get-a-node) bootstrap

# Install cilium
helmfile apply -f talos/cilium-helmfile.yaml

# Approve all of the certificates
kubectl get csr -o name | xargs kubectl certificate approve

# Add age secret to the cluster
sops -d age-key.secret.sops.yaml | kubectl apply -f -

#
gh auth token | helm registry login ghcr.io -u {my_github_user} --password-stdin

# Install flux
helmfile apply -f talos/flux-helmfile.yaml


```

## Tools

- [talos](https://talos.dev)
- [talhelper](https://github.com/budimanjojo/talhelper)
- [flux](https://toolkit.fluxcd.io/)
- [sops](https://toolkit.fluxcd.io/guides/mozilla-sops/)
- [age](https://github.com/FiloSottile/age)
- [go-task](https://github.com/go-task/task)
- [pre-commit](https://github.com/pre-commit/pre-commit)
- [helm](https://helm.sh/)
- [helmfile](https://github.com/helmfile/helmfile)
- [kustomize](https://kustomize.io/)
- [mise](https://mise.jdx.dev/)

## Testing

Run all the tests locally that normally run in GitHub Actions CI.

## Install Testing Tools

```bash
# Install all tools via mise
mise install
```

## Run Tests

```bash
# Run all tests (like CI)
task test:all

# Run a quick test (skips slower Kubernetes validation)
task test:quick

# Run all linters
task test:lint:all

# Run individual linters
task test:lint:markdown    # Lint markdown files
task test:lint:yaml        # Lint YAML files
task test:lint:kubernetes  # Validate Kubernetes manifests with kubeconform
task test:lint:format      # Check code formatting with prettier

# Auto-fix formatting issues
task test:fix
```

## Flux Validation

```bash
# Validate Flux resources locally
task test:flux:validate

# Show diffs for all Flux resources
task test:flux:diff:all
```

## Components

- [cilium](https://cilium.io) - CNI, kube-proxy replacement, and load balancer
- [pocket-id](https://pocket-id.org) - IdP + SSO
- [cert-manager](https://cert-manager.io/) - SSL certificates, with Cloudflare DNS challenge
- [external-secrets](https://external-secrets.io) - syncs secrets from Bitwarden
- [flux](https://toolkit.fluxcd.io/) - GitOps tool for deploying manifests from the `cluster` directory
- [kyverno](https://kyverno.io) - policy engine
- [reloader](https://github.com/stakater/Reloader) - restart pods when Kubernetes `configmap` or `secret` changes
- [traefik](https://traefik.io) - ingress controller (Gateway API)
- [rook](https://rook.io) - operator for ceph
- [volsync](https://volsync.readthedocs.io) - restic-based volume backups (`backups` namespace)

## :open_file_folder:&nbsp; Repository structure

Cluster state lives under `cluster/`:

- **apps/** — all workloads, grouped by namespace (`monitoring`, `networking`, `databases`, ...).
  Each app is `apps/<namespace>/<app>/` with a Flux `ks.yaml` plus an `app/` kustomize dir.
  `apps/flux-system/` bootstraps Flux itself (flux-operator + flux-instance) and is the entrypoint;
  `apps/kustomization.yaml` lists every namespace.
- **flux/** — Flux machinery: `flux/meta/repositories/` holds chart sources (`oci/`, `helm/`),
  and the cluster-wide SOPS secrets / `postBuild` substitution values.
- **templates/** — reusable kustomize components (e.g. volsync).

Talos node configuration lives under `talos/` ([talconfig.yaml](talos/talconfig.yaml)).

## My Cluster

| Node  | Role                   | Specs                        |
| ----- | ---------------------- | ---------------------------- |
| node1 | Control Plane, Storage | MinisForum MS-01 12600H, 96G |
| node2 | Control Plane, Storage | MinisForum MS-01 12600H, 96G |
| node3 | Control Plane, Storage | MinisForum MS-01 12600H, 96G |

## Other Stuff
