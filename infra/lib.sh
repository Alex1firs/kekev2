#!/usr/bin/env bash
#
# Shared helpers for the deploy and rollback scripts.
#
# Sourced, never executed. Everything here is deliberately boring: this code
# runs while production is mid-cutover, and a clever helper that behaves
# unexpectedly at that moment is worse than no helper.

REPO_ROOT="${REPO_ROOT:-/opt/kekev2}"
BACKEND_DIR="$REPO_ROOT/apps/keke_backend"
NGINX_TEMPLATE="$REPO_ROOT/infra/nginx/nginx.conf.template"
NGINX_DEPLOYED="$REPO_ROOT/nginx.conf"
GATEWAY="keke_backend-nginx_gateway-1"
PUBLIC_URL="${PUBLIC_URL:-https://api.kekeride.ng}"

# Long enough for an in-flight dispatch run (~110s) to finish on the process
# that owns its timers. Overridable for an emergency deploy.
DRAIN_SECONDS="${DRAIN_SECONDS:-180}"

# How long a new colour gets to become healthy before the deploy gives up.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

dc() { (cd "$BACKEND_DIR" && docker compose "$@"); }

other_colour() { [[ "$1" == "blue" ]] && echo green || echo blue; }

# The live colour, read from the config nginx is actually serving — not from a
# state file somebody could edit, and not from what is running. If nginx points
# at it, it is live.
live_colour() {
    if [[ ! -f "$NGINX_DEPLOYED" ]]; then echo ""; return; fi
    grep -oE 'set \$prod_app http://api_prod_(blue|green):' "$NGINX_DEPLOYED" \
        | grep -oE '(blue|green)' | head -1
}

container_of() { echo "api_prod_$1"; }

is_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

# Health, asked of the container directly rather than through nginx. A colour
# that is not yet in front of traffic cannot be reached any other way, and
# asking through nginx would answer about the colour that IS live.
health_of() {
    docker exec "$(container_of "$1")" node -e "
        fetch('http://127.0.0.1:4000/health')
          .then(r => r.json())
          .then(j => { console.log(JSON.stringify(j)); process.exit(j.status === 'ok' ? 0 : 1); })
          .catch(e => { console.error(e.message); process.exit(1); })
    " 2>/dev/null
}

wait_for_health() {
    local colour="$1" waited=0
    info "waiting for $colour to become healthy (up to ${HEALTH_TIMEOUT}s)"
    while (( waited < HEALTH_TIMEOUT )); do
        if out=$(health_of "$colour"); then
            ok "$colour healthy: $out"
            return 0
        fi
        sleep 3; waited=$((waited + 3))
    done
    return 1
}

# Render the gateway config for a colour and reload.
#
# `cp` rather than a move: the gateway bind-mounts a single FILE, pinned to an
# inode. Replacing it would leave the container's mount pointing at an orphan
# and nginx would go on serving the previous config — a cutover that appears to
# work and does not. cp truncates in place, so the inode survives.
render_and_reload() {
    local colour="$1"
    [[ -f "$NGINX_TEMPLATE" ]] || die "missing template: $NGINX_TEMPLATE"

    local tmp; tmp="$(mktemp)"
    sed "s/__PROD_COLOUR__/$colour/g" "$NGINX_TEMPLATE" > "$tmp"
    grep -q "__PROD_COLOUR__" "$tmp" && die "template still has an unrendered placeholder"
    grep -q "api_prod_$colour:4000" "$tmp" || die "rendered config does not point at $colour"

    [[ -f "$NGINX_DEPLOYED" ]] && cp "$NGINX_DEPLOYED" "/root/nginx.conf.bak-$(date +%F-%H%M%S)"
    cp "$tmp" "$NGINX_DEPLOYED"
    rm -f "$tmp"

    if ! docker exec "$GATEWAY" nginx -t >/dev/null 2>&1; then
        warn "nginx rejected the rendered config — restoring the previous one"
        cp "$(ls -t /root/nginx.conf.bak-* | head -1)" "$NGINX_DEPLOYED"
        docker exec "$GATEWAY" nginx -t || true
        die "config test failed; nothing was reloaded"
    fi

    # Graceful: existing connections are served to completion by the old
    # workers while new ones use the new configuration. Nothing is refused.
    docker exec "$GATEWAY" nginx -s reload
    ok "gateway now points at $colour"
}

# What the public URL says it is talking to. The proof a cutover happened.
public_colour() {
    curl -s --max-time 8 "$PUBLIC_URL/health" \
        | sed -n 's/.*"colour":"\([a-z]*\)".*/\1/p'
}
