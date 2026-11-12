import { createHmac } from 'node:crypto';
import { createRateLimiter } from './ratelimit.js';
import { renderPage } from './page.js';
import { CHECK_IDS } from './scoring.js';
import { validatePayload } from './validate.js';

const MAX_BODY = 2048;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'public, max-age=60, s-maxage=60',
};

function sendJson(res, status, obj, cache = 'no-store') {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

/** Marks a failure of the store or the rate limiter, answered with a generic 503. */
class BackendError extends Error {}

async function backend(fn) {
  try {
    return await fn();
  } catch {
    throw new BackendError('backend unavailable');
  }
}

/**
 * Client key for rate limiting. On Vercel, X-Forwarded-For and X-Real-IP both
 * carry the public client IP and Vercel overwrites them instead of forwarding
 * client-supplied values (https://vercel.com/docs/headers/request-headers).
 * Fallbacks: the rightmost X-Forwarded-For entry (the one the nearest proxy
 * appended, not client-controlled), then the socket address.
 */
function clientKey(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  const last = typeof xff === 'string' ? xff.split(',').pop().trim() : '';
  return last || req.socket.remoteAddress || 'unknown';
}

/**
 * Opaque per-day sharer id: HMAC-SHA256 keyed with the server secret over the UTC day and
 * the client key, truncated. The day in the input makes ids unlinkable across days.
 */
export function sharerId(salt, key, t) {
  const day = new Date(t).toISOString().slice(0, 10);
  return createHmac('sha256', salt).update(`${day}\n${key}`).digest('hex').slice(0, 32);
}

/**
 * Read the body, giving up once it exceeds the limit. Resolves null if too
 * large. Settles (rejects) if the client aborts or the socket closes early.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const settle = (fn, val) => {
      if (done) return;
      done = true;
      fn(val);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.removeAllListeners('data');
        req.resume();
        settle(resolve, null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => settle(reject, err));
    req.on('aborted', () => settle(reject, new Error('aborted')));
    req.on('close', () => settle(reject, new Error('closed')));
  });
}

/** Aggregates plus derived failRate and generatedAt. sharersByDay only when counting is on. */
async function buildStats(store, now, salt) {
  const s = await backend(() => store.snapshot());
  if (!salt) delete s.sharersByDay;
  s.failRate = {};
  for (const id of CHECK_IDS) {
    const c = s.checks[id];
    const n = c ? c.pass + c.fail : 0;
    if (c) s.failRate[id] = n === 0 ? null : c.fail / n;
  }
  s.generatedAt = new Date(now()).toISOString();
  return s;
}

async function handleScan(req, res, { store, limiter, now, salt }) {
  const key = clientKey(req);
  if (!(await backend(() => limiter.allow(key)))) return sendError(res, 429, 'rate limit exceeded');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return sendError(res, 415, 'content-type must be application/json');
  const text = await readBody(req);
  if (text === null) return sendError(res, 413, 'body too large');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return sendError(res, 400, 'invalid JSON');
  }
  const v = validatePayload(data);
  if (!v.ok) return sendError(res, 400, v.error);
  const sharer = salt && key !== 'unknown' ? sharerId(salt, key, now()) : undefined;
  const { total, betterThan } = await backend(() => store.record(v.value, { sharer }));
  return sendJson(res, 200, { ok: true, total, betterThan });
}

/**
 * Build the request handler. Store, clock and rate limiter are injectable.
 * `salt` (the STATS_SALT secret) turns on distinct-sharer counting; without it no sharer id is made.
 * @param {{ store: object, now?: () => number, limiter?: object, salt?: string }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createApp({ store, now = Date.now, limiter = createRateLimiter({ now }), salt }) {
  const routes = {
    '/': [['GET', 'HEAD'], async (req, res) => {
      const html = renderPage(await buildStats(store, now, salt));
      res.writeHead(200, PAGE_HEADERS);
      res.end(html);
    }],
    '/healthz': [['GET', 'HEAD'], (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
    }],
    '/api/stats': [['GET', 'HEAD'], async (req, res) => sendJson(res, 200, await buildStats(store, now, salt), 'public, max-age=60, s-maxage=60')],
    '/api/scan': [['POST'], (req, res) => handleScan(req, res, { store, limiter, now, salt })],
  };

  return async function handler(req, res) {
    try {
      const pathname = (req.url || '/').split('?')[0];
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : null;
      if (!route) return sendError(res, 404, 'not found');
      if (!route[0].includes(req.method)) {
        res.setHeader('allow', route[0].join(', '));
        return sendError(res, 405, 'method not allowed');
      }
      await route[1](req, res);
    } catch (err) {
      // req is already destroyed once its body is read; only a gone response means no reply.
      if (res.destroyed) return;
      if (err instanceof BackendError) {
        console.error('agent-leakcheck: backend unavailable');
        if (res.headersSent) return res.end();
        if (req.url && req.url.split('?')[0] === '/') {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end('temporarily unavailable');
        }
        return sendError(res, 503, 'unavailable');
      }
      console.error('agent-leakcheck: request failed');
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.end();
    }
  };
}
