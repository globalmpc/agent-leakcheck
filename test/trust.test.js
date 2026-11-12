// Trust scaffold: rules 2, 4, 5 of docs/SPEC.md. Iterates src/checks/index.js, so it
// covers every check added later without changes.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import checks from '../src/checks/index.js';
import { buildContext } from '../src/context.js';
import { runScan } from '../src/scan.js';
import { formatHuman, formatJson } from '../src/report.js';
import { buildPayload } from '../src/share.js';

const HOME = new URL('./fixtures/trust-home', import.meta.url).pathname;
const SYSTEM_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sys-'));
const PLANTED = 'lc_planted_token_9f8e7d6c5b4a';
const FORBIDDEN = [
  PLANTED,
  'LEAKCHECK_FAKE_SECRET_VALUE_123',
  'FAKE PRIVATE KEY CONTENT',
  'LEAKCHECK_ENV_VALUE_XYZ',
];

afterEach(() => mock.restoreAll());

const stubExec = { sshAgentKeyCount: async () => null, binaryVersion: async () => null };

/** Record the path of every fs call that can read file contents. */
function spyOpens(opened) {
  for (const [obj, name] of [
    [fs, 'readFileSync'], [fs, 'openSync'], [fs, 'createReadStream'], [fs, 'readFile'],
    [fs.promises, 'readFile'], [fs.promises, 'open'],
  ]) {
    const orig = obj[name];
    mock.method(obj, name, function (p, ...rest) {
      opened.push(String(p));
      return orig.call(this, p, ...rest);
    });
  }
}

/** Run a full scan on the trust fixture with network blocked and fs reads recorded. */
async function trustScan() {
  const blocked = [
    mock.method(globalThis, 'fetch', () => { throw new Error('network blocked'); }),
    mock.method(http, 'request', () => { throw new Error('network blocked'); }),
    mock.method(https, 'request', () => { throw new Error('network blocked'); }),
    mock.method(net, 'connect', () => { throw new Error('network blocked'); }),
  ];
  const opened = [];
  spyOpens(opened);
  const env = { PATH: '/nonexistent', MY_API_TOKEN: 'LEAKCHECK_ENV_VALUE_XYZ' };
  const ctx = await buildContext({ home: HOME, cwd: HOME, platform: 'linux', env, exec: stubExec, systemRoot: SYSTEM_ROOT });
  const result = await runScan(ctx, checks);
  const calls = blocked.map((m) => m.mock.calls.length);
  mock.restoreAll();
  return { ctx, result, opened, calls };
}

test('every check has the documented shape', () => {
  const ids = new Set();
  for (const c of checks) {
    assert.match(c.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.equal(typeof c.title, 'string');
    assert.ok(['high', 'medium', 'warning', 'info'].includes(c.severity));
    assert.equal(typeof c.run, 'function');
    assert.ok(Array.isArray(c.docs));
  }
});

test('ctx carries env names only', async () => {
  const ctx = await buildContext({ home: HOME, cwd: HOME, platform: 'linux', env: { A_KEY: 'v1', B: 'v2' }, exec: stubExec, systemRoot: SYSTEM_ROOT });
  assert.deepEqual(ctx.envNames, ['A_KEY', 'B']);
  assert.ok(!JSON.stringify(Object.keys(ctx)).includes('env"') && !('env' in ctx));
  assert.ok(!JSON.stringify(ctx.envNames).includes('v1'));
});

test('rule 2: a full scan never touches the network', async () => {
  const { calls } = await trustScan();
  assert.deepEqual(calls, [0, 0, 0, 0]);
});

test('rule 4: no .env file and nothing inside .ssh is ever opened', async () => {
  const { opened } = await trustScan();
  for (const p of opened) {
    assert.ok(!/(^|[\\/])\.env(\..+)?$/.test(p) && !/[\\/]\.ssh[\\/]/.test(p), `opened ${p}`);
    assert.ok(!/(\.credentials\.json|auth\.json|\.git-credentials)$/.test(p), `opened ${p}`);
  }
});

test('credential files are stat-checked but their rows carry no value', async () => {
  const { result } = await trustScan();
  const rows = result.checks.find((c) => c.id === 'cred-perms').results;
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.status !== 'skip'), 'fixture credential files were found');
});

test('rule 5: planted secrets appear in no output', async () => {
  const { result } = await trustScan();
  const outputs = [
    formatHuman(result, { color: false }),
    formatHuman(result, { color: true }),
    formatJson(result),
    JSON.stringify(buildPayload(result, 'linux')),
  ];
  for (const out of outputs) {
    for (const secret of FORBIDDEN) assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
});

test('a malformed config with a planted secret leaks through no output', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bad-'));
  try {
    const bad = `{ "mcpServers": { "x": { "env": { "API_KEY": "${PLANTED}", `;
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), bad);
    fs.writeFileSync(path.join(home, '.claude.json'), bad);
    const opened = [];
    spyOpens(opened);
    const ctx = await buildContext({ home, cwd: home, platform: 'linux', env: { PATH: '/nonexistent' }, exec: stubExec, systemRoot: SYSTEM_ROOT });
    const result = await runScan(ctx, checks);
    mock.restoreAll();
    assert.ok(opened.some((p) => p.endsWith('mcp.json')), 'the malformed file was read');
    const outputs = [
      formatHuman(result, { color: false }), formatJson(result),
      JSON.stringify(buildPayload(result, 'linux')), JSON.stringify(ctx.envNames),
    ];
    for (const out of outputs) assert.ok(!out.includes(PLANTED), 'leaked planted secret');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
