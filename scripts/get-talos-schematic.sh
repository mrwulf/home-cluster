#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMATIC_FILE="${REPO_ROOT}/talos/schematic.yaml"
TALENV_FILE="${REPO_ROOT}/talos/talenv.yaml"
FACTORY_URL="https://factory.talos.dev/schematics"

if [ ! -f "${SCHEMATIC_FILE}" ]; then
  echo "ERROR: ${SCHEMATIC_FILE} not found" >&2
  exit 1
fi

get_schematic_id() {
  local id
  id="$(yq -o=json "${SCHEMATIC_FILE}" | curl -s -f -X POST "${FACTORY_URL}" -H "Content-Type: application/json" -d @- | jq -r '.id')"
  if [ -z "${id}" ] || [ "${id}" = "null" ]; then
    echo "ERROR: Failed to derive schematic ID from ${FACTORY_URL}" >&2
    exit 1
  fi
  echo "${id}"
}

MODE="${1:-id}"
VERSION="${2:-$(yq '.talosVersion' "${TALENV_FILE}" 2>/dev/null || echo "")}"

case "${MODE}" in
  id)
    get_schematic_id
    ;;
  image)
    id="$(get_schematic_id)"
    if [ -n "${VERSION}" ]; then
      echo "factory.talos.dev/metal-installer/${id}:${VERSION}"
    else
      echo "factory.talos.dev/metal-installer/${id}"
    fi
    ;;
  info)
    id="$(get_schematic_id)"
    echo "Schematic ID: ${id}"
    if [ -n "${VERSION}" ]; then
      echo "Installer Image: factory.talos.dev/metal-installer/${id}:${VERSION}"
    fi
    ;;
  *)
    echo "Usage: $0 [id|image|info] [version]" >&2
    exit 1
    ;;
esac
