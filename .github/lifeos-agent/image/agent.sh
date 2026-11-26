#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=git-setup.sh
source /usr/local/lib/lifeos-agent/git-setup.sh
: "${ROWBOAT_URL:?}" "${ROWBOAT_ADDRESS:?}" "${ROWBOAT_AGENT_KEY:?}" "${CLAUDE_CODE_OAUTH_TOKEN:?}"
# tini runs as PID 1 to reap the processes LifeOS's hooks leave behind, which
# the worker would not. It starts here, not as the image's entrypoint, because a
# Kubernetes `command` replaces the entrypoint.
exec tini -- node /opt/rowboat-worker.cjs \
  --agent claude \
  --url "$ROWBOAT_URL" \
  --address "$ROWBOAT_ADDRESS" \
  --cwd /work \
  --state /data/worker \
  --system-prompt-file "$HOME/.claude/LIFEOS/LIFEOS_SYSTEM_PROMPT.md" \
  --model "${AGENT_MODEL:-sonnet}" \
  --max-concurrent 1 \
  --turn-timeout "${AGENT_TURN_TIMEOUT_SECONDS:-1200}"
