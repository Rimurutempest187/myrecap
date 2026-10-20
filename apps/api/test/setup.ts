// Integration tests run against real Postgres + Redis (see README "Testing").
// Uses TEST_DATABASE_URL if provided, else DATABASE_URL from the repo .env.
import { readFileSync, existsSync } from 'node:fs';
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
