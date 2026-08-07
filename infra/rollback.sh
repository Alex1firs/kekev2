#!/usr/bin/env bash
#
# Go back to the previous colour.
#
# Two speeds, depending on when you run it:
#
#   Within the drain window — the previous colour is still running and warm.
#   Rollback is an nginx reload: under a second, no container start, no
#   migration, no rebuild.
#
#   After the drain — the previous colour is stopped. This starts it from the
#   image it was running (kept as :previous by deploy.sh), waits for health,
#   then flips. Roughly a container start.
#
# The database is deliberately NOT rolled back. Migrations are
# backward-compatible by policy, so the previous code runs correctly against the
# newer schema — that is the entire point of the rule. Reverting a migration is
# a separate, deliberate act; see docs/zero_downtime_deploys.md.
#
# Usage:  infra/rollback.sh [blue|green]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CURRENT="$(live_colour)"
[[ -n "$CURRENT" ]] || die "cannot tell which colour is live; $NGINX_DEPLOYED is missing or unreadable"

TARGET="${1:-$(other_colour "$CURRENT")}"
[[ "$TARGET" == "blue" || "$TARGET" == "green" ]] || die "colour must be blue or green"
[[ "$TARGET" != "$CURRENT" ]] || die "$TARGET is already live"

say "Rolling back: $CURRENT → $TARGET"

if is_running "$(container_of "$TARGET")"; then
    ok "$TARGET is still running — this is the fast path"
else
    warn "$TARGET is stopped; starting it from the previous image"
    if docker image inspect keke_backend-api_prod:previous >/dev/null 2>&1; then
        docker tag keke_backend-api_prod:previous "keke_backend-api_prod_$TARGET:latest"
        ok "restored the :previous image"
    else
        warn "no :previous image tagged — starting $TARGET from whatever image it has"
    fi
    dc up -d --no-deps "api_prod_$TARGET" >/dev/null
fi

wait_for_health "$TARGET" || die "$TARGET did not become healthy; NOT rolling back, $CURRENT is still serving"

render_and_reload "$TARGET"

SERVING=""
for _ in $(seq 1 10); do
    SERVING="$(public_colour)"
    [[ "$SERVING" == "$TARGET" ]] && break
    sleep 1
done
[[ "$SERVING" == "$TARGET" ]] || die "public URL still reports '$SERVING' — investigate before doing anything else"

ok "rolled back; $TARGET is serving"
info "$CURRENT is left running so this is reversible. Stop it when you are satisfied:"
info "  cd $BACKEND_DIR && docker compose stop api_prod_$CURRENT"
curl -s --max-time 8 "$PUBLIC_URL/health"; echo
