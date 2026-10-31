#!/usr/bin/env bash
# Self-heal the edge VPS ingress path. Checks each layer bottom-up and restarts only the
# lowest failing one, since a lower layer being broken makes every layer above it look broken:
#   docker -> wg0 uplink -> NetBird -> NetBird relay -> Traefik -> end-to-end probe
# Failures are debounced, and repairs are rate-limited with a growing backoff so a cluster
# outage (which fails the end-to-end probe on its own) can't turn into a restart loop.
#
# Events go to the journal (`journalctl -t ingress-watchdog`) and to $LOG. Counters live in
# $DATA and are exported as a node-exporter textfile ($PROM), which the cluster already
# scrapes over the VPS public IP - that path works while the NetBird tunnel is down.
set -u

: "${PROBE_HOST:?PROBE_HOST must be set}"
FAILS_BEFORE_ACTION=${FAILS_BEFORE_ACTION:-2}
COOLDOWN=${COOLDOWN:-240}
WG_STALE=${WG_STALE:-300}
STATE=${STATE:-/run/ingress-watchdog}
DATA=${DATA:-/var/lib/ingress-watchdog}
LOG=${LOG:-/var/log/ingress-watchdog.log}
LOG_MAX_BYTES=${LOG_MAX_BYTES:-1048576}
PROM=${PROM:-/var/lib/node_exporter/textfile/ingress_watchdog.prom}
BOOT_FINISHED=${BOOT_FINISHED:-/var/lib/cloud/instance/boot-finished}
LAYERS=(docker wg netbird relay traefik e2e)

num() { cat "$1" 2>/dev/null || echo 0; }
bump() { echo $(($(num "$DATA/$1") + ${2:-1})) >"$DATA/$1"; }
port_open() { timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null; }

event() {
  local line
  line="$(date -u +%FT%TZ) event=$1"
  shift
  line+="${*:+ $*}"
  logger -t ingress-watchdog -- "$line"
  echo "$line" >>"$LOG"
}

# Never touch services cloud-init is still bringing up.
[ -f "$BOOT_FINISHED" ] || exit 0
mkdir -p "$STATE" "$DATA" "$(dirname "$LOG")" "$(dirname "$PROM")"
[ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ] && mv -f "$LOG" "$LOG.1"

declare -A result

write_metrics() {
  local tmp="$PROM.$$" layer
  {
    echo "# HELP ingress_watchdog_layer_healthy 1 if the layer passed its last check; layers below a failing one are not checked."
    echo "# TYPE ingress_watchdog_layer_healthy gauge"
    for layer in "${!result[@]}"; do
      echo "ingress_watchdog_layer_healthy{layer=\"$layer\"} ${result[$layer]}"
    done
    echo "# HELP ingress_watchdog_check_failures_total Failed checks (one per minute while a layer is down), by layer."
    echo "# TYPE ingress_watchdog_check_failures_total counter"
    for layer in "${LAYERS[@]}"; do
      echo "ingress_watchdog_check_failures_total{layer=\"$layer\"} $(num "$DATA/failures.$layer")"
    done
    echo "# HELP ingress_watchdog_repairs_total Service restarts the watchdog performed, by the layer that triggered them."
    echo "# TYPE ingress_watchdog_repairs_total counter"
    for layer in "${LAYERS[@]}"; do
      echo "ingress_watchdog_repairs_total{layer=\"$layer\"} $(num "$DATA/repairs.$layer")"
    done
    echo "# HELP ingress_watchdog_recoveries_total Unhealthy periods that ended; repaired=true if the watchdog restarted something during it."
    echo "# TYPE ingress_watchdog_recoveries_total counter"
    echo "ingress_watchdog_recoveries_total{repaired=\"true\"} $(num "$DATA/recoveries.repaired")"
    echo "ingress_watchdog_recoveries_total{repaired=\"false\"} $(num "$DATA/recoveries.self")"
    echo "# HELP ingress_watchdog_unhealthy_seconds_total Time spent with any layer failing, counted when the period ends."
    echo "# TYPE ingress_watchdog_unhealthy_seconds_total counter"
    echo "ingress_watchdog_unhealthy_seconds_total $(num "$DATA/unhealthy-seconds")"
    echo "# HELP ingress_watchdog_unhealthy_since_timestamp_seconds Start of the current unhealthy period, 0 when healthy."
    echo "# TYPE ingress_watchdog_unhealthy_since_timestamp_seconds gauge"
    echo "ingress_watchdog_unhealthy_since_timestamp_seconds $(num "$DATA/unhealthy-since")"
    echo "# HELP ingress_watchdog_last_repair_timestamp_seconds Time of the last restart the watchdog performed."
    echo "# TYPE ingress_watchdog_last_repair_timestamp_seconds gauge"
    echo "ingress_watchdog_last_repair_timestamp_seconds $(num "$DATA/last-repair")"
    echo "# HELP ingress_watchdog_last_run_timestamp_seconds Time of the last watchdog run."
    echo "# TYPE ingress_watchdog_last_run_timestamp_seconds gauge"
    echo "ingress_watchdog_last_run_timestamp_seconds $(date +%s)"
  } >"$tmp" && mv -f "$tmp" "$PROM"
}
trap write_metrics EXIT

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
      [ "$(num "$STATE/repairs")" -ge 2 ] && systemctl restart wg-quick@wg0
      systemctl restart netbird
      ;;
  esac
}

failed=""
for layer in "${LAYERS[@]}"; do
  if "check_$layer"; then
    result[$layer]=1
    rm -f "$STATE/fail.$layer"
  else
    result[$layer]=0
    failed=$layer
    break
  fi
done

now=$(date +%s)

if [ -z "$failed" ]; then
  if [ -e "$DATA/unhealthy-since" ]; then
    duration=$((now - $(num "$DATA/unhealthy-since")))
    bump unhealthy-seconds "$duration"
    if [ -e "$STATE/repairs" ]; then bump recoveries.repaired; else bump recoveries.self; fi
    event recovered "duration_s=$duration repairs=$(num "$STATE/repairs")"
    echo 0 >"$DATA/unhealthy-since"
  fi
  rm -f "$STATE/repairs" "$STATE"/fail.*
  exit 0
fi

bump "failures.$failed"
if [ "$(num "$DATA/unhealthy-since")" -eq 0 ]; then
  echo "$now" >"$DATA/unhealthy-since"
  event unhealthy "layer=$failed"
fi

fails=$(($(num "$STATE/fail.$failed") + 1))
echo "$fails" >"$STATE/fail.$failed"
if [ "$fails" -lt "$FAILS_BEFORE_ACTION" ]; then
  event check_failed "layer=$failed count=$fails/$FAILS_BEFORE_ACTION action=wait"
  exit 0
fi

repairs=$(num "$STATE/repairs")
backoff=$((repairs > 6 ? 6 : (repairs < 1 ? 1 : repairs)))
if [ $((now - $(num "$STATE/last-repair"))) -lt $((COOLDOWN * backoff)) ]; then
  event check_failed "layer=$failed count=$fails action=cooldown"
  exit 0
fi

if repair "$failed"; then status=ok; else status=error; fi
echo "$now" >"$STATE/last-repair"
echo "$now" >"$DATA/last-repair"
echo $((repairs + 1)) >"$STATE/repairs"
bump "repairs.$failed"
event repair "layer=$failed count=$fails attempt=$((repairs + 1)) result=$status"
