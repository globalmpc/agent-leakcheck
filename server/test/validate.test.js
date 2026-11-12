import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, post, validPayload, checksWith } from './helpers.js';

const bad = {
  'extra key': { ...validPayload(), extra: 1 },
  'missing key': (() => { const p = validPayload(); delete p.os; return p; })(),
  'wrong os enum': validPayload({ os: 'beos' }),
  'wrong grade enum': validPayload({ grade: 'E' }),
  'missing via': (() => { const p = validPayload(); delete p.via; return p; })(),
  'unknown via': validPayload({ via: 'cron' }),
  'null via': validPayload({ via: null }),
  'bad tool version': validPayload({ v: 'latest' }),
  'bad agent version': validPayload({ agents: [{ name: 'codex', version: '1.x' }] }),
  'path-like version': validPayload({ agents: [{ name: 'codex', version: '/Users/bob/.ssh' }] }),
  'path-like v': validPayload({ v: '../../etc/passwd' }),
  'five agents': validPayload({
    agents: ['claude-code', 'codex', 'cursor', 'gemini', 'codex'].map((name) => ({ name, version: null })),
  }),
  'duplicate agent': validPayload({
    agents: [{ name: 'codex', version: null }, { name: 'codex', version: '1.0' }],
  }),
  'unknown agent': validPayload({ agents: [{ name: 'vim', version: null }] }),
  'agent extra key': validPayload({ agents: [{ name: 'codex', version: null, path: '/x' }] }),
  'unknown check id': validPayload({ checks: checksWith([], { 'my-secret-var': 'fail' }) }),
  'training check id': validPayload({ checks: checksWith([], { training: 'pass' }) }),
  '__proto__ in checks': JSON.parse('{"v":"0.1.0","os":"macos","grade":"A","agents":[],"checks":{"__proto__":"fail"},"via":"flag"}'),
  'incomplete checks': validPayload({ checks: { ssh: 'pass' } }),
  'grade mismatch (better than checks)': validPayload({ grade: 'A' }),
  'grade mismatch (worse than checks)': validPayload({ grade: 'F' }),
  'version segment too long': validPayload({ v: '1234567.0.0' }),
  'version too long': validPayload({ v: '1.0.0-' + 'a'.repeat(20) + '.' + '1'.repeat(10) }),
  'empty checks': validPayload({ checks: {} }),
  'bad check status': validPayload({ checks: checksWith([], { ssh: 'maybe' }) }),
  'array body': [],
  'null body': null,
  'string body': 'hello',
};

for (const [name, body] of Object.entries(bad)) {
  test(`rejects ${name}`, async () => {
    const s = await start();
    try {
      const r = await post(s.base, JSON.stringify(body));
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.equal(typeof j.error, 'string');
      assert.equal((await s.store.snapshot()).total, 0);
    } finally {
      await s.close();
    }
  });
}

test('error reason never echoes input values', async () => {
  const s = await start();
  try {
    const r = await post(s.base, validPayload({ v: 'SECRET-VALUE-123/etc' }));
    const text = await r.text();
    assert.equal(r.status, 400);
    assert.ok(!text.includes('SECRET'));
  } finally {
    await s.close();
  }
});

test('rejects invalid JSON', async () => {
  const s = await start();
  try {
    const r = await post(s.base, '{not json');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).ok, false);
  } finally {
    await s.close();
  }
});

test('rejects wrong content-type with 415', async () => {
  const s = await start();
  try {
    const r = await post(s.base, validPayload(), { 'content-type': 'text/plain' });
    assert.equal(r.status, 415);
  } finally {
    await s.close();
  }
});

test('rejects body over 2 KB with 413', async () => {
  const s = await start();
  try {
    const r = await post(s.base, JSON.stringify({ pad: 'x'.repeat(3000) }));
    assert.equal(r.status, 413);
  } finally {
    await s.close();
  }
});

test('accepts valid payloads incl. null version, 0 agents, prerelease', async () => {
  const s = await start();
  try {
    for (const p of [
      validPayload(),
      validPayload({ agents: [], v: '1.2.3-beta.1' }),
      validPayload({ agents: [{ name: 'cursor', version: null }] }),
    ]) {
      assert.equal((await post(s.base, p)).status, 200);
    }
  } finally {
    await s.close();
  }
});
