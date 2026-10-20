#!/bin/sh
# Apply pending migrations (safe & idempotent), seed plans/admin, then start the API.
set -e
cd /app/packages/core
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  node /app/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
  echo "[entrypoint] seeding plans / admin (idempotent)"
  node dist/seed.js
fi
cd /app
exec node apps/api/dist/server.js
