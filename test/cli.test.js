import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VERSION } from '../src/config.js';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;
const HOME = new URL('./fixtures/empty-home', import.meta.url).pathname;
const EMPTY_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-path-'));
const SYSTEM_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-sys-'));

function run(args, extraEnv = {}) {
  const env = {
    PATH: EMPTY_PATH, SSH_AUTH_SOCK: '', AGENT_LEAKCHECK_HOME: HOME, AGENT_LEAKCHECK_CWD: HOME,
    AGENT_LEAKCHECK_SYSTEM_ROOT: SYSTEM_ROOT,
    AGENT_LEAKCHECK_ENDPOINT: 'http://127.0.0.1:9', ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function counter(body = { ok: true, total: 7, betterThan: 50 }) {
  return new Promise((resolve) => {
    const state = { hits: 0 };
    state.server = http.createServer((req, res) => {
      state.hits++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        state.body = raw;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    state.server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${state.server.address().port}`;
      resolve(state);
    });
  });
}

test('--version', async () => {
  const r = await run(['--version']);
  assert.deepEqual([r.code, r.stdout.trim()], [0, VERSION]);
});

test('--help lists flags, weights, privacy line and repo URL', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  for (const s of ['--json', '--fix', '--yes', '--show', '--share', '--badge', '--no-color', '--fail-on', 'Exit codes:', 'high check costs 25',
    'medium check', 'costs 10', 'Nothing is sent by default. If you turn sharing on, only the grade and pass/fail per check are sent.',
    'https://github.com/globalmpc/agent-leakcheck']) {
    assert.ok(r.stdout.includes(s), s);
  }
});

test('--json parses, has grade A and the documented shape', async () => {
  const r = await run(['--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(Object.keys(j)[0], 'schemaVersion');
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.tool, 'agent-leakcheck');
  assert.equal(j.version, VERSION);
  assert.equal(j.grade, 'A');
  assert.equal(j.score, 100);
  assert.ok(Array.isArray(j.agents));
  assert.ok(Array.isArray(j.checks));
});

test('unknown flag exits 2', async () => {
  const r = await run(['--nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--nope/);
});

test('--badge prints a markdown badge', async () => {
  const r = await run(['--badge']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(),
    '[![agent-leakcheck: A](https://img.shields.io/badge/agent--leakcheck-A-brightgreen)](https://github.com/globalmpc/agent-leakcheck)');
});

test('--show prints the payload and sends nothing', async () => {
  const s = await counter();
  const r = await run(['--show'], { AGENT_LEAKCHECK_ENDPOINT: s.url });
  s.server.close();
  assert.equal(r.code, 0);
  assert.equal(s.hits, 0);
  const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.deepEqual(Object.keys(payload), ['v', 'os', 'grade', 'agents', 'checks', 'via']);
  assert.equal(payload.via, 'flag');
});

test('non-TTY run never prompts and sends nothing', async () => {
  const s = await counter();
  const r = await run([], { AGENT_LEAKCHECK_ENDPOINT: s.url });
  s.server.close();
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('Share anonymous results?'));
  assert.match(r.stdout, /grade A/);
  assert.ok(r.stdout.startsWith('agent-leakcheck: grade'), 'piped output has no brand banner');
  assert.ok(!r.stdout.includes('globalmpc.tech'));
  assert.equal(s.hits, 0);
});

test('--share sends once and prints the thanks line; failures exit 0', async () => {
  const s = await counter();
  const ok = await run(['--share'], { AGENT_LEAKCHECK_ENDPOINT: s.url });
  s.server.close();
  assert.equal(s.hits, 1);
  assert.equal(JSON.parse(s.body).via, 'flag');
  assert.ok(ok.stdout.includes(`Thanks. Your setup is better than 50% of 7 shared scans. Stats: ${s.url}/`));
  const bad = await run(['--share']);
  assert.equal(bad.code, 0);
  assert.match(bad.stdout, /Could not share \(network error\)\. Nothing else was sent\./);
});

test('--fix with nothing to fix', async () => {
  const r = await run(['--fix']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Nothing to fix automatically\./);
});

test('--fix --yes on a JSONC settings file changes nothing and prints no contents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-skip-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    // JSONC-style file: the scan reads it, the strict-JSON autofix refuses it.
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ // note\n"permissions":{"defaultMode":"bypassPermissions","x":"lc_secret_zz"}}');
    const r = await run(['--fix', '--yes'], { AGENT_LEAKCHECK_HOME: home, AGENT_LEAKCHECK_CWD: home });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /lc_secret_zz/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function failingHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-failon-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  return home;
}

test('--fail-on exits 2 when a check at or above the threshold fails', async () => {
  const home = failingHome();
  try {
    const env = { AGENT_LEAKCHECK_HOME: home, AGENT_LEAKCHECK_CWD: home };
    assert.equal((await run(['--fail-on', 'high'], env)).code, 2);
    assert.equal((await run(['--fail-on', 'medium'], env)).code, 2);
    assert.equal((await run([], env)).code, 0);
    const j = await run(['--json', '--fail-on', 'high'], env);
    assert.equal(j.code, 2);
    assert.equal(JSON.parse(j.stdout).schemaVersion, 1);
    assert.equal((await run(['--badge', '--fail-on', 'high'], env)).code, 2);
    assert.equal((await run(['--show', '--fail-on', 'high'], env)).code, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--fail-on on a clean machine exits 0', async () => {
  assert.equal((await run(['--fail-on', 'high'])).code, 0);
});

test('--fail-on with a bad value is a usage error and does not scan', async () => {
  const r = await run(['--fail-on', 'low']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /agent-leakcheck: --fail-on must be high or medium/);
  assert.match(r.stderr, /Run with --help for usage\./);
  assert.equal(r.stdout, '');
});
