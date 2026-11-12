import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, post, validPayload, gradePayload, checksWith } from './helpers.js';
import { createRateLimiter } from '../src/ratelimit.js';
import { sharerId } from '../src/app.js';

const SALT = 'test-salt-0123456789abcdef';

test('aggregation counts', async () => {
  const s = await start();
  try {
    await post(s.base, validPayload());
    await post(s.base, gradePayload('F', { os: 'linux', v: '0.2.0', agents: [{ name: 'claude-code', version: null }], via: 'prompt' }));
    const st = await s.store.snapshot();
    assert.equal(st.total, 2);
    assert.deepEqual(st.byDay, { '2026-11-12': 2 });
    assert.equal(st.grade.B, 1);
    assert.equal(st.grade.F, 1);
    assert.deepEqual(st.os, { macos: 1, linux: 1 });
    assert.deepEqual(st.toolVersion, { '0.1.0': 1, '0.2.0': 1 });
    assert.deepEqual(st.agents, { 'claude-code': 2 });
    assert.deepEqual(st.agentVersions, { 'claude-code': { '2.1.320': 1, unknown: 1 } });
    assert.deepEqual(st.checks['env-deny'], { pass: 0, fail: 2, skip: 0 });
    assert.deepEqual(st.checks['secret-env'], { pass: 2, fail: 0, skip: 0 });
    assert.deepEqual(st.checks.ssh, { pass: 0, fail: 0, skip: 2 });
    assert.deepEqual(st.via, { flag: 1, prompt: 1 });
  } finally {
    await s.close();
  }
});

test('betterThan math', async () => {
  const s = await start();
  try {
    const grade = async (g) => (await (await post(s.base, gradePayload(g))).json());
    assert.equal((await grade('C')).betterThan, 0);
    assert.equal((await grade('F')).betterThan, 0);
    // C, F, A: worse than A = C, F (2 of 3) -> 67
    assert.equal((await grade('A')).betterThan, 67);
    // then D: worse than D = F (1 of 4) -> 25
    assert.equal((await grade('D')).betterThan, 25);
    const r = await grade('A');
    assert.equal(r.total, 5);
    assert.equal(r.betterThan, 60);
  } finally {
    await s.close();
  }
});

test('distinct version keys are capped', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 205; i++) await post(s.base, validPayload({ v: `1.${i}.0` }), { 'x-forwarded-for': `10.0.0.${i}` });
    const keys = Object.keys((await s.store.snapshot()).toolVersion);
    assert.ok(keys.length <= 201);
    assert.ok(keys.includes('other'));
  } finally {
    await s.close();
  }
});

test('the store holds no IP, user agent or per-scan row', async () => {
  const s = await start();
  try {
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'MyAgent/9.9 (secret-ua)' });
    const snap = await s.store.snapshot();
    const text = JSON.stringify(snap);
    assert.ok(!text.includes('203.0.113.7'));
    assert.ok(!text.includes('MyAgent'));
    assert.ok(!text.includes('secret-ua'));
    assert.deepEqual(Object.keys(snap).sort(),
      ['agentVersions', 'agents', 'byDay', 'checks', 'grade', 'os', 'sharersByDay', 'toolVersion', 'total', 'via']);
    assert.deepEqual(snap.sharersByDay, {});
  } finally {
    await s.close();
  }
});

test('with a salt, distinct sharers are counted per day without storing the IP', async () => {
  const s = await start({ salt: SALT });
  try {
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.7' });
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.7' });
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.8' });
    s.clock.t += 86400000;
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.7' });
    const j = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(j.total, 4);
    assert.deepEqual(j.sharersByDay, { '2026-11-12': 2, '2026-11-13': 1 });
    assert.ok(!JSON.stringify(j).includes('203.0.113'));
  } finally {
    await s.close();
  }
});

test('without a salt, /api/stats has no sharersByDay', async () => {
  const s = await start();
  try {
    await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.7' });
    const j = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(j.total, 1);
    assert.ok(!('sharersByDay' in j));
  } finally {
    await s.close();
  }
});

test('sharerId is keyed, per day and hides the input', () => {
  const t = Date.UTC(2026, 10, 12, 15);
  const a = sharerId(SALT, '203.0.113.7', t);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, sharerId(SALT, '203.0.113.7', Date.UTC(2026, 10, 12, 1)));
  assert.notEqual(a, sharerId(SALT, '203.0.113.7', t + 86400000));
  assert.notEqual(a, sharerId(`${SALT}x`, '203.0.113.7', t));
  assert.notEqual(a, sharerId(SALT, '203.0.113.8', t));
  assert.ok(!a.includes('203'));
});

