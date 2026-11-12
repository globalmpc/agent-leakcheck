import { createApp } from '../src/app.js';
import { createRedisStore } from '../src/store.js';
import { createRedisRateLimiter } from '../src/ratelimit.js';

// Vercel Marketplace (Upstash Redis) injects one of these pairs; both are accepted.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
// Secret key for distinct-sharer ids and rate-limit keys. Unset or shorter than 16 chars:
// counting stays off and rate-limit keys are keyed with the Redis token instead.
const salt = (process.env.STATS_SALT || '').length >= 16 ? process.env.STATS_SALT : undefined;

function build() {
  if (url && token) {
    return { store: createRedisStore({ url, token }), limiter: createRedisRateLimiter({ url, token, secret: salt || token }) };
  }
  // No Redis configured: data routes answer 503, /healthz still works. No memory fallback.
  const fail = async () => {
    throw new Error('redis is not configured');
  };
  return { store: { record: fail, snapshot: fail }, limiter: { allow: fail } };
}

export default createApp({ ...build(), salt });
