#!/usr/bin/env bash
# Prepares the persistent volume before the agent starts: clones the memory
# vault, then installs LifeOS into it, or upgrades it when the image carries
# another release. Safe to run on every start.
set -euo pipefail

: "${LIFEOS_CONFIG_DIR:?}" "${VAULT_REPO_URL:?}"
CONFIG_ROOT="$HOME/.claude"
PAYLOAD="${LIFEOS_PAYLOAD:-/opt/lifeos/LifeOS}"
VAULT="$LIFEOS_CONFIG_DIR/USER"
wanted="$(tr -d '[:space:]' <"$PAYLOAD/install/LIFEOS/VERSION")"
marker="$HOME/.lifeos-installed-version"

# LifeOS writes this path into its settings, whatever the environment says.
if [[ "$LIFEOS_CONFIG_DIR" != "$HOME/.config/LIFEOS" ]]; then
  echo "LIFEOS_CONFIG_DIR must be \$HOME/.config/LIFEOS" >&2
  exit 1
fi

if [[ ! -d "$VAULT/.git" ]]; then
  git clone "$VAULT_REPO_URL" "$VAULT"
fi

# LifeOS seeds its ignore rules (credentials, runtime state) only into a
# repository it creates itself, so a cloned vault without them gets them here,
# before anything is synced.
if [[ ! -f "$VAULT/.gitignore" ]]; then
  seed="$(mktemp -d)"
  bun -e 'const [engine, dir] = process.argv.slice(1); (await import(engine)).initUserDataRepo(dir);' \
    "$PAYLOAD/Tools/InstallEngine.ts" "$seed"
  cp "$seed/.gitignore" "$VAULT/.gitignore"
  rm -rf "$seed"
fi

if [[ -f "$marker" && "$(<"$marker")" == "$wanted" ]]; then
  echo "LifeOS $wanted already installed"
  exit 0
fi

mkdir -p "$CONFIG_ROOT/skills"
rm -rf "$CONFIG_ROOT/skills/LifeOS"
cp -r "$PAYLOAD" "$CONFIG_ROOT/skills/LifeOS"

# The core services are background daemons for a desktop with systemd; a pod
# runs none of them, nor the components that install such services.
bun "$CONFIG_ROOT/skills/LifeOS/Tools/InstallAll.ts" --yes \
  --config-root "$CONFIG_ROOT" \
  --components agents,commands,workflows \
  --decline-services pulse,pulse-menubar,deriver,conduit,conduit.insight,modelsync

printf '%s\n' "$wanted" >"$marker"
echo "LifeOS $wanted installed"
