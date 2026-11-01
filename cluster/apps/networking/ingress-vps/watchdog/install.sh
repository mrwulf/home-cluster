#!/usr/bin/env bash
# Install the ingress watchdog on an edge VPS. Run as root by the OpenTofu provisioner after it
# uploads the watchdog files to /tmp; idempotent, safe to re-run.
set -eu

src=/tmp/ingress-watchdog
install -o root -g root -m 0755 "$src.sh" /usr/local/bin/ingress-watchdog
install -o root -g root -m 0644 "$src.service" /etc/systemd/system/ingress-watchdog.service
install -o root -g root -m 0644 "$src.timer" /etc/systemd/system/ingress-watchdog.timer
install -o root -g root -m 0644 "$src.env" /etc/default/ingress-watchdog
rm -f "$src.sh" "$src.service" "$src.timer" "$src.env"

# Let the already-scraped node-exporter publish the watchdog's counters. Deliberate deviation
# from "units come only from cloud-init": the unit is patched in place because editing user_data
# would replace the instance. The host root is already mounted at /rootfs, so no new mount is
# needed; a rebuilt VPS gets the unpatched unit again and this script patches it on first apply.
mkdir -p /var/lib/node_exporter/textfile /var/lib/ingress-watchdog
unit=${NODE_EXPORTER_UNIT:-/etc/systemd/system/node-exporter.service}
if ! grep -q 'collector.textfile.directory' "$unit"; then
  sed -i 's|^\( *\)--web.listen-address=:9100$|\1--web.listen-address=:9100 \\\n\1--collector.textfile.directory=/rootfs/var/lib/node_exporter/textfile|' "$unit"
  grep -q 'collector.textfile.directory' "$unit" || { echo "failed to patch $unit" >&2; exit 1; }
  restart_node_exporter=1
fi

systemctl daemon-reload
# Enable the watchdog first: on a fresh VPS this runs while cloud-init is still installing docker,
# and nothing after the node-exporter step may be able to stop the timer from being enabled.
systemctl enable ingress-watchdog.timer
systemctl restart ingress-watchdog.timer

# try-restart only acts if node-exporter is already running. During first boot it isn't (docker is
# not installed yet) and cloud-init starts it later from the patched unit; a plain restart fails
# there because the unit requires docker.service.
if [ "${restart_node_exporter:-0}" = 1 ]; then
  systemctl try-restart node-exporter || echo "node-exporter try-restart failed; it will pick up the patched unit on its next start" >&2
fi
