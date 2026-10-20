#!/usr/bin/env bash
# Restore a backup into DATABASE_URL (DESTRUCTIVE: drops existing objects).
# Usage: DATABASE_URL=... ./scripts/restore-db.sh backups/recapai-XXXX.sql.gz
set -euo pipefail
FILE="$1"
URL="${DATABASE_URL%%\?*}"
read -r -p "This will overwrite the database at $URL. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "Aborted"; exit 1; }
psql "$URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c "$FILE" | psql "$URL" -v ON_ERROR_STOP=1
echo "Restore complete. Run: npm run db:deploy"
