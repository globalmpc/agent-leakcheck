import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import check from '../../src/checks/mcp-autoapprove.js';
import { checkStatus } from '../../src/scan.js';

const SECRET = 'lc_planted_setting_7a6b5c4d';

// files: { relPath: object | string }; cwd is `proj` unless sameHome.
function run(files = {}, { agent = true, custom = null, sameHome = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    }
    const cwd = sameHome ? home : path.join(home, 'proj');
    const dir = path.join(home, '.claude');
    const cc = {
      id: 'claude-code',
      customConfigDir: custom,
      paths: {
        dir,
        userSettings: path.join(dir, 'settings.json'),
        projectSettings: path.join(cwd, '.claude', 'settings.json'),
        localSettings: path.join(cwd, '.claude', 'settings.local.json'),
      },
    };
    const ctx = { home, cwd, platform: 'linux', envNames: [], read, exec: {}, agents: agent ? [cc] : [] };
    const rows = check.run(ctx);
    assert.ok(!JSON.stringify(rows).includes(SECRET));
    return rows;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const on = { enableAllProjectMcpServers: true, env: { API_KEY: SECRET } };

test('fail naming the user file; fix mentions false and enabledMcpjsonServers', () => {
  const rows = run({ '.claude/settings.json': on });
  assert.equal(rows[0].status, 'fail');
  assert.match(rows[0].message, /^~\/\.claude\/settings\.json sets enableAllProjectMcpServers/);
  assert.match(rows[0].fix, /false.*~\/\.claude\/settings\.json.*enabledMcpjsonServers/);
  assert.ok(!rows[0].autoFix);
});

test('fail from local settings', () => {
  const rows = run({ 'proj/.claude/settings.local.json': on });
  assert.equal(rows[0].status, 'fail');
  assert.match(rows[0].message, /proj\/\.claude\/settings\.local\.json/);
});

test('project settings only gives info, never fail', () => {
  const rows = run({ 'proj/.claude/settings.json': on });
  assert.equal(rows[0].status, 'info');
  assert.match(rows[0].message, /only user and local settings are graded/);
  assert.equal(checkStatus(rows), 'pass');
});

test('pass when false, unset or no file at all', () => {
  assert.equal(run({ '.claude/settings.json': { enableAllProjectMcpServers: false } })[0].status, 'pass');
  assert.equal(run({ '.claude/settings.json': { model: 'x' } })[0].status, 'pass');
  assert.equal(run()[0].status, 'pass');
  assert.equal(run({ '.claude/settings.json': { enableAllProjectMcpServers: 'true' } })[0].status, 'pass');
});

test('JSONC settings are accepted', () => {
  const rows = run({ '.claude/settings.json': '{ // c\n "enableAllProjectMcpServers": true, }' });
  assert.equal(rows[0].status, 'fail');
});

test('malformed JSON gives a skip row, no pass, no leak', () => {
  const rows = run({ '.claude/settings.json': `{ "enableAllProjectMcpServers": true, "k": "${SECRET}` });
  assert.deepEqual(rows.map((r) => r.status), ['skip']);
  assert.match(rows[0].message, /^Could not parse ~\/\.claude\/settings\.json/);
});

test('a bad user file still lets a failing local file fail', () => {
  const rows = run({ '.claude/settings.json': '{', 'proj/.claude/settings.local.json': on });
  assert.deepEqual(rows.map((r) => r.status).sort(), ['fail', 'skip']);
});

test('no claude-code agent: no rows (check status skip)', () => {
  const rows = run({ '.claude/settings.json': on }, { agent: false });
  assert.deepEqual(rows, []);
  assert.equal(checkStatus(rows), 'skip');
});

test('cwd == home counts the user file once', () => {
  const rows = run({ '.claude/settings.json': on }, { sameHome: true });
  assert.equal(rows.filter((r) => r.status === 'fail').length, 1);
  assert.equal(rows.filter((r) => r.status === 'info').length, 0);
});

test('CLAUDE_CONFIG_DIR adds an info row', () => {
  const rows = run({}, { custom: 'CLAUDE_CONFIG_DIR' });
  const info = rows.find((r) => r.status === 'info');
  assert.match(info.message, /^CLAUDE_CONFIG_DIR is set; only the default config location was checked/);
});
