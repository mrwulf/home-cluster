#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TALOS_DIR="${REPO_ROOT}/talos"
OUTPUT_DIR="${TALOS_DIR}/clusterconfig"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# Derive schematicId dynamically from talos/schematic.yaml using the Talos Image Factory
schematicId="$("${REPO_ROOT}/scripts/get-talos-schematic.sh" id)"
export schematicId
echo "Derived schematic ID: ${schematicId}"

# Decrypt environment variables from talenv.yaml and talenv.sops.yaml
eval "$(yq -r 'to_entries | .[] | "export " + .key + "=\"" + .value + "\""' "${TALOS_DIR}/talenv.yaml")"
eval "$(sops -d "${TALOS_DIR}/talenv.sops.yaml" | yq -r 'to_entries | .[] | "export " + .key + "=\"" + .value + "\""')"

# Decrypt Talos secrets
sops -d "${TALOS_DIR}/talsecret.sops.yaml" > "${TMP_DIR}/secrets.yaml"

# Generate base configurations and client talosconfig
talosctl gen config "${clusterName}" "https://${clusterEndpointIP}:6443" \
  --with-secrets "${TMP_DIR}/secrets.yaml" \
  --output-dir "${TMP_DIR}/base" \
  --with-cluster-discovery=true >/dev/null

mkdir -p "${OUTPUT_DIR}"
cp "${TMP_DIR}/base/talosconfig" "${OUTPUT_DIR}/talosconfig"

# Collect control plane IPs dynamically from node patches for talosconfig endpoints & nodes
CONTROL_IPS=()
for f in "${TALOS_DIR}"/patches/nodes/*.yaml; do
  [ -f "$f" ] || continue
  if [ "$(yq 'select(document_index == 0) | .machine.type // "controlplane"' "$f")" = "controlplane" ]; then
    ip="$(yq 'select(.kind == "BondConfig") | .addresses[].address' "$f" 2>/dev/null | cut -d/ -f1)"
    [ -n "$ip" ] && CONTROL_IPS+=("$ip")
  fi
done
if [ ${#CONTROL_IPS[@]} -gt 0 ]; then
  talosctl config endpoint "${CONTROL_IPS[@]}" --talosconfig "${OUTPUT_DIR}/talosconfig"
  talosctl config node "${CONTROL_IPS[@]}" --talosconfig "${OUTPUT_DIR}/talosconfig"
fi

# Render patch files with envsubst
mkdir -p "${TMP_DIR}/rendered/common" "${TMP_DIR}/rendered/controlplane" "${TMP_DIR}/rendered/nodes"

for p in "${TALOS_DIR}"/patches/common/*.yaml; do
  [ -f "$p" ] || continue
  envsubst < "$p" > "${TMP_DIR}/rendered/common/$(basename "$p")"
done

for p in "${TALOS_DIR}"/patches/controlplane/*.yaml; do
  [ -f "$p" ] || continue
  envsubst < "$p" > "${TMP_DIR}/rendered/controlplane/$(basename "$p")"
done

for p in "${TALOS_DIR}"/patches/nodes/*.yaml; do
  [ -f "$p" ] || continue
  envsubst < "$p" > "${TMP_DIR}/rendered/nodes/$(basename "$p")"
done

# Prepare patch arguments (sorted order for deterministic generation)
COMMON_PATCHES=()
for p in $(ls "${TMP_DIR}"/rendered/common/*.yaml | sort); do
  [ -f "$p" ] || continue
  COMMON_PATCHES+=(--patch "@$p")
done

CONTROLPLANE_PATCHES=()
for p in $(ls "${TMP_DIR}"/rendered/controlplane/*.yaml | sort); do
  [ -f "$p" ] || continue
  CONTROLPLANE_PATCHES+=(--patch "@$p")
done

# Strip default HostnameConfig resource from base configs so node patches have full control
yq 'select(.kind != "HostnameConfig") | del(.machine.install.disk) | del(.cluster.apiServer.admissionControl) | del(.machine.nodeLabels."node.kubernetes.io/exclude-from-external-load-balancers")' "${TMP_DIR}/base/controlplane.yaml" > "${TMP_DIR}/base/controlplane-clean.yaml"
yq 'select(.kind != "HostnameConfig") | del(.machine.install.disk)' "${TMP_DIR}/base/worker.yaml" > "${TMP_DIR}/base/worker-clean.yaml"

# Process each node
for node_file in $(ls "${TALOS_DIR}"/patches/nodes/*.yaml | sort); do
  [ -f "$node_file" ] || continue
  node_name="$(basename "$node_file" .yaml)"
  rendered_node="${TMP_DIR}/rendered/nodes/${node_name}.yaml"
  node_type="$(yq 'select(document_index == 0) | .machine.type // "controlplane"' "${rendered_node}")"

  if [ "${node_type}" = "controlplane" ]; then
    talosctl machineconfig patch "${TMP_DIR}/base/controlplane-clean.yaml" \
      "${COMMON_PATCHES[@]}" \
      "${CONTROLPLANE_PATCHES[@]}" \
      --patch "@${rendered_node}" \
      --output "${OUTPUT_DIR}/${clusterName}-${node_name}.yaml"
  else
    talosctl machineconfig patch "${TMP_DIR}/base/worker-clean.yaml" \
      "${COMMON_PATCHES[@]}" \
      --patch "@${rendered_node}" \
      --output "${OUTPUT_DIR}/${clusterName}-${node_name}.yaml"
  fi

  # Post-process to ensure clean keys and remove any unselected default disk
  yq -i 'del(.machine.install.disk)' "${OUTPUT_DIR}/${clusterName}-${node_name}.yaml"

  echo "generated config for ${node_name} (${node_type}) in ./clusterconfig/${clusterName}-${node_name}.yaml"
done

echo "generated client config in ./clusterconfig/talosconfig"
echo '*' > "${OUTPUT_DIR}/.gitignore"
echo "generated .gitignore file in ./clusterconfig/.gitignore"
