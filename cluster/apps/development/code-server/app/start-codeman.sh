#!/bin/bash
# Entrypoint of the codeman sidecar. The user-space tools (mise, node, claude,
# codeman, dotfiles-managed CLIs) are installed onto the shared PVC by
# setup-tools.sh in the main container; apt packages are per container, so the
# one the agents need is installed here.
set -u

sudo apt-get update
sudo apt-get install -y --no-install-recommends tmux

# No braces around PATH here: Flux postBuild substitution would blank the braced form.
export PATH="/home/coder/.local/bin:/home/coder/.local/share/mise/shims:$PATH"

until mise exec node -- sh -c 'command -v codeman' >/dev/null 2>&1; do
  echo "waiting for setup-tools.sh to install codeman (see /home/coder/setup.log)"
  sleep 10
done

# Foreground, so the log goes to stdout instead of ~/.codeman/web.log.
# Access is gated by the Pocket ID forward-auth on the route; the flag only
# acknowledges that Codeman itself has no login.
exec mise exec node -- codeman web -H 0.0.0.0 --port 3000 --allow-unauthenticated-network
