import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createMemoryStore, createRedisStore } from '../src/store.js';
import { createRedisRateLimiter } from '../src/ratelimit.js';
import { createRedisClient } from '../src/redis.js';
import { start, post, validPayload, gradePayload } from './helpers.js';

const URL_ = 'https://example-redis.upstash.io';
const TOKEN = 'tok-secret-123';

/** Fake Upstash REST endpoint that emulates only the commands the server uses. */
function fakeRedis({ fail = false } = {}) {
  const data = new Map();
  const calls = [];
  const hash = (k) => (data.has(k) ? data.get(k) : data.set(k, new Map()).get(k));
  const set = (k) => (data.has(k) ? data.get(k) : data.set(k, new Set()).get(k));
  function run([cmd, ...a]) {
    switch (cmd) {
      case 'INCR': { const n = Number(data.get(a[0]) || 0) + 1; data.set(a[0], String(n)); return n; }
      case 'GET': return data.has(a[0]) ? data.get(a[0]) : null;
      case 'EXPIRE': return 1;
      case 'HINCRBY': { const h = hash(a[0]); const n = Number(h.get(a[1]) || 0) + Number(a[2]); h.set(a[1], String(n)); return n; }
      case 'HGETALL': return [...(data.get(a[0]) || new Map())].flat();
      // HyperLogLog emulated as an exact set.
      case 'PFADD': { const s = set(a[0]); const n = s.size; a.slice(1).forEach((x) => s.add(x)); return s.size > n ? 1 : 0; }
      case 'PFCOUNT': return data.get(a[0])?.size || 0;
      case 'EVAL': {
        // BUMP_CAPPED: KEYS[1]=a[2], ARGV=[field, cap]
        const h = hash(a[2]);
        let f = a[3];
        if (!h.has(f) && h.size >= Number(a[4])) f = 'other';
        const n = Number(h.get(f) || 0) + 1;
        h.set(f, String(n));
        return n;
      }
      default: throw new Error(`unsupported ${cmd}`);
    }
  }
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) return new Response('{"error":"nope"}', { status: 500 });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return new Response('{"error":"auth"}', { status: 401 });
    const out = JSON.parse(init.body).map((c) => ({ result: run(c) }));
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls, data };
}

test('redis store matches the memory store snapshot and betterThan', async () => {
  const r = fakeRedis();
  const now = () => Date.UTC(2026, 10, 12);
  const redis = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch, now });
  const mem = createMemoryStore({ now });
  const payloads = [
    validPayload(),
    gradePayload('F', { os: 'linux', v: '0.2.0', agents: [{ name: 'claude-code', version: null }, { name: 'codex', version: '1.0.0' }] }),
    gradePayload('A', { via: 'prompt' }),
    gradePayload('D'),
  ];
  for (const p of payloads) assert.deepEqual(await redis.record(p), await mem.record(p));
  assert.deepEqual(await redis.snapshot(), await mem.snapshot());
});

test('redis store matches the memory store for distinct sharers across days', async () => {
  const r = fakeRedis();
  let t = Date.UTC(2026, 10, 12);
  const now = () => t;
  const redis = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch, now });
  const mem = createMemoryStore({ now });
  const sharers = ['a'.repeat(32), 'a'.repeat(32), 'b'.repeat(32), undefined];
  for (const sharer of sharers) for (const st of [redis, mem]) await st.record(validPayload(), { sharer });
  t += 86400000;
  for (const st of [redis, mem]) await st.record(validPayload(), { sharer: 'c'.repeat(32) });
  const snap = await redis.snapshot();
  assert.deepEqual(snap, await mem.snapshot());
  assert.deepEqual(snap.sharersByDay, { '2026-11-12': 2, '2026-11-13': 1 });
  assert.deepEqual(r.calls[0].body.slice(-3), [
    ['PFADD', 'alc:sharers:2026-11-12', 'a'.repeat(32)],
    ['EXPIRE', 'alc:sharers:2026-11-12', 16 * 86400],
    ['HGETALL', 'alc:grade'],
  ]);
  assert.ok(!r.calls[3].body.some((c) => c[0] === 'PFADD'));
  // Days older than the 14-day window are not reported.
  t += 14 * 86400000;
  assert.deepEqual((await redis.snapshot()).sharersByDay, {});
});

