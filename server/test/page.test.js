import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, post, validPayload, gradePayload } from './helpers.js';
import { renderPage, esc } from '../src/page.js';

async function page(s) {
  const r = await fetch(`${s.base}/`);
  return { r, html: await r.text() };
}

test('empty state', async () => {
  const s = await start();
  try {
    const { r, html } = await page(s);
    assert.equal(r.status, 200);
    assert.match(html, /agent-leakcheck stats/);
    assert.match(html, /No shared scans yet/);
  } finally {
    await s.close();
  }
});

test('page with data: content, headers, no external requests, no banned words', async () => {
  const s = await start();
  try {
    await post(s.base, validPayload());
    await post(s.base, gradePayload('D', { agents: [{ name: 'codex', version: null }], via: 'prompt' }));
    const { r, html } = await page(s);
    assert.match(r.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
    assert.ok(!/script-src/.test(r.headers.get('content-security-policy')));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(html, /From the prompt: 1\. With --share: 1\./);
    assert.match(html, /Shares per day/);
    assert.match(html, /<span>10-30<\/span>.*<span>11-12<\/span><div class="track"><div class="fill" style="width:100\.0%"><\/div><\/div><span class="num">2<\/span>/s);
    assert.ok(!html.includes('<span>10-29</span>'));
    assert.match(html, /how it was shared \(prompt or --share\)/);
    assert.match(html, /Grade distribution/);
    assert.match(html, /Fail rate per check/);
    assert.match(html, /Agents seen/);
    assert.match(html, /What is collected/);
    assert.match(html, /Never collected: file paths, secret values, usernames, hostnames, env var names, IP addresses \(not stored\)/);
    assert.ok(html.trim().endsWith('An open-source tool from <a href="https://globalmpc.tech">MPC</a>.</p></footer>\n</main></body></html>'));
    assert.ok(!/<script/i.test(html));
    assert.ok(!/<link/i.test(html));
    assert.ok(!/<img/i.test(html));
    const urls = html.match(/https?:\/\/[^\s"'<)]+/g) || [];
    for (const u of urls) {
      assert.ok(['https://github.com/globalmpc/agent-leakcheck', 'https://globalmpc.tech'].includes(u), u);
    }
    assert.ok(!/token|wallet|blockchain|crypto|opbnb/i.test(html));
  } finally {
    await s.close();
  }
});

test('people column and note appear only with sharer counts', async () => {
  const base = { total: 3, byDay: { '2026-11-12': 3 }, grade: { A: 0, B: 3, C: 0, D: 0, F: 0 }, checks: {}, failRate: {}, agents: {}, via: { flag: 3 }, generatedAt: '2026-11-12T10:00:00.000Z' };
  const without = renderPage(base);
  assert.ok(!without.includes('people') && !without.includes('HyperLogLog'));
  const html = renderPage({ ...base, sharersByDay: { '2026-11-12': 2 } });
  assert.match(html, /<span class="num">shares<\/span><span class="num">people<\/span>/);
  assert.match(html, /<span>11-12<\/span><div class="track"><div class="fill" style="width:100\.0%"><\/div><\/div><span class="num">3<\/span><span class="num">2<\/span>/);
  assert.match(html, /<span>11-11<\/span>.*?<span class="num">0<\/span><span class="num">0<\/span>/s);
  assert.match(html, /People: distinct sharers per day, estimated\./);
  assert.match(html, /keyed hash of the IP address .*HyperLogLog.*deleted after 16 days\. The IP address itself is never stored\./);
  assert.ok(!/token|wallet|blockchain|crypto|opbnb/i.test(html));
});

test('escapes everything', () => {
  assert.equal(esc('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  const html = renderPage({
    total: 1,
    grade: { A: 0, B: 1, C: 0, D: 0, F: 0 },
    checks: {},
    failRate: {},
    agents: { '<b>x</b>': 1 },
  });
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('page with all 9 checks populated has no banned words', async () => {
  const s = await start();
  try {
    await post(s.base, validPayload());
    await post(s.base, gradePayload('F'));
    const j = await (await fetch(`${s.base}/api/stats`)).json();
    assert.equal(Object.keys(j.checks).length, 9);
    const { html } = await page(s);
    assert.ok(!/token|wallet|blockchain|crypto|opbnb/i.test(html));
  } finally {
    await s.close();
  }
});
