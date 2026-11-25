#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME"
# shellcheck source=git-setup.sh
source /usr/local/lib/lifeos-agent/git-setup.sh
exec lifeos-bootstrap
