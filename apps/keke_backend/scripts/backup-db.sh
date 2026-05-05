#!/usr/bin/env bash
# Daily PostgreSQL backup for Keke Ride.
#
# Cron (run as root or the docker user, after confirming pg_dump is available):
#   0 3 * * * /opt/keke/apps/keke_backend/scripts/backup-db.sh >> /var/log/keke-db-backup.log 2>&1
#
# Environment:
#   DATABASE_URL — postgres connection string (loaded from .env if not already set)
#   BACKUP_DIR   — destination directory (default: /opt/keke/backups)
#   KEEP_DAYS    — days to retain old backups (default: 7)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/keke/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME="keke_db_${TIMESTAMP}.dump"

# Load DATABASE_URL from app .env if not already in environment
if [ -z "${DATABASE_URL:-}" ]; then
    ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
    if [ -f "$ENV_FILE" ]; then
        DATABASE_URL=$(grep -v '^#' "$ENV_FILE" | grep '^DATABASE_URL=' | cut -d= -f2-)
        export DATABASE_URL
    fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: DATABASE_URL not set — aborting" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] START backup: $FILENAME"
pg_dump --format=custom --no-password "$DATABASE_URL" > "$BACKUP_DIR/$FILENAME"
SIZE=$(du -sh "$BACKUP_DIR/$FILENAME" | cut -f1)
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] DONE  backup: $BACKUP_DIR/$FILENAME ($SIZE)"

# Rotate: delete backups older than KEEP_DAYS
DELETED=$(find "$BACKUP_DIR" -name 'keke_db_*.dump' -mtime "+${KEEP_DAYS}" -print -delete | wc -l | tr -d ' ')
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ROTATED $DELETED file(s) older than ${KEEP_DAYS} days"
