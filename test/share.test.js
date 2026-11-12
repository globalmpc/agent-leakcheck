import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildPayload, sendPayload } from '../src/share.js';

const result = (over = {}) => ({
  version: '0.1.0', grade: 'B', score: 80,
  agents: [{ id: 'claude-code', version: '2.1.320' }, { id: 'codex', version: 'weird version!' }, { id: 'cursor', version: null }],
  checks: [
    { id: 'env-deny', severity: 'high', status: 'fail', results: [{ message: 'SECRET-PATH /home/u' }] },
    { id: 'cc-version', severity: 'high', status: 'pass', results: [] },
    { id: 'secret-env', severity: 'warning', status: 'fail', results: [] },
    { id: 'gh-token', severity: 'medium', status: 'skip', results: [] },
    { id: 'ssh', severity: 'medium', status: 'info', results: [] },
    { id: 'training', severity: 'info', status: 'info', results: [] },
  ],
  ...over,
});

test('payload has exactly the allowed keys', () => {
  const p = buildPayload(result(), 'darwin');
  assert.deepEqual(Object.keys(p), ['v', 'os', 'grade', 'agents', 'checks', 'via']);
  for (const a of p.agents) assert.deepEqual(Object.keys(a), ['name', 'version']);
  assert.ok(!JSON.stringify(p).includes('SECRET-PATH'));
});

test('checks: info excluded, warning fail reported as fail, others mapped', () => {
  const p = buildPayload(result(), 'linux');
  assert.deepEqual(p.checks, { 'env-deny': 'fail', 'cc-version': 'pass', 'secret-env': 'fail', 'gh-token': 'skip', ssh: 'skip' });
});

test('via: prompt or flag, anything else becomes flag', () => {
  assert.equal(buildPayload(result(), 'linux', 'prompt').via, 'prompt');
  assert.equal(buildPayload(result(), 'linux', 'flag').via, 'flag');
  assert.equal(buildPayload(result(), 'linux').via, 'flag');
  assert.equal(buildPayload(result(), 'linux', '/home/u').via, 'flag');
});

test('versions are sanitised', () => {
  const p = buildPayload(result(), 'linux');
  assert.deepEqual(p.agents, [
    { name: 'claude-code', version: '2.1.320' },
    { name: 'codex', version: null },
    { name: 'cursor', version: null },
  ]);
  const long = buildPayload(result({ agents: [{ id: 'codex', version: '1.0.0-rc.1' }, { id: 'x', version: '1.0.0-' + 'a'.repeat(30) }] }), 'linux');
  assert.equal(long.agents[0].version, '1.0.0-rc.1');
  assert.equal(long.agents[1].version, null);
});

test('os mapping and agent cap', () => {
  assert.equal(buildPayload(result(), 'darwin').os, 'macos');
  assert.equal(buildPayload(result(), 'linux').os, 'linux');
  assert.equal(buildPayload(result(), 'win32').os, 'windows');
  assert.equal(buildPayload(result(), 'freebsd').os, 'other');
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, version: null }));
  assert.equal(buildPayload(result({ agents: five }), 'linux').agents.length, 4);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('sendPayload posts JSON to /api/scan and parses the answer', async () => {
  let seen;
  const { server, url } = await serve((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, type: req.headers['content-type'], body };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, total: 123, betterThan: 64 }));
    });
  });
  const payload = buildPayload(result(), 'linux');
  const r = await sendPayload(payload, `${url}/`);
  server.close();
  assert.deepEqual(r, { ok: true, total: 123, betterThan: 64 });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/scan');
  assert.equal(seen.type, 'application/json');
  assert.deepEqual(JSON.parse(seen.body), payload);
});

test('HTTP errors, bad bodies, timeouts and refused connections give ok:false', async () => {
  const payload = buildPayload(result(), 'linux');
  let s = await serve((req, res) => { res.statusCode = 500; res.end('x'); });
  assert.deepEqual(await sendPayload(payload, s.url), { ok: false, reason: 'http 500' });
  s.server.close();
  s = await serve((req, res) => res.end('not json'));
  assert.equal((await sendPayload(payload, s.url)).ok, false);
  s.server.close();
  s = await serve(() => {});
  assert.deepEqual(await sendPayload(payload, s.url, { timeoutMs: 100 }), { ok: false, reason: 'timeout' });
  s.server.closeAllConnections();
  s.server.close();
  assert.deepEqual(await sendPayload(payload, 'http://127.0.0.1:9'), { ok: false, reason: 'network error' });
});
