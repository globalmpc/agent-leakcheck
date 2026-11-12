import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import check from '../../src/checks/ssh.js';

async function run(files, { platform = 'linux', envNames = [], count = 0, uid } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  try {
    if (files) {
      const dir = path.join(home, '.ssh');
      fs.mkdirSync(dir);
      for (const [name, mode] of Object.entries(files)) {
        const p = path.join(dir, name);
        if (mode === 'dir') fs.mkdirSync(p);
        else {
          fs.writeFileSync(p, 'PLANTED-KEY-CONTENT');
          fs.chmodSync(p, mode);
        }
      }
    }
    const ctx = {
      home,
      cwd: home,
      platform,
      uid: uid === undefined ? process.getuid() : uid,
      envNames,
      read,
      exec: { sshAgentKeyCount: async () => count },
      agents: [],
    };
    return await check.run(ctx);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('fail lists loose keys; excluded files and dirs are ignored', async () => {
  const rows = await run({
    mykey: 0o644,
    'mykey.pub': 0o644,
    id_ed25519: 0o640,
    'server.pem': 0o600,
    config: 0o644,
    known_hosts: 0o644,
    authorized_keys: 0o644,
    agent: 'dir',
    notes: 0o644,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].message, 'SSH private keys readable by others: id_ed25519, mykey');
  assert.equal(rows[0].fix, 'chmod 600 ~/.ssh/id_ed25519 ~/.ssh/mykey');
  assert.ok(!JSON.stringify(rows).includes('PLANTED'));
});

test('pass when all keys are private (700 and 400 ok)', async () => {
  const rows = await run({ a: 0o600, 'a.pub': 0o644, id_rsa: 0o400, 'x.key': 0o700 });
  assert.deepEqual(rows.map((r) => r.status), ['pass']);
  assert.match(rows[0].message, /^3 SSH private keys/);
});

test('skip with no ~/.ssh, no candidates, and on win32', async () => {
  assert.deepEqual((await run(null)).map((r) => r.status), ['skip']);
  assert.deepEqual((await run({ config: 0o644, 'a.pub': 0o644 })).map((r) => r.status), ['skip']);
  const w = await run({ id_rsa: 0o644 }, { platform: 'win32' });
  assert.deepEqual(w.map((r) => r.status), ['skip']);
});

test('key owned by another user gives info, not fail', async () => {
  const rows = await run({ id_rsa: 0o644 }, { uid: process.getuid() + 1 });
  assert.deepEqual(rows.map((r) => r.status), ['info']);
  const own = await run({ id_rsa: 0o644 }, { uid: null });
  assert.equal(own[0].status, 'fail');
});

test('ssh-agent info row only with SSH_AUTH_SOCK and keys > 0', async () => {
  const files = { id_rsa: 0o600 };
  assert.deepEqual((await run(files, { count: 2 })).map((r) => r.status), ['pass']);
  assert.deepEqual((await run(files, { count: 0, envNames: ['SSH_AUTH_SOCK'] })).map((r) => r.status), ['pass']);
  const rows = await run(files, { count: 2, envNames: ['SSH_AUTH_SOCK'] });
  assert.equal(rows[1].status, 'info');
  assert.equal(
    rows[1].message,
    'ssh-agent holds 2 keys; any agent that can run shell commands can use them (it cannot read them)',
  );
});
