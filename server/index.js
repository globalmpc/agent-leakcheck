// Local development server. Production runs as a Vercel Function (api/index.js).
// Uses in-memory storage unless a Redis REST URL and token are set.
import http from 'node:http';
import { createApp } from './src/app.js';
import { createMemoryStore, createRedisStore } from './src/store.js';
import { createRateLimiter, createRedisRateLimiter } from './src/ratelimit.js';

const port = Number(process.env.PORT) || 3000;
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const salt = (process.env.STATS_SALT || '').length >= 16 ? process.env.STATS_SALT : undefined;

let store;
let limiter;
if (url && token) {
  store = createRedisStore({ url, token });
  limiter = createRedisRateLimiter({ url, token });
} else {
  console.warn('agent-leakcheck: no Redis configured; using in-memory storage (reset on restart)');
  store = createMemoryStore();
  limiter = createRateLimiter();
}

const server = http.createServer(createApp({ store, limiter, salt }));
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;

server.listen(port, () => {
  console.log(`agent-leakcheck-server listening on port ${port}`);
});