test('21st POST in a minute gets 429, window resets with clock', async () => {
  const s = await start();
  try {
    const h = { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' };
    for (let i = 0; i < 20; i++) assert.equal((await post(s.base, validPayload(), h)).status, 200);
    assert.equal((await post(s.base, validPayload(), h)).status, 429);
    assert.equal((await post(s.base, validPayload(), { 'x-forwarded-for': '198.51.100.2' })).status, 200);
    s.clock.t += 61_000;
    assert.equal((await post(s.base, validPayload(), h)).status, 200);
  } finally {
    await s.close();
  }
});

test('rate limiter unit', async () => {
  let t = 0;
  const l = createRateLimiter({ limit: 2, now: () => t });
  assert.ok((await l.allow('a')) && (await l.allow('a')));
  assert.ok(!(await l.allow('a')));
  t = 60_000;
  assert.ok(await l.allow('a'));
});

test('healthz, routing and cache headers', async () => {
  const s = await start();
  try {
    const h = await fetch(`${s.base}/healthz`);
    assert.equal(h.status, 200);
    assert.equal(await h.text(), 'ok');
    assert.match(h.headers.get('content-type'), /text\/plain/);
    assert.equal((await fetch(`${s.base}/nope`)).status, 404);
    const m = await fetch(`${s.base}/api/scan`);
    assert.equal(m.status, 405);
    assert.equal(m.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${s.base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.base}/api/stats`)).headers.get('cache-control'), 'public, max-age=60, s-maxage=60');
    assert.equal((await fetch(`${s.base}/`)).headers.get('cache-control'), 'public, max-age=60, s-maxage=60');
    const r = await post(s.base, validPayload());
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

test('/api/stats has failRate and generatedAt', async () => {
  const s = await start();
  try {
    await post(s.base, gradePayload('A', { checks: checksWith([], { ssh: 'fail', 'gh-token': 'skip' }) }));
    await post(s.base, gradePayload('A', { checks: checksWith([], { ssh: 'pass', 'gh-token': 'skip' }) }));
    await post(s.base, gradePayload('A', { checks: checksWith([], { ssh: 'fail', 'gh-token': 'skip' }) }));
    const j = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(j.total, 3);
    assert.ok(Math.abs(j.failRate.ssh - 2 / 3) < 1e-9);
    assert.equal(j.failRate['env-deny'], 0);
    assert.equal(j.failRate['gh-token'], null);
    assert.equal(j.generatedAt, '2026-11-12T00:00:00.000Z');
  } finally {
    await s.close();
  }
});

test('spoofed leftmost X-Forwarded-For does not evade the limit', async () => {
  const s = await start();
  try {
    const codes = [];
    for (let i = 0; i < 30; i++) {
      const r = await post(s.base, validPayload(), { 'x-forwarded-for': `1.2.3.${i}, 192.0.2.50` });
      codes.push(r.status);
    }
    assert.equal(codes.filter((c) => c === 200).length, 20);
    assert.equal(codes.filter((c) => c === 429).length, 10);
  } finally {
    await s.close();
  }
});

test('x-real-ip takes precedence over X-Forwarded-For', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 20; i++) {
      await post(s.base, validPayload(), { 'x-real-ip': '192.0.2.9', 'x-forwarded-for': `9.9.9.${i}` });
    }
    const r = await post(s.base, validPayload(), { 'x-real-ip': '192.0.2.9', 'x-forwarded-for': '8.8.8.8' });
    assert.equal(r.status, 429);
    const other = await post(s.base, validPayload(), { 'x-real-ip': '192.0.2.10' });
    assert.equal(other.status, 200);
  } finally {
    await s.close();
  }
});

test('rate limiter map is capped', async () => {
  let t = 0;
  const l = createRateLimiter({ limit: 5, maxKeys: 3, now: () => t });
  assert.ok((await l.allow('a')) && (await l.allow('b')) && (await l.allow('c')));
  assert.ok(!(await l.allow('d')));
  assert.ok(await l.allow('a'));
  t = 60_000;
  assert.ok(await l.allow('d'));
});

test('HEAD works on GET routes with no body; allow header lists real methods', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/healthz', '/api/stats']) {
      const r = await fetch(`${s.base}${p}`, { method: 'HEAD' });
      assert.equal(r.status, 200, p);
      assert.equal(await r.text(), '');
    }
    const r = await fetch(`${s.base}/healthz`, { method: 'PUT' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
  } finally {
    await s.close();
  }
});

test('aborted body does not leave the request hanging or crash the server', async () => {
  const s = await start();
  try {
    const { port } = s.server.address();
    const net = await import('node:net');
    await new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.write('POST /api/scan HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"v":');
        setTimeout(() => { c.destroy(); resolve(); }, 30);
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    assert.equal((await s.store.snapshot()).total, 0);
  } finally {
    await s.close();
  }
});
