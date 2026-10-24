#!/bin/bash
# Entrypoint of the codeman sidecar. Everything it needs lives on the shared PVC:
# setup-tools.sh in the main container installs mise, node, claude and codeman,
# and the dotfiles agents profile (mise.agents.toml) provides tmux, kubectl and
# talosctl. Until the SSH key and clone URL are in place that profile is missing,
# so this waits instead of starting a Codeman that cannot create sessions.
set -u

# No braces around PATH here: Flux postBuild substitution would blank the braced form.
export PATH="/home/coder/.local/bin:/home/coder/.local/share/mise/shims:$PATH"

until mise exec -- sh -c 'command -v codeman && command -v tmux' >/dev/null 2>&1; do
  echo "waiting for codeman and tmux; tmux comes from the dotfiles agents profile (see /home/coder/setup.log)"
  sleep 10
done

# Foreground, so the log goes to stdout instead of ~/.codeman/web.log.
# Access is gated by the Pocket ID forward-auth on the route; the flag only
# acknowledges that Codeman itself has no login.
exec mise exec -- codeman web -H 0.0.0.0 --port 3000 --allow-unauthenticated-network
