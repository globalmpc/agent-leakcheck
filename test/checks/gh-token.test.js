import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import check from '../../src/checks/gh-token.js';

function run(yml, { platform = 'linux', envNames = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  try {
    if (yml !== null) {
      const rel = platform === 'win32' ? ['AppData', 'Roaming', 'GitHub CLI'] : ['.config', 'gh'];
      fs.mkdirSync(path.join(home, ...rel), { recursive: true });
      fs.writeFileSync(path.join(home, ...rel, 'hosts.yml'), yml);
    }
    return check.run({ home, cwd: home, platform, uid: 1, envNames, read, exec: {}, agents: [] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('fail per host with a token, direct or under users', () => {
  const rows = run(
    'github.com:\n    git_protocol: https\n    oauth_token: gho_PLANTEDVALUE\n    user: PLANTEDUSER\nghe.example.com:\n    users:\n        PLANTEDUSER:\n            oauth_token: gho_OTHER\nclean.test:\n    user: x\n',
  );
  const fails = rows.filter((r) => r.status === 'fail');
  assert.equal(fails.length, 2);
  assert.equal(fails[0].message, 'gh stores a token for github.com in ~/.config/gh/hosts.yml instead of the system keyring');
  assert.match(fails[0].fix, /gh auth logout --hostname github\.com.*gh auth login/);
  assert.ok(!JSON.stringify(rows).includes('PLANTED'));
  assert.ok(!JSON.stringify(rows).includes('gho_'));
  assert.ok(!rows.some((r) => /clean\.test/.test(r.message)));
});

test('pass when hosts have no token (empty value counts as none)', () => {
  const rows = run('github.com:\n    git_protocol: https\n    oauth_token: ""\n    users:\n        a:\n    user: a\n');
  assert.deepEqual(rows.map((r) => r.status), ['pass']);
});

test('skip when missing or no hosts', () => {
  assert.deepEqual(run(null).map((r) => r.status), ['skip']);
  assert.deepEqual(run('# nothing\n').map((r) => r.status), ['skip']);
  assert.deepEqual(run('\x00garbage ::: {\n').map((r) => r.status), ['skip']);
});

test('windows path and custom location info rows', () => {
  const rows = run('github.com:\n    oauth_token: x1\n', { platform: 'win32' });
  assert.equal(rows[0].status, 'fail');
  const r2 = run('github.com:\n    user: a\n', { envNames: ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME'] });
  assert.deepEqual(r2.map((r) => r.status), ['info', 'info', 'pass']);
  assert.match(r2[0].message, /GH_CONFIG_DIR is set; only the default gh config location was checked/);
});
