#!/usr/bin/env bash
# Manual/cron database backup: pg_dump → gzip → local dir (+ optional R2 via rclone/aws cli).
# Usage: DATABASE_URL=... ./scripts/backup-db.sh [/backups]
# The worker also performs automatic nightly backups to object storage when BACKUP_ENABLED=true.
set -euo pipefail
OUT="${1:-./backups}"
mkdir -p "$OUT"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
FILE="$OUT/recapai-$STAMP.sql.gz"
URL="${DATABASE_URL%%\?*}"
pg_dump --no-owner --no-privileges "$URL" | gzip -9 > "$FILE"
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
find "$OUT" -name 'recapai-*.sql.gz' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
