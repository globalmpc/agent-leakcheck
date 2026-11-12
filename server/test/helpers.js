import http from 'node:http';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { createRateLimiter } from '../src/ratelimit.js';

const FAILS = {
  A: [],
  B: ['env-deny'],
  C: ['env-deny', 'mcp-plaintext'],
  D: ['env-deny', 'risky-mode'],
  F: ['env-deny', 'risky-mode', 'cc-version', 'mcp-plaintext'],
};
const IDS = ['cc-version', 'env-deny', 'risky-mode', 'mcp-plaintext', 'mcp-autoapprove', 'gh-token', 'ssh', 'cred-perms', 'secret-env'];

/** All 9 checks: pass, except ssh skip and the given ids fail. */
export function checksWith(fails = [], over = {}) {
  const c = Object.fromEntries(IDS.map((id) => [id, fails.includes(id) ? 'fail' : 'pass']));
  c.ssh = fails.includes('ssh') ? 'fail' : 'skip';
  return { ...c, ...over };
}

/** A consistent payload for grade g (default B). */
export function validPayload(over = {}, g = 'B') {
  return {
    v: '0.1.0',
    os: 'macos',
    grade: g,
    agents: [{ name: 'claude-code', version: '2.1.320' }],
    checks: checksWith(FAILS[g]),
    via: 'flag',
    ...over,
  };
}

export function gradePayload(g, over = {}) {
  return validPayload(over, g);
}

/** Start an app on an ephemeral port, with an in-memory store unless one is given. */
export async function start({ clock = { t: Date.UTC(2026, 10, 12) }, store, limiter, salt } = {}) {
  const now = () => clock.t;
  store ||= createMemoryStore({ now });
  limiter ||= createRateLimiter({ now });
  const server = http.createServer(createApp({ store, now, limiter, salt }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  };
  return { base, store, clock, close, server };
}

export function post(base, body, headers = {}) {
  return fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
