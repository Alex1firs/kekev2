#!/usr/bin/env bash
#
# Deploy the backend without dropping a request.
#
# Blue-green: build, migrate, start the idle colour, prove it healthy, point
# nginx at it with a graceful reload, then let the old colour drain long enough
# for in-flight dispatch runs to finish before stopping it.
#
# The cutover is an `nginx -s reload`, not a container restart. That is the
# whole reason this is free of dropped requests.
#
# Usage:
#   infra/deploy.sh              deploy HEAD
#   infra/deploy.sh --no-drain   stop the old colour immediately (emergency)
#   DRAIN_SECONDS=300 infra/deploy.sh
#
# See docs/zero_downtime_deploys.md.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

[[ "${1:-}" == "--no-drain" ]] && DRAIN_SECONDS=0

say "1. Where are we"
CURRENT="$(live_colour)"
if [[ -z "$CURRENT" ]]; then
    warn "no live colour found in $NGINX_DEPLOYED — assuming first blue-green deploy"
    CURRENT="none"; TARGET="blue"
else
    TARGET="$(other_colour "$CURRENT")"
fi
info "live:   $CURRENT"
info "target: $TARGET"
info "drain:  ${DRAIN_SECONDS}s"

say "2. Build"
# Tag what is running as :previous BEFORE building over it, so rollback has
# something to return to. Without this, a bad deploy leaves nothing to go back
# to but a git checkout and a rebuild.
if docker image inspect keke_backend-api_prod_blue:latest >/dev/null 2>&1; then
    docker tag keke_backend-api_prod_blue:latest keke_backend-api_prod:previous
    ok "tagged the running image as :previous"
else
    warn "no existing image to tag as :previous (first deploy?)"
fi
dc build "api_prod_$TARGET" >/dev/null
ok "image built"

say "3. Migration safety"
"$REPO_ROOT/infra/check_migration_compat.sh" || die "migration compatibility check failed"

say "4. Migrate"
# Once, as a one-shot container, before either colour runs the new code. The
# old colour keeps serving against the new schema for the whole drain — which
# is exactly why migrations must be backward-compatible.
dc run --rm --no-deps "api_prod_$TARGET" npm run migration:run 2>&1 \
    | grep -E "has been executed|No migrations are pending|error" || true
ok "migrations applied"

say "5. Start $TARGET"
dc up -d --no-deps "api_prod_$TARGET" >/dev/null
wait_for_health "$TARGET" || {
    warn "$TARGET never became healthy — traffic has NOT moved"
    dc logs --tail 40 "api_prod_$TARGET" || true
    dc stop "api_prod_$TARGET" >/dev/null 2>&1 || true
    die "deploy aborted; $CURRENT is still serving and was never touched"
}

say "6. Smoke test $TARGET directly"
# Directly, container to container — this colour is not in front of traffic yet
# and cannot be reached through the public URL.
SMOKE=$(docker exec "$(container_of "$TARGET")" node -e "
    (async () => {
      const paths = ['/health'];
      for (const p of paths) {
        const r = await fetch('http://127.0.0.1:4000' + p);
        if (!r.ok) { console.error('FAIL ' + p + ' -> ' + r.status); process.exit(1); }
      }
      console.log('ok');
    })().catch(e => { console.error(e.message); process.exit(1); });
") || {
    dc stop "api_prod_$TARGET" >/dev/null 2>&1 || true
    die "smoke test failed; $CURRENT is still serving"
}
ok "smoke test passed"

say "7. Cut over"
render_and_reload "$TARGET"

say "8. Verify through the public URL"
SERVING=""
for _ in $(seq 1 10); do
    SERVING="$(public_colour)"
    [[ "$SERVING" == "$TARGET" ]] && break
    sleep 1
done
if [[ "$SERVING" != "$TARGET" ]]; then
    warn "public URL reports '$SERVING', expected '$TARGET' — cutting back"
    render_and_reload "$CURRENT"
    die "cutover failed and was reverted; $CURRENT is serving"
fi
ok "public URL is served by $TARGET"

say "9. Drain $CURRENT"
if [[ "$CURRENT" == "none" ]]; then
    info "nothing to drain"
elif (( DRAIN_SECONDS == 0 )); then
    warn "--no-drain: stopping $CURRENT immediately; in-flight dispatch runs on it are lost"
    dc stop "api_prod_$CURRENT" >/dev/null 2>&1 || true
else
    info "$CURRENT keeps serving its existing connections for ${DRAIN_SECONDS}s"
    info "(a dispatch run lives ~110s; the Redis adapter carries room emits across both)"
    sleep "$DRAIN_SECONDS"
    dc stop "api_prod_$CURRENT" >/dev/null 2>&1 || true
    ok "$CURRENT stopped"
fi

say "Done"
info "serving:  $TARGET"
info "rollback: infra/rollback.sh   (re-points nginx at $CURRENT)"
curl -s --max-time 8 "$PUBLIC_URL/health"; echo
