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
| control-01 | Control Plane, Storage | HP EliteDesk 800 G6 MFF<br />Intel 10700t<br />32G |
| control-02 | Control Plane, Storage | HP EliteDesk 800 G6 MFF<br />Intel 10700t<br />32G |
| control-03 | Control Plane | Lenovo m70q Tiny<br /> Intel 10700t<br />32G |
| worker-01 | Worker, Storage | Dell 7090 mini<br /> Intel 10700<br />32G |

# Other Stuff