test('empty redis snapshot has the empty-store shape', async () => {
  const r = fakeRedis();
  const redis = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch });
  assert.deepEqual(await redis.snapshot(), await createMemoryStore().snapshot());
});

test('redis store caps distinct version keys', async () => {
  const r = fakeRedis();
  const redis = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch });
  for (let i = 0; i < 205; i++) await redis.record(validPayload({ v: `1.${i}.0` }));
  const keys = Object.keys((await redis.snapshot()).toolVersion);
  assert.equal(keys.length, 201);
  assert.ok(keys.includes('other'));
});

test('requests use bearer auth, the right paths and array bodies', async () => {
  const r = fakeRedis();
  const redis = createRedisStore({ url: `${URL_}/`, token: TOKEN, fetch: r.fetch });
  await redis.record(validPayload());
  await redis.snapshot();
  assert.equal(r.calls[0].url, `${URL_}/multi-exec`);
  assert.equal(r.calls[1].url, `${URL_}/pipeline`);
  for (const c of r.calls) {
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.init.headers['content-type'], 'application/json');
    assert.ok(Array.isArray(c.body) && c.body.every(Array.isArray));
  }
  assert.deepEqual(r.calls[0].body[0], ['INCR', 'alc:total']);
});

test('redis limiter allows 20 per window, denies the 21st, resets next window', async () => {
  const r = fakeRedis();
  let t = 0;
  const l = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: r.fetch, now: () => t });
  for (let i = 0; i < 20; i++) assert.equal(await l.allow('198.51.100.1'), true);
  assert.equal(await l.allow('198.51.100.1'), false);
  assert.equal(await l.allow('198.51.100.2'), true);
  t = 60_000;
  assert.equal(await l.allow('198.51.100.1'), true);
});

test('no raw IP reaches Redis keys or commands', async () => {
  const r = fakeRedis();
  const l = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: r.fetch });
  await l.allow('203.0.113.77');
  const sent = JSON.stringify(r.calls.map((c) => c.body));
  const keys = JSON.stringify([...r.data.keys()]);
  assert.ok(!sent.includes('203.0.113.77') && !keys.includes('203.0.113.77'));
  assert.match([...r.data.keys()][0], /^alc:rl:[0-9a-f]{32}:\d+$/);
});

test('rate-limit keys are keyed hashes, not a plain sha256 of the IP', async () => {
  const ip = '203.0.113.77';
  const hashOf = async (opts) => {
    const r = fakeRedis();
    await createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: r.fetch, ...opts }).allow(ip);
    return [...r.data.keys()][0].split(':')[2];
  };
  const plain = createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const byToken = await hashOf({});
  const bySecret = await hashOf({ secret: 'test-salt-0123456789abcdef' });
  assert.equal(byToken, createHmac('sha256', TOKEN).update(ip).digest('hex').slice(0, 32));
  assert.notEqual(byToken, plain);
  assert.notEqual(bySecret, plain);
  assert.notEqual(bySecret, byToken);
});

test('errors never contain the URL or token', async () => {
  for (const opts of [{ fail: true }, {}]) {
    const r = fakeRedis(opts);
    const c = createRedisClient({ url: URL_, token: opts.fail ? TOKEN : 'wrong-token-xyz', fetch: r.fetch });
    await assert.rejects(c.pipeline([['GET', 'x']]), (e) => {
      assert.equal(e.message, 'redis request failed');
      assert.ok(!e.message.includes('upstash') && !e.message.includes(TOKEN) && !e.message.includes('wrong-token'));
      return true;
    });
  }
  const boom = async () => { throw new Error(`connect ${URL_} ${TOKEN}`); };
  const c = createRedisClient({ url: URL_, token: TOKEN, fetch: boom });
  await assert.rejects(c.multi([['GET', 'x']]), { message: 'redis request failed' });
});

