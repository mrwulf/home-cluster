#!/usr/bin/env bash
# Pre-commit hook: block known PII (personal domains, etc.) from being committed.
# The actual pattern lives SOPS-encrypted (age) in pii.sops.yaml next to this
# script, never in plaintext in this repo — see .sops.yaml.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pattern_file="${repo_root}/.github/linters/pii.sops.yaml"

if ! command -v sops >/dev/null 2>&1 || ! command -v yq >/dev/null 2>&1; then
    echo "warning: sops/yq not found on PATH — skipping PII check" >&2
    exit 0
fi

pattern="$(sops -d "${pattern_file}" 2>/dev/null | yq -r '.stringData.PATTERNS' 2>/dev/null || true)"

if [[ -z "${pattern}" || "${pattern}" == "null" ]]; then
    echo "warning: could not decrypt PII patterns (missing age key?) — skipping check" >&2
    exit 0
fi

if grep -InE "${pattern}" "$@"; then
    echo "error: matched forbidden PII above (see .github/linters/pii.sops.yaml)" >&2
    exit 1
fi

exit 0
