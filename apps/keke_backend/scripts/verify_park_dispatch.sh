#!/usr/bin/env bash
#
# Park Dispatch launch verification.
#
# Exercises the dispatcher workflow through the real HTTP API against a running
# backend — not a test harness, not mocks. This is the check to run after a
# deploy and before dispatchers arrive, and it is referenced by
# docs/launch_runbook.md §3c.
#
# It is READ-MOSTLY and safe against production: it inspects state, toggles the
# kill switch off and back on (audited), and asserts the privilege boundaries.
# It does not create rides, assign drivers, or touch money.
#
# Usage:
#   API=https://api.kekeride.ng/api/v1 ADMIN_KEY=xxx \
#     OPS_EMAIL=… OPS_PASSWORD=… ./scripts/verify_park_dispatch.sh
#
# ADMIN_KEY covers the read-only checks. OPS_EMAIL/OPS_PASSWORD (an account with
# PARK_SUSPEND) are needed for the kill-switch drill, because the shared key is
# deliberately denied the park domain.
#   API=http://127.0.0.1:4100/api/v1 ADMIN_KEY=local-demo-admin-key \
#     DISPATCHER_EMAIL=chidi@kekeride.test DISPATCHER_PASSWORD=... ./scripts/verify_park_dispatch.sh
#
# Exit code 0 = safe to open the park.

set -uo pipefail

API="${API:-http://127.0.0.1:4100/api/v1}"
ADMIN_KEY="${ADMIN_KEY:-}"
DISPATCHER_EMAIL="${DISPATCHER_EMAIL:-}"
DISPATCHER_PASSWORD="${DISPATCHER_PASSWORD:-}"

PASS=0; FAIL=0; WARN=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Reads one field out of a JSON body on stdin. Python because jq is not
# guaranteed to be on the droplet.
j() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
try: print($1)
except Exception: print('')" 2>/dev/null; }

adm() { curl -s --max-time 15 -H "x-admin-key: $ADMIN_KEY" "$@"; }

# Changing the switch needs PARK_SUSPEND, which the shared admin key is
# deliberately denied — a shared secret has no human behind it, and the whole
# point of this action is being attributable. So the drill needs a real
# operations login.
OPS_TOKEN=""
ops() { curl -s --max-time 15 -H "Authorization: Bearer $OPS_TOKEN" "$@"; }

[ -n "$ADMIN_KEY" ] || { echo "ADMIN_KEY is required"; exit 2; }

if [ -n "${OPS_EMAIL:-}" ] && [ -n "${OPS_PASSWORD:-}" ]; then
    OPS_TOKEN=$(curl -s --max-time 15 -X POST "$API/staff/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$OPS_EMAIL\",\"password\":\"$OPS_PASSWORD\"}" | j 'd["accessToken"]')
fi

head_ "1. Is Park Dispatch accepting work?"

SW=$(adm "$API/admin/park-dispatch/switch")
ACCEPTING=$(echo "$SW" | j 'd["accepting"]')
ENVFLAG=$(echo "$SW" | j 'd["envEnabled"]')

if [ "$ACCEPTING" = "True" ]; then
    ok "accepting new work"
elif [ "$ENVFLAG" = "False" ]; then
    bad "PARK_DISPATCH_ENABLED is false in the environment — needs a restart to fix"
elif [ -z "$ACCEPTING" ]; then
    bad "could not read the switch (is the backend up, and the admin key right?)"
else
    bad "paused by the runtime override: $(echo "$SW" | j 'd["override"]["reason"]')"
fi

head_ "2. Is there a park that can actually take a ride?"

HEALTH=$(adm "$API/admin/park-dispatch/health")
PARKS=$(echo "$HEALTH" | j 'len(d["parks"])')
if [ "${PARKS:-0}" -gt 0 ] 2>/dev/null; then
    ok "$PARKS park(s) reporting health"
    echo "$HEALTH" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for p in d["parks"]:
    hours = "open" if p["withinOperatingHours"] else "OUTSIDE HOURS"
    code, status = p["code"], p["status"]
    waiting, queue = p["driversWaiting"], p["currentQueueDepth"]
    disp = len(p["currentDispatchers"])
    print(f"        {code:<12} {status:<10} {hours:<14} "
          f"waiting={waiting:<3} queue={queue:<3} dispatchers={disp}")
