// PM2 config for local/sandbox development (mirrors the Docker topology).
// Caddy :3000 → /api/* → API :4000, everything else → Next.js :3001
module.exports = {
  apps: [
    { name: 'api', cwd: './apps/api', script: 'dist/server.js', node_args: '--env-file=../../.env', env: { PORT: 4000 }, max_memory_restart: '300M' },
    { name: 'worker', cwd: './apps/worker', script: 'dist/index.js', node_args: '--env-file=../../.env', max_memory_restart: '450M' },
    { name: 'web', cwd: './apps/web', script: '.next/standalone/apps/web/server.js', env: { PORT: 3001, HOSTNAME: '127.0.0.1', API_INTERNAL_URL: 'http://127.0.0.1:4000' }, max_memory_restart: '300M' },
    { name: 'edge', script: 'caddy', args: 'run --config docker/Caddyfile.dev --adapter caddyfile', interpreter: 'none' },
  ],
};
