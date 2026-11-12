import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import check from '../../src/checks/cred-perms.js';

const SECRET = 'lc_planted_cred_5d4c3b2a1f';

// files: { relPath: mode }; agents: ids to report as detected.
function run({ files = {}, agents = ['claude-code', 'codex'], platform = 'linux', custom = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  try {
    for (const [rel, mode] of Object.entries(files)) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, SECRET);
      fs.chmodSync(p, mode);
    }
    const all = {
      'claude-code': { id: 'claude-code', customConfigDir: custom['claude-code'] ?? null, paths: { dir: path.join(home, '.claude') } },
      codex: { id: 'codex', customConfigDir: custom.codex ?? null, paths: { dir: path.join(home, '.codex') } },
    };
    const ctx = { home, cwd: home, platform, envNames: [], read, exec: {}, agents: agents.map((a) => all[a]) };
    const rows = check.run(ctx);
    assert.ok(!JSON.stringify(rows).includes(SECRET));
    return rows;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const of = (rows, id) => rows.filter((r) => r.agent === id);

test('fail when group or others can read; fix is chmod 600', () => {
  const rows = run({
    files: { '.claude/.credentials.json': 0o640, '.codex/auth.json': 0o604, '.git-credentials': 0o644 },
  });
  const cc = of(rows, 'claude-code')[0];
  assert.equal(cc.status, 'fail');
  assert.equal(cc.message, '~/.claude/.credentials.json is readable by other users (mode 640).');
  assert.equal(cc.fix, 'chmod 600 ~/.claude/.credentials.json');
  assert.equal(of(rows, 'codex')[0].fix, 'chmod 600 ~/.codex/auth.json');
  assert.equal(of(rows, 'system')[0].fix, 'chmod 600 ~/.git-credentials');
  assert.ok(rows.every((r) => !r.autoFix));
});

test('pass when private (600 and 400)', () => {
  const rows = run({ files: { '.claude/.credentials.json': 0o600, '.codex/auth.json': 0o400, '.git-credentials': 0o600 } });
  assert.deepEqual(rows.map((r) => r.status), ['pass', 'pass', 'pass']);
});

test('skip when a file is absent; claude-code message mentions the Keychain', () => {
  const rows = run();
  assert.deepEqual(rows.map((r) => r.status), ['skip', 'skip', 'skip']);
  assert.match(of(rows, 'claude-code')[0].message, /Keychain/);
});

test('agents that are not detected get no row; system always does', () => {
  const rows = run({ agents: [], files: { '.codex/auth.json': 0o644 } });
  assert.deepEqual(rows.map((r) => r.agent), ['system']);
});

test('a directory in place of the file is skipped', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  try {
    fs.mkdirSync(path.join(home, '.git-credentials'), { mode: 0o755 });
    const rows = check.run({ home, cwd: home, platform: 'linux', envNames: [], read, exec: {}, agents: [] });
    assert.equal(rows[0].status, 'skip');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('win32: one skip row per agent, modes not checked', () => {
  const rows = run({ platform: 'win32', files: { '.claude/.credentials.json': 0o644, '.git-credentials': 0o644 } });
  assert.deepEqual(rows.map((r) => [r.agent, r.status]), [['claude-code', 'skip'], ['codex', 'skip'], ['system', 'skip']]);
  assert.match(rows[0].message, /Windows/);
});

test('custom config dir adds an info row', () => {
  const rows = run({ custom: { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } });
  const info = rows.filter((r) => r.status === 'info');
  assert.deepEqual(info.map((r) => r.agent), ['claude-code', 'codex']);
  assert.match(info[0].message, /^CLAUDE_CONFIG_DIR is set; only the default location was checked/);
});

test('the check never opens file contents', () => {
  const orig = read.readText;
  assert.equal(typeof orig, 'function');
  assert.throws(() => read.readText(path.join(os.tmpdir(), '.claude', '.credentials.json')), { name: 'SecretPathError' });
});
