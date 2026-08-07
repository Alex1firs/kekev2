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
# Portable to bash 3.2 (macOS) as well as bash 5 (droplet).

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

# Counters in temp files rather than associative arrays: macOS ships bash 3.2,
# which has no `declare -A`, and this script has to run from whatever laptop is
# watching the deploy.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for t in "${TARGETS[@]}"; do
    name="${t%%|*}"
    echo 0 > "$WORK/$name.ok"
    echo 0 > "$WORK/$name.fail"
done
FAILURES_FILE="$WORK/failures"
: > "$FAILURES_FILE"

bump() { local f="$1"; echo $(( $(cat "$f") + 1 )) > "$f"; }

START=$(date +%s)
echo "polling ${#TARGETS[@]} surfaces for ${SECONDS_TO_RUN}s from $(date -u +%H:%M:%S)Z"

while [ $(( $(date +%s) - START )) -lt "$SECONDS_TO_RUN" ]; do
    for t in "${TARGETS[@]}"; do
        name="${t%%|*}"; url="${t#*|}"
        # A 4xx from an unauthenticated endpoint is a healthy answer: the app
        # replied. Only 5xx and connection failures are interruptions.
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
        case "$code" in
            2*|3*|4*) bump "$WORK/$name.ok" ;;
            *)        bump "$WORK/$name.fail"
                      echo "$(date -u +%H:%M:%S)Z  $name  $code" >> "$FAILURES_FILE" ;;
        esac
    done
    sleep 0.4
done

echo
echo "═══ RESULT ═══"
total_fail=0
for t in "${TARGETS[@]}"; do
    name="${t%%|*}"
    o=$(cat "$WORK/$name.ok"); f=$(cat "$WORK/$name.fail")
    printf '  %-14s ok=%-5s failed=%s\n' "$name" "$o" "$f"
    total_fail=$(( total_fail + f ))
done

if [ "$total_fail" -eq 0 ]; then
    echo "  ZERO failed requests across every surface."
else
    echo
    echo "  ${total_fail} failed request(s):"
    sort "$FAILURES_FILE" | uniq -c | sed 's/^/    /'
    echo
    echo "  first: $(head -1 "$FAILURES_FILE")"
    echo "  last:  $(tail -1 "$FAILURES_FILE")"
fi
