/** @type {import('next').NextConfig} */
const API = process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000';
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Single origin for the browser: /api/* is proxied to the Node API service.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  // NOTE: in production a reverse proxy (Caddy, see docker/Caddyfile) routes /api/* straight to the API
  // so large uploads/SSE never pass through Next.js. This rewrite is a dev convenience.
  experimental: { proxyTimeout: 300_000, middlewareClientMaxBodySize: '2gb' },
};
export default nextConfig;
