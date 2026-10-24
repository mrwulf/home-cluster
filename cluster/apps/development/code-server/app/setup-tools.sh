#!/bin/bash
# Started by the main container's postStart hook through sudo. Root only does the
# apt step, then the script runs again as coder so everything else (mise, node,
# claude, codeman, dotfiles) lands on the PVC owned by coder. Under root, HOME is
# /root and those installs would be lost at every pod restart.

if [ "$(id -u)" = 0 ]; then
  apt update &&
    apt install -y curl ca-certificates gettext-base bash-completion command-not-found python3-pip vim &&
    apt update
  exec runuser -u coder -- env HOME=/home/coder bash "$0"
fi

mkdir -p /home/coder/bin
cd /home/coder/bin

export PATH="/home/coder/.local/bin:$PATH"

if ! command -v mise >/dev/null 2>&1; then
  echo "Installing mise-en-place..."
  curl https://mise.run | sh
fi
mise install

echo "Installing Node.js..."
mise use -g node@lts

echo "Installing Claude Code..."
# renovate: datasource=npm depName=@anthropic-ai/claude-code
mise exec node -- npm install -g @anthropic-ai/claude-code@2.1.283

echo "Installing Codeman..."
# renovate: datasource=npm depName=aicodeman
mise exec node -- npm install -g aicodeman@1.44.0

echo "Aliasing code -> code-server for VS Code CLI compatibility..."
ln -sf /usr/bin/code-server /home/coder/.local/bin/code

# CLI versions (kubectl, talosctl, sops, age, jq, yq, flux2, ...) are owned by the
# dotfiles repo's agents profile (mise.agents.toml), not pinned here.
# Neither the SSH key nor the clone URL is in this public repo: on first setup,
# copy a key with access to Forgejo into /home/coder/.ssh and write the clone URL
# into /home/coder/.config/dotfiles-repo, then restart the pod.
DOTFILES=/home/coder/myhome/GitRoot/dotfiles
DOTFILES_URL_FILE=/home/coder/.config/dotfiles-repo
if ls /home/coder/.ssh/id_* >/dev/null 2>&1 && [ -s "$DOTFILES_URL_FILE" ]; then
  export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"
  if [ -d "$DOTFILES/.git" ]; then
    echo "Updating dotfiles..."
    git -C "$DOTFILES" pull --ff-only
  else
    echo "Cloning dotfiles..."
    mkdir -p "$(dirname "$DOTFILES")"
    git clone "$(cat "$DOTFILES_URL_FILE")" "$DOTFILES"
  fi
  if [ -f "$DOTFILES/mise.agents.toml" ]; then
    echo "Installing agent CLIs from dotfiles..."
    # conf.d, not config.toml: `mise use -g` above writes config.toml, and a
    # symlink there would send those writes into the dotfiles checkout.
    mkdir -p /home/coder/.config/mise/conf.d
    ln -sf "$DOTFILES/mise.agents.toml" /home/coder/.config/mise/conf.d/agents.toml
    mise trust /home/coder/.config/mise/conf.d/agents.toml
    mise install
  else
    echo "dotfiles has no mise.agents.toml yet, skipping CLI install"
  fi
else
  echo "No SSH key in /home/coder/.ssh or no $DOTFILES_URL_FILE, skipping dotfiles"
fi
