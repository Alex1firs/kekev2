#!/usr/bin/env bash
#
# Deploy the tracked nginx config to production, without downtime.
#
# ── Why this copies instead of letting git place the file ────────────────
# The gateway container bind-mounts a single FILE:
#
#     /opt/kekev2/nginx.conf  ->  /etc/nginx/nginx.conf
#
# Docker resolves that to an inode when the container starts. Anything that
# REPLACES the file — `git pull`, `mv`, `git checkout` — gives it a new inode,
# and the container keeps its mount pointed at the old, now-orphaned one. nginx
# would go on serving the previous config, and the next `nginx -s reload` would
# re-read a file nobody can see. That is worse than the untracked file it
# replaced: a change that appears to be deployed and is not.
#
# `cp` opens the destination with O_TRUNC and writes in place, so the inode
# survives and the mount stays valid. Hence: git holds the source of truth,
# this script copies it into position, and nothing is ever recreated.
#
# The proper fix is to bind-mount the DIRECTORY instead, which would make the
# copy unnecessary. That needs the container recreated, which is a few seconds
# of refused connections on 80/443 — a maintenance-window change, not a
# deploy-time one. See infra/nginx/README.md.
#
# Usage:  infra/nginx/deploy.sh [--check]
#   --check  compare only; change nothing. Exit 1 if they differ.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/infra/nginx/nginx.conf"
DEPLOYED="/opt/kekev2/nginx.conf"
CONTAINER="keke_backend-nginx_gateway-1"
CHECK_ONLY="${1:-}"

[[ -f "$SOURCE" ]] || { echo "missing tracked config: $SOURCE" >&2; exit 1; }

sum() { sha256sum "$1" | awk '{print $1}'; }

echo "tracked:  $(sum "$SOURCE")  $SOURCE"
if [[ -f "$DEPLOYED" ]]; then
    echo "deployed: $(sum "$DEPLOYED")  $DEPLOYED"
else
    echo "deployed: (absent)"
fi

if [[ -f "$DEPLOYED" ]] && [[ "$(sum "$SOURCE")" == "$(sum "$DEPLOYED")" ]]; then
    echo "identical — nothing to do."
    # Still confirm the CONTAINER agrees. The whole point of this script is
    # that the file on disk and the file the container sees can diverge.
    if docker exec "$CONTAINER" sha256sum /etc/nginx/nginx.conf 2>/dev/null | grep -q "$(sum "$SOURCE")"; then
        echo "container matches. ✓"
        exit 0
    fi
    echo "WARNING: the container is serving a DIFFERENT config than the file on disk." >&2
    echo "Its mount is pinned to an orphaned inode. The container must be recreated." >&2
    exit 2
fi

if [[ "$CHECK_ONLY" == "--check" ]]; then
    echo "differs. (--check: changing nothing)"
    exit 1
fi

BACKUP="/root/nginx.conf.bak-$(date +%F-%H%M%S)"
cp "$DEPLOYED" "$BACKUP"
echo "backed up to $BACKUP"

# In place — see the note at the top about inodes.
cp "$SOURCE" "$DEPLOYED"

if ! docker exec "$CONTAINER" nginx -t; then
    echo "config test FAILED — rolling back" >&2
    cp "$BACKUP" "$DEPLOYED"
    docker exec "$CONTAINER" nginx -t
    exit 1
fi

# Reload, not restart. Existing connections are served to completion by the old
# workers while new ones go to the new config; nothing is refused.
docker exec "$CONTAINER" nginx -s reload
echo "reloaded."

docker exec "$CONTAINER" sha256sum /etc/nginx/nginx.conf
echo "done. ✓"
