#!/bin/sh
# Probe for the gluetun container: fail if the tunnel is dead, or if the VPN exit is not in the expected city.
#
# The city is looked up when the exit IP (/tmp/gluetun/ip, rewritten on every connect) changes and at least every
# CHECK_INTERVAL seconds otherwise, so a reconnect to a different server is caught as well as a drift in place.
# A lookup that fails or times out is not a mismatch: the liveness probe lets it pass and retries on the next run,
# while "strict" (startup probe) fails it, so the pod is never Ready before the exit city has been confirmed.
#
# Usage: healthcheck.sh [strict]
set -u

EXPECTED_CITY='Montréal'
VPN_IF=tun0
CHECK_INTERVAL=300
CHECKED=/tmp/exit-city-checked

strict=0
[ "${1:-}" = strict ] && strict=1
# Outcome when the city could not be determined.
unknown() { exit "$strict"; }

ping -c 3 -W 3 -I "$VPN_IF" 1.1.1.1 > /dev/null || exit 1

exit_ip=$(cat /tmp/gluetun/ip 2> /dev/null) || unknown
now=$(cut -d. -f1 /proc/uptime)
last_ip=
last_at=0
[ -r "$CHECKED" ] && read -r last_ip last_at < "$CHECKED"
if [ "$exit_ip" = "$last_ip" ] && [ $((now - last_at)) -lt "$CHECK_INTERVAL" ]; then
  exit 0
fi

city=$(wget -q -t 1 -T 10 -O- https://ipinfo.io/city 2> /dev/null) || unknown
[ -n "$city" ] || unknown

if [ "$city" = "$EXPECTED_CITY" ]; then
  echo "$exit_ip $now" > "$CHECKED"
  exit 0
fi
echo "VPN exit $exit_ip is in $city, expected $EXPECTED_CITY" >&2
exit 1
