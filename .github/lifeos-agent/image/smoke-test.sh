#!/usr/bin/env bash
# Run inside the built image by the workflow: bootstrap LifeOS onto an empty
# home against a local, empty vault repository, restart, and sync once.
set -euo pipefail

export HOME=/tmp/home FORGEJO_URL=/tmp/server FORGEJO_USER=smoke FORGEJO_TOKEN=unused VAULT_REPO=owner/vault
export LIFEOS_CONFIG_DIR="$HOME/.config/LIFEOS"
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.com
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.com

git init --quiet --bare --initial-branch=main "$FORGEJO_URL/$VAULT_REPO.git"

claude --version
node /opt/rowboat-worker.cjs --help

# The agent must start under tini, or hook processes pile up as zombies.
tini --version
grep -q '^exec tini -- node ' "$(command -v lifeos-agent)"

lifeos-init
lifeos-init
test -f "$HOME/.claude/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"
test -f "$HOME/.claude/settings.json"
test -L "$HOME/.claude/LIFEOS/MEMORY"

VAULT_SYNC_SECONDS=1 timeout --preserve-status --signal=TERM 10 lifeos-vault-sync
git -C "$FORGEJO_URL/$VAULT_REPO.git" log --oneline main | head -3

# Nothing the ignore rules cover may reach the vault repository.
mkdir -p "$LIFEOS_CONFIG_DIR/USER/CONFIG/CREDENTIALS"
echo probe >"$LIFEOS_CONFIG_DIR/USER/CONFIG/CREDENTIALS/probe"
echo probe >"$LIFEOS_CONFIG_DIR/USER/probe.env"
VAULT_SYNC_SECONDS=1 timeout --preserve-status --signal=TERM 5 lifeos-vault-sync
if git -C "$FORGEJO_URL/$VAULT_REPO.git" ls-tree -r --name-only main | grep -E '(^|/)probe(\.env)?$'; then
  echo "an ignored file reached the vault repository" >&2
  exit 1
fi
echo "smoke test passed"
