#!/usr/bin/env bash
#
# Poll the live surfaces continuously and report every failure with a timestamp.
#
# Run this from OUTSIDE the droplet during a deploy. Running it on the droplet
# would skip nginx, the TLS terminator and the network — the three places a
# cutover can actually drop a request.
#
# Usage:  infra/measure_downtime.sh [seconds]      (default 300)

set -uo pipefail

SECONDS_TO_RUN="${1:-300}"
BASE="${BASE:-https://api.kekeride.ng}"
ADMIN="${ADMIN:-https://admin.kekeride.ng}"

# The surfaces that must not be interrupted, each named for the report.
declare -a TARGETS=(
    "health|$BASE/health"
    "dispatch-app|$BASE/dispatch/"
    "passenger-api|$BASE/api/v1/auth/login"
    "admin|$ADMIN/"
)

declare -A OKC FAILC
for t in "${TARGETS[@]}"; do OKC[${t%%|*}]=0; FAILC[${t%%|*}]=0; done

FAILURES_FILE="$(mktemp)"
START=$(date +%s)
echo "polling ${#TARGETS[@]} surfaces for ${SECONDS_TO_RUN}s from $(date -u +%H:%M:%S)Z"

while (( $(date +%s) - START < SECONDS_TO_RUN )); do
    for t in "${TARGETS[@]}"; do
        name="${t%%|*}"; url="${t#*|}"
        # A 4xx from an unauthenticated POST target is a healthy answer: the
        # app replied. Only 5xx and connection failures are interruptions.
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
        if [[ "$code" =~ ^[23]|^4 ]]; then
            OKC[$name]=$(( ${OKC[$name]} + 1 ))
        else
            FAILC[$name]=$(( ${FAILC[$name]} + 1 ))
            echo "$(date -u +%H:%M:%S)Z  $name  $code" >> "$FAILURES_FILE"
        fi
    done
    sleep 0.4
done

echo
echo "═══ RESULT ═══"
total_fail=0
for t in "${TARGETS[@]}"; do
    name="${t%%|*}"
    printf '  %-14s ok=%-5s failed=%s\n' "$name" "${OKC[$name]}" "${FAILC[$name]}"
    total_fail=$(( total_fail + ${FAILC[$name]} ))
done

if (( total_fail == 0 )); then
    echo "  ZERO failed requests across every surface."
else
    echo
    echo "  ${total_fail} failed request(s):"
    sort "$FAILURES_FILE" | uniq -c | sed 's/^/    /'
    # Contiguous failures are what an outage actually looks like; scattered
    # ones are usually a flaky poll.
    echo
    echo "  first: $(head -1 "$FAILURES_FILE")"
    echo "  last:  $(tail -1 "$FAILURES_FILE")"
fi
rm -f "$FAILURES_FILE"