test('an error item in a response fails the call', async () => {
  const fetch = async () => new Response(JSON.stringify([{ error: 'WRONGTYPE' }]), { status: 200 });
  const c = createRedisClient({ url: URL_, token: TOKEN, fetch });
  await assert.rejects(c.pipeline([['GET', 'x']]), { message: 'redis request failed' });
  const discarded = async () => new Response(JSON.stringify({ error: 'EXECABORT' }), { status: 200 });
  await assert.rejects(createRedisClient({ url: URL_, token: TOKEN, fetch: discarded }).multi([['GET', 'x']]), { message: 'redis request failed' });
});

test('app answers 503 without detail when the store or limiter fails', async () => {
  const bad = fakeRedis({ fail: true });
  const store = createRedisStore({ url: URL_, token: TOKEN, fetch: bad.fetch });
  const limiter = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: bad.fetch });
  const s = await start({ store, limiter });
  try {
    const scan = await post(s.base, validPayload());
    assert.equal(scan.status, 503);
    assert.deepEqual(await scan.json(), { ok: false, error: 'unavailable' });
    const stats = await fetch(`${s.base}/api/stats`);
    assert.equal(stats.status, 503);
    assert.equal(stats.headers.get('cache-control'), 'no-store');
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 503);
    const text = await page.text();
    assert.ok(!text.includes('upstash') && !text.includes(TOKEN));
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  } finally {
    await s.close();
  }
});

test('app answers 503 when the store fails after the body is read', async () => {
  const good = fakeRedis();
  const bad = fakeRedis({ fail: true });
  const store = createRedisStore({ url: URL_, token: TOKEN, fetch: bad.fetch });
  const limiter = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: good.fetch });
  const s = await start({ store, limiter });
  try {
    const scan = await post(s.base, validPayload());
    assert.equal(scan.status, 503);
    assert.deepEqual(await scan.json(), { ok: false, error: 'unavailable' });
  } finally {
    await s.close();
  }
});

test('works end to end through the app with the redis store and limiter', async () => {
  const r = fakeRedis();
  const store = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch });
  const limiter = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: r.fetch });
  const s = await start({ store, limiter });
  try {
    const j = await (await post(s.base, validPayload(), { 'x-forwarded-for': '203.0.113.5' })).json();
    assert.deepEqual(j, { ok: true, total: 1, betterThan: 0 });
    const stats = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(stats.total, 1);
    assert.ok(!JSON.stringify(r.calls.map((c) => c.body)).includes('203.0.113.5'));
    assert.ok(!('sharersByDay' in stats));
  } finally {
    await s.close();
  }
});

test('with a salt, the redis path counts sharers and never sends the IP', async () => {
  const r = fakeRedis();
  const store = createRedisStore({ url: URL_, token: TOKEN, fetch: r.fetch });
  const limiter = createRedisRateLimiter({ url: URL_, token: TOKEN, fetch: r.fetch });
  const s = await start({ store, limiter, salt: 'test-salt-0123456789abcdef' });
  try {
    for (const ip of ['203.0.113.5', '203.0.113.5', '203.0.113.6']) {
      assert.equal((await post(s.base, validPayload(), { 'x-forwarded-for': ip })).status, 200);
    }
    const stats = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(Object.values(stats.sharersByDay).reduce((a, b) => a + b, 0), 2);
    const sent = JSON.stringify(r.calls.map((c) => c.body));
    assert.ok(!sent.includes('203.0.113') && !sent.includes('test-salt'));
    assert.ok(![...r.data.keys()].some((k) => k.includes('203.0.113')));
  } finally {
    await s.close();
  }
});

test('api/index.js without Redis env answers 503 on data routes, 200 on /healthz', async () => {
  const saved = { ...process.env };
  for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  try {
    const { default: handler } = await import('../api/index.js?noenv');
    const http = await import('node:http');
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal((await fetch(`${base}/api/stats`)).status, 503);
      assert.equal((await post(base, validPayload())).status, 503);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  } finally {
    process.env = saved;
  }
});
