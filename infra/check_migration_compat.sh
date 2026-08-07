#!/usr/bin/env bash
#
# Refuse a rolling deploy that would break the colour still serving.
#
# During a blue-green deploy the OLD code runs against the NEW schema for the
# whole drain window. A migration that drops a column the old code still selects
# turns a zero-downtime deploy into an outage that only shows up in the drain —
# the worst possible time to discover it, because traffic has already moved.
#
# This greps pending migrations for the destructive forms. It is a lint, not a
# proof: it cannot know whether the old code reads a column. What it does is
# make the destructive cases impossible to do by accident.
#
# Removing a column is a TWO-DEPLOY operation:
#   1. deploy code that no longer reads it
#   2. in a later release, drop it
#
# Override for a deliberate destructive migration accepted with downtime:
#   ALLOW_DESTRUCTIVE_MIGRATION=1 infra/deploy.sh

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/kekev2}"
MIGRATIONS_DIR="$REPO_ROOT/apps/keke_backend/src/migrations"
BACKEND_DIR="$REPO_ROOT/apps/keke_backend"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# Which migrations have not been applied yet. Anything already in the database
# is history and cannot be made safer by complaining about it now.
APPLIED=$( (cd "$BACKEND_DIR" && docker compose exec -T postgres_shared \
    psql -U postgres -d keke_prod_db -t -A -c \
    'SELECT name FROM migrations' 2>/dev/null) || true )

PENDING=()
for f in "$MIGRATIONS_DIR"/*.ts; do
    [[ -e "$f" ]] || continue
    class=$(grep -oE 'export class ([A-Za-z0-9_]+)' "$f" | awk '{print $3}' | head -1)
    [[ -n "$class" ]] || continue
    if ! grep -qx "$class" <<< "$APPLIED"; then PENDING+=("$f"); fi
done

if (( ${#PENDING[@]} == 0 )); then
    ok "no pending migrations"
    exit 0
fi

printf '  %d pending migration(s):\n' "${#PENDING[@]}"
for f in "${PENDING[@]}"; do printf '    %s\n' "$(basename "$f")"; done

# Patterns that break the colour still serving. Deliberately matched only in
# up() — a down() is allowed to be destructive; that is what a down is.
declare -a FINDINGS=()
for f in "${PENDING[@]}"; do
    up=$(awk '/public async up/,/public async down/' "$f")
    while IFS= read -r pattern; do
        [[ -z "$pattern" ]] && continue
        if grep -qiE "$pattern" <<< "$up"; then
            FINDINGS+=("$(basename "$f"): $pattern")
        fi
    done <<'PATTERNS'
DROP[[:space:]]+TABLE
DROP[[:space:]]+COLUMN
RENAME[[:space:]]+(TO|COLUMN)
ALTER[[:space:]]+COLUMN[^\n]*TYPE
SET[[:space:]]+NOT[[:space:]]+NULL
DROP[[:space:]]+CONSTRAINT
DROP[[:space:]]+(NOT[[:space:]]+)?DEFAULT
TRUNCATE
DELETE[[:space:]]+FROM
PATTERNS
done

if (( ${#FINDINGS[@]} == 0 )); then
    ok "pending migrations look additive — safe to roll"
    exit 0
fi

bad "destructive DDL in a pending migration:"
for x in "${FINDINGS[@]}"; do printf '      %s\n' "$x"; done
echo
warn "The colour still serving runs the OLD code against this NEW schema for the"
warn "whole drain window. Removing a column is a two-deploy operation: ship code"
warn "that stops reading it first, drop it in a later release."
echo
if [[ "${ALLOW_DESTRUCTIVE_MIGRATION:-}" == "1" ]]; then
    warn "ALLOW_DESTRUCTIVE_MIGRATION=1 — proceeding anyway. Expect an interruption."
    exit 0
fi
warn "To proceed deliberately: ALLOW_DESTRUCTIVE_MIGRATION=1 infra/deploy.sh"
exit 1
