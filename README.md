# Basic Startup
```
# Install dependencies
## Install go-task on your own (https://taskfile.dev/installation/)
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

# Add age secret to the cluster

# Configure flux base repo

# Install flux

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
- [cert-manager](https://cert-manager.io/) - SSL certificates - with Cloudflare DNS challenge
- [flux](https://toolkit.fluxcd.io/) - GitOps tool for deploying manifests from the `cluster` directory
- [hajimari](https://github.com/toboshii/hajimari) - start page with ingress discovery
- [metallb](https://metallb.universe.tf/) - bare metal load balancer
- [reloader](https://github.com/stakater/Reloader) - restart pods when Kubernetes `configmap` or `secret` changes
- [traefik](https://traefik.io) - ingress controller

## :open_file_folder:&nbsp; Repository structure

The Git repository contains the following directories under `cluster` and are ordered below by how Flux will apply them.

- **base** directory is the entrypoint to Flux
- **crds** directory contains custom resource definitions (CRDs) that need to exist globally in your cluster before anything else exists
- **core** directory (depends on **crds**) are important infrastructure applications (grouped by namespace) that should never be pruned by Flux
- **apps** directory (depends on **core**) is where your common applications (grouped by namespace) could be placed, Flux will prune resources here if they are not tracked by Git anymore

```
cluster
├── apps
│   ├── default
│   ├── networking
│   └── system-upgrade
├── base
│   └── flux-system
├── core
│   ├── cert-manager
│   ├── metallb-system
│   ├── namespaces
│   └── system-upgrade
└── crds
    └── cert-manager
```

# My Cluster

| Node                                                   | Role                                                  | Specs                                                  |
|--------------------------------------------------------|----------------------------------------------------------|----------------------------------------------------------|
| delta | Control Plane | Dell Optiplex 7040 MFF<br />Intel 6700t<br />24G |
| epsilon | Worker | Dell Optiplex 7050 MFF<br />Intel 7500t<br />16G |
| zeta | Control Plane | Dell Optiplex 7040 MFF<br />Intel 6700t<br />16G |
| eta | Control Plane | Dell Optiplex 7040 MFF<br />Intel 6700t<br />24G |

# Other Stuff
