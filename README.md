# Basic Startup
```
# Install dependencies
## Install go-task on your own (https://taskfile.dev/installation/)
## If using macos, `brew install grep,awk`
## Install all the other dependencies (reference just the install taskfile so VARS don't need the dependencies)
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

# Tools
* [talos](https://talos.dev)
* [talhelper](https://github.com/budimanjojo/talhelper)
* [flux](https://toolkit.fluxcd.io/)
* [sops](https://toolkit.fluxcd.io/guides/mozilla-sops/)
* [age](https://github.com/FiloSottile/age)
* [go-task](https://github.com/go-task/task)
* [pre-commit](https://github.com/pre-commit/pre-commit)
* [helm](https://helm.sh/)
* [kustomize](https://kustomize.io/)

# Components
- [authentik](https://goauthentik.io) - IDp + SSO
- [cert-manager](https://cert-manager.io/) - SSL certificates - with Cloudflare DNS challenge
- [flux](https://toolkit.fluxcd.io/) - GitOps tool for deploying manifests from the `cluster` directory
- [kasten k10](https://www.kasten.io/product/) - backup implementation
- [kyverno](https://kverno.io) - policy engine
- [reloader](https://github.com/stakater/Reloader) - restart pods when Kubernetes `configmap` or `secret` changes
- [traefik](https://traefik.io) - ingress controller
- [rook](https://rook.io) - operator for ceph

## :open_file_folder:&nbsp; Repository structure

The Git repository contains the following directories under `cluster` and are ordered below by how Flux will apply them.

- **base** directory is the entrypoint to Flux
- **crds** directory contains custom resource definitions (CRDs) that need to exist globally in your cluster before anything else exists
- **core** directory (depends on **crds**) are important infrastructure applications (grouped by namespace) that should never be pruned by Flux
- **apps** directory (depends on **core**) is where your common applications (grouped by namespace) could be placed, Flux will prune resources here if they are not tracked by Git anymore

# My Cluster

| Node                                                   | Role                                                  | Specs                                                  |
|--------------------------------------------------------|----------------------------------------------------------|----------------------------------------------------------|
| node1 | Control Plane, Storage | MinisForum MS-01 12600H<br />96G |
| node2 | Control Plane, Storage | MinisForum MS-01 12600H<br />96G |
| node3 | Control Plane, Storage | MinisForum MS-01 12600H<br />96G |


# Other Stuff
