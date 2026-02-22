#!/bin/bash

apt update && 
  apt install -y curl ca-certificates gettext-base bash-completion command-not-found python3-pip &&
  apt update
mkdir -p /home/coder/bin
cd /home/coder/bin


echo "Installing mise-en-place..."
curl https://mise.run | sh

/home/coder/.local/bin/mise prepare

# echo "Installing kubectl..."
# curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"

# echo "Installing talosctl..."
# curl -Lo talosctl https://github.com/siderolabs/talos/releases/latest/download/talosctl-linux-amd64

# echo "Installing jq..."
# curl -Lo jq https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64

# echo "Installing yq..."
# curl -Lo yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64

# chmod +x kubectl talosctl jq yq
# chown -R 1000:1000 /home/coder/bin