'
    READY=$(echo "$HEALTH" | j 'sum(1 for p in d["parks"] if p["status"]=="active" and p["withinOperatingHours"] and p["driversWaiting"]>0)')
    [ "${READY:-0}" -gt 0 ] && ok "$READY park(s) active, in hours, with a waiting driver" \
        || bad "no park is active, in hours AND has a waiting driver — nothing can be dispatched"

    ONDUTY=$(echo "$HEALTH" | j 'sum(len(p["currentDispatchers"]) for p in d["parks"])')
    [ "${ONDUTY:-0}" -gt 0 ] && ok "$ONDUTY dispatcher(s) on duty" \
        || warn "no dispatcher is on shift — requests will queue until someone signs in"
else
    bad "no parks returned health"
fi

head_ "3. Is the fallback being reached at all?"

OV=$(adm "$API/admin/park-dispatch/overview")
if [ -n "$(echo "$OV" | j 'd')" ]; then
    ok "monitoring endpoint responding"
    echo "$OV" | python3 -c '
import sys, json
d = json.load(sys.stdin)
t = d.get("today", d)
def g(*names):
    for n in names:
        if n in t: return t[n]
    return "—"
print(f"        offered={g(\"offered\")} assigned={g(\"assigned\")} "
      f"expired={g(\"expired\")} escalated={g(\"escalated\")}")
' 2>/dev/null || true
else
    bad "overview endpoint not responding"
fi

head_ "4. Privilege boundaries"

if [ -n "$DISPATCHER_EMAIL" ] && [ -n "$DISPATCHER_PASSWORD" ]; then
    TOK=$(curl -s --max-time 15 -X POST "$API/staff/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$DISPATCHER_EMAIL\",\"password\":\"$DISPATCHER_PASSWORD\"}" | j 'd["accessToken"]')
    if [ -n "$TOK" ]; then
        ok "dispatcher can sign in"

        # The dashboard needs an open shift or an explicit park. Verification
        # must not open a shift on someone's behalf, so name the park instead.
        PARKID=$(echo "$HEALTH" | j 'd["parks"][0]["parkId"]')
        DASH=$(curl -s --max-time 15 "$API/dispatcher/dashboard?parkId=$PARKID" -H "Authorization: Bearer $TOK")
        [ "$(echo "$DASH" | j 'd["capabilities"]["canAdvanceRideLifecycle"]')" = "False" ] \
            && ok "dashboard declares canAdvanceRideLifecycle=false" \
            || bad "dashboard does not declare the lifecycle boundary"

        # A dispatcher must not be able to take the whole system down.
        CODE=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$API/admin/park-dispatch/switch" \
            -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
            -d '{"disabled":true,"reason":"verification probe"}')
        [ "$CODE" = "403" ] && ok "dispatcher cannot disable Park Dispatch (403)" \
            || bad "dispatcher got $CODE disabling Park Dispatch — expected 403"

        # Passenger numbers must be masked on the queue.
        LEAK=$(echo "$DASH" | j 'sum(1 for c in d.get("queue",[]) if c.get("passengerPhoneMasked") and "•" not in c["passengerPhoneMasked"])')
        [ "${LEAK:-0}" = "0" ] && ok "no unmasked passenger number on the queue" \
            || bad "$LEAK queue card(s) expose an unmasked number"
    else
        bad "dispatcher could not sign in"
    fi
else
    warn "DISPATCHER_EMAIL/PASSWORD not set — skipped the dispatcher-side checks"
fi

head_ "5. The kill switch responds"

# Only drill this when the system is currently accepting, so a verification run
# can never leave production paused.
if [ -z "$OPS_TOKEN" ]; then
    warn "OPS_EMAIL/OPS_PASSWORD not set — skipped the kill-switch drill (the shared key cannot change it)"
elif [ "$ACCEPTING" != "True" ]; then
    warn "skipped the drill because the system is not currently accepting"
else
    R=$(ops -X POST "$API/admin/park-dispatch/switch" -H 'Content-Type: application/json' \
        -d '{"disabled":true,"reason":"launch verification drill"}')
    [ "$(echo "$R" | j 'd["disabled"]')" = "True" ] && ok "disable works" || bad "disable failed: $R"

    R=$(ops -X POST "$API/admin/park-dispatch/switch" -H 'Content-Type: application/json' -d '{"disabled":false}')
    [ "$(echo "$R" | j 'd["disabled"]')" = "False" ] && ok "re-enable works" || bad "RE-ENABLE FAILED — Park Dispatch is still paused: $R"

    FINAL=$(adm "$API/admin/park-dispatch/switch" | j 'd["accepting"]')
    [ "$FINAL" = "True" ] && ok "left accepting work" || bad "LEFT PAUSED — re-enable it before opening the park"
fi

printf '\n  %d passed, %d failed, %d warning(s)\n\n' "$PASS" "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ] || exit 1
