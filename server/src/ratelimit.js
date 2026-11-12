import { createHmac } from 'node:crypto';
import { createRedisClient } from './redis.js';

/**
 * In-memory fixed-window rate limiter. Never persisted, never logged.
 * @param {{ limit?: number, windowMs?: number, maxKeys?: number, now?: () => number }} [opts]
 * @returns {{ allow: (key: string) => Promise<boolean>, reset: () => void }}
 */
export function createRateLimiter({ limit = 20, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = {}) {
  let counts = new Map();
  let windowStart = now();

  function roll() {
    const t = now();
    if (t - windowStart >= windowMs) {
      counts = new Map();
      windowStart = t;
    }
  }

  return {
    async allow(key) {
      roll();
      if (!counts.has(key) && counts.size >= maxKeys) return false;
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return n <= limit;
    },
    reset() {
      counts = new Map();
      windowStart = now();
    },
  };
}

/**
 * Redis fixed-window rate limiter. The client key is keyed-hashed (HMAC-SHA256 with
 * `secret`, truncated), so raw IP addresses never reach Redis and a plain hash of the
 * small IPv4 space cannot be matched against the keys. Keys: `<prefix>rl:<hash>:<window>`,
 * each expiring after two windows.
 * @param {{ url: string, token: string, secret?: string, fetch?: typeof fetch, prefix?: string, limit?: number, windowMs?: number, now?: () => number }} opts
 *   secret: HMAC key; defaults to the Redis token, which the server always holds
 * @returns {{ allow: (key: string) => Promise<boolean> }}
 */
export function createRedisRateLimiter({
  url, token, secret = token, fetch = globalThis.fetch, prefix = 'alc:', limit = 20, windowMs = 60_000, now = Date.now,
}) {
  const redis = createRedisClient({ url, token, fetch });
  return {
    async allow(key) {
      const hash = createHmac('sha256', String(secret)).update(String(key)).digest('hex').slice(0, 32);
      const redisKey = `${prefix}rl:${hash}:${Math.floor(now() / windowMs)}`;
      const [n] = await redis.pipeline([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, Math.ceil((2 * windowMs) / 1000)],
      ]);
      return Number(n) <= limit;
    },
  };
}
