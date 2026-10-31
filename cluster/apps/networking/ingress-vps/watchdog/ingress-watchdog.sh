#!/usr/bin/env bash
# Self-heal the edge VPS ingress path. Checks each layer bottom-up and restarts only the
# lowest failing one, since a lower layer being broken makes every layer above it look broken:
#   docker -> wg0 uplink -> NetBird -> NetBird relay -> Traefik -> end-to-end probe
# Failures are debounced, and repairs are rate-limited with a growing backoff so a cluster
# outage (which fails the end-to-end probe on its own) can't turn into a restart loop.
set -u

: "${PROBE_HOST:?PROBE_HOST must be set}"
FAILS_BEFORE_ACTION=${FAILS_BEFORE_ACTION:-2}
COOLDOWN=${COOLDOWN:-240}
WG_STALE=${WG_STALE:-300}
STATE=${STATE:-/run/ingress-watchdog}
BOOT_FINISHED=${BOOT_FINISHED:-/var/lib/cloud/instance/boot-finished}
LAYERS=(docker wg netbird relay traefik e2e)

log() { logger -t ingress-watchdog -- "$*"; echo "$*"; }
counter() { cat "$STATE/$1" 2>/dev/null || echo 0; }
port_open() { timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null; }

# Never touch services cloud-init is still bringing up.
[ -f "$BOOT_FINISHED" ] || exit 0
mkdir -p "$STATE"

check_docker() { systemctl is-active --quiet docker; }

# PersistentKeepalive keeps the session re-keying every ~2m while the peer answers.
check_wg() {
  local ts
  ts=$(wg show wg0 latest-handshakes 2>/dev/null | awk 'NR==1 {print $2}')
  [ "${ts:-0}" -gt 0 ] && [ $(($(date +%s) - ts)) -lt "$WG_STALE" ]
}

check_netbird() {
  local s
  s=$(timeout 10 netbird status 2>/dev/null) || return 1
  grep -q '^Management: Connected' <<<"$s" && grep -q '^Signal: Connected' <<<"$s"
}

check_relay() { systemctl is-active --quiet netbird-relay; }

check_traefik() { systemctl is-active --quiet traefik && port_open 443; }

# Local Traefik -> NetBird tunnel -> cluster health responder. Catches what the layer checks
# can't see: a NetBird peer session that still reads "Connected" but has stopped passing traffic.
check_e2e() {
  [ "$(curl -sk -o /dev/null --max-time 8 -w '%{http_code}' \
    --resolve "${PROBE_HOST}:443:127.0.0.1" "https://${PROBE_HOST}/")" = 418 ]
}

repair() {
  case "$1" in
    docker) systemctl restart docker ;;
    wg) systemctl restart wg-quick@wg0 && systemctl restart netbird ;;
    netbird) systemctl restart netbird ;;
    relay) systemctl restart netbird-relay ;;
    traefik) systemctl restart traefik ;;
    e2e)
      # A plain NetBird restart cleared the stale-session case; if it didn't hold, rebuild
      # the uplink underneath it too.
      [ "$(counter repairs)" -ge 2 ] && systemctl restart wg-quick@wg0
      systemctl restart netbird
      ;;
  esac
}

failed=""
for layer in "${LAYERS[@]}"; do
  if "check_$layer"; then
    rm -f "$STATE/fail.$layer"
  else
    failed=$layer
    break
  fi
done

if [ -z "$failed" ]; then
  [ -e "$STATE/repairs" ] && log "all layers healthy again"
  rm -f "$STATE/repairs" "$STATE"/fail.*
  exit 0
fi

fails=$(($(counter "fail.$failed") + 1))
echo "$fails" >"$STATE/fail.$failed"
if [ "$fails" -lt "$FAILS_BEFORE_ACTION" ]; then
  log "layer $failed failing ($fails/$FAILS_BEFORE_ACTION), waiting"
  exit 0
fi

repairs=$(counter repairs)
backoff=$((repairs > 6 ? 6 : (repairs < 1 ? 1 : repairs)))
last=$(cat "$STATE/last-repair" 2>/dev/null || echo 0)
if [ $(($(date +%s) - last)) -lt $((COOLDOWN * backoff)) ]; then
  exit 0
fi

log "layer $failed failed $fails checks, restarting (repair #$((repairs + 1)))"
repair "$failed" || log "restart for layer $failed returned an error"
date +%s >"$STATE/last-repair"
echo $((repairs + 1)) >"$STATE/repairs"
