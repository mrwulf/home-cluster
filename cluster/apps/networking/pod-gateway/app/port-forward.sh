#!/bin/sh
# Run by gluetun (VPN_PORT_FORWARDING_UP_COMMAND) every time PIA assigns a forwarded port.
# gluetun, the pod-gateway "main" container and its firewall share one network namespace.
#
#   1. Forward that one port (TCP+UDP) from the VPN interface to qBittorrent only. The gateway otherwise
#      rejects all new inbound traffic on the VPN interface, so without this the port is closed.
#   2. Tell qBittorrent to listen on it.
#
# Usage: port-forward.sh <port>
set -eu

PORT="$1"
case "$PORT" in
  '' | *[!0-9]*)
    echo "invalid port: $PORT" >&2
    exit 1
    ;;
esac

VPN_IF=tun0
# qBittorrent's static address on the gateway's VXLAN network: VXLAN_IP_NETWORK + publicPorts IP in helm-release.yaml.
QBT_IP=172.16.1.10
QBT_API=http://qbittorrent.vpn.svc.cluster.local/api/v2/app/setPreferences

ipt() { iptables -w 5 "$@"; }

# Own chains, flushed on every run, so a new port replaces the old one instead of piling up rules.
ipt -t nat -N PF_QBT 2> /dev/null || true
ipt -t nat -F PF_QBT
ipt -N PF_QBT 2> /dev/null || true
ipt -F PF_QBT

# The gateway masquerades everything it sends out; exempt VXLAN-bound traffic so qBittorrent sees each peer's
# real address (libtorrent allows one connection per IP, so peers all appearing as the gateway would be dropped).
ipt -t nat -C POSTROUTING -o vxlan0 -j ACCEPT 2> /dev/null || ipt -t nat -I POSTROUTING 1 -o vxlan0 -j ACCEPT
ipt -t nat -C PREROUTING -i "$VPN_IF" -j PF_QBT 2> /dev/null || ipt -t nat -A PREROUTING -i "$VPN_IF" -j PF_QBT
# Ahead of the gateway's catch-all "-i tun0 -j REJECT".
ipt -C FORWARD -i "$VPN_IF" -j PF_QBT 2> /dev/null || ipt -I FORWARD 1 -i "$VPN_IF" -j PF_QBT

for proto in tcp udp; do
  ipt -t nat -A PF_QBT -p "$proto" --dport "$PORT" -j DNAT --to-destination "$QBT_IP:$PORT"
  ipt -A PF_QBT -p "$proto" -d "$QBT_IP" --dport "$PORT" -j ACCEPT
done

wget -q -O- --tries=10 --waitretry=5 --retry-connrefused \
  --post-data "json={\"listen_port\":$PORT}" "$QBT_API"
echo "forwarded port $PORT to qbittorrent"
