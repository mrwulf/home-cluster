#!/usr/bin/env bash
# Keeps the memory vault and its Forgejo repository in step: commit what the
# agent wrote, take what was edited elsewhere, push. A person resolves conflicts.
set -uo pipefail
# shellcheck source=git-setup.sh
source /usr/local/lib/lifeos-agent/git-setup.sh
: "${LIFEOS_CONFIG_DIR:?}"
cd "$LIFEOS_CONFIG_DIR/USER" || exit 1
# Without the ignore rules, `git add -A` would publish credential files.
if [[ ! -f .gitignore ]]; then
  echo "vault sync: the vault has no .gitignore; refusing to sync" >&2
  exit 1
fi

sync_once() {
  local branch remote_head
  branch="$(git symbolic-ref --short HEAD)" || return 1
  git add -A || return 1
  if ! git diff --cached --quiet; then
    git commit --quiet -m "chore(memory): sync agent changes" || return 1
  fi
  # A new, empty vault has nothing to push yet.
  git rev-parse --quiet --verify HEAD >/dev/null || return 0
  remote_head="$(git ls-remote --heads origin "$branch")" || return 1
  if [[ -n "$remote_head" ]] && ! git pull --quiet --rebase origin "$branch"; then
    git rebase --abort 2>/dev/null
    # The agent's side goes to its own branch, so it can be merged in Forgejo.
    git push --quiet --force origin "HEAD:refs/heads/agent-conflict" || return 1
    echo "vault sync: conflict with origin/$branch; merge the agent-conflict branch in the vault repository" >&2
    return 1
  fi
  git push --quiet origin "HEAD:$branch"
}

running=true
trap 'running=false' TERM INT
while $running; do
  sync_once || echo "vault sync failed; retrying" >&2
  sleep "${VAULT_SYNC_SECONDS:-120}" &
  wait $!
done
sync_once
