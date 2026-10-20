import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';

export function createRedis(opts: RedisOptions = {}): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, ...opts });
}

let shared: Redis | null = null;
export function redis(): Redis {
  if (!shared) shared = createRedis();
  return shared;
}
