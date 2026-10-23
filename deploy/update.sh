#!/usr/bin/env bash
# Update RecapAI to the latest code with zero data loss.
#   cd /opt/recapai && sudo bash deploy/update.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml"

echo "==> Backing up database first"
mkdir -p /var/backups/recapai
$COMPOSE exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER $POSTGRES_DB' | gzip -9 > "/var/backups/recapai/pre-update-$(date +%F-%H%M).sql.gz"

if [ -d .git ]; then
  echo "==> Pulling latest code"
  git pull --ff-only
fi

echo "==> Rebuilding images"
$COMPOSE build
echo "==> Restarting (migrations run automatically in the API container)"
$COMPOSE up -d
docker image prune -f >/dev/null
$COMPOSE ps
echo "✔ Updated"
