import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { binaryVersion, sshAgentKeyCount } from '../src/exec.js';

afterEach(() => mock.restoreAll());

function fakeExec(err, stdout = '') {
  return mock.method(cp, 'execFile', (file, args, opts, cb) => cb(err, stdout, ''));
}
const exit = (code) => Object.assign(new Error('x'), { code });

test('binaryVersion rejects commands outside the allowlist without running anything', async () => {
  const m = fakeExec(null, '1.2.3');
  for (const cmd of ['rm', 'sh', 'claude; ls', '../claude', '', undefined]) {
    assert.equal(await binaryVersion(cmd), null);
  }
  assert.equal(m.mock.calls.length, 0);
});

test('binaryVersion returns the first semver-like token and passes --version', async () => {
  const m = fakeExec(null, 'claude 2.1.320-beta.1 (Claude Code)\n');
  assert.equal(await binaryVersion('claude'), '2.1.320-beta.1');
  assert.deepEqual(m.mock.calls[0].arguments.slice(0, 2), ['claude', ['--version']]);
  assert.equal(m.mock.calls[0].arguments[2].timeout, 5000);
});

test('binaryVersion is null on error or no match', async () => {
  fakeExec(exit('ENOENT'));
  assert.equal(await binaryVersion('codex'), null);
  mock.restoreAll();
  fakeExec(null, 'no version here');
  assert.equal(await binaryVersion('gemini'), null);
});

test('sshAgentKeyCount maps exit codes', async () => {
  fakeExec(null, '256 SHA256:aaa a (ED25519)\n3072 SHA256:bbb b (RSA)\n');
  assert.equal(await sshAgentKeyCount(), 2);
  mock.restoreAll();
  fakeExec(exit(1), 'The agent has no identities.\n');
  assert.equal(await sshAgentKeyCount(), 0);
  mock.restoreAll();
  fakeExec(exit(2));
  assert.equal(await sshAgentKeyCount(), null);
  mock.restoreAll();
  fakeExec(exit('ENOENT'));
  assert.equal(await sshAgentKeyCount(), null);
});

test('never throws even if execFile throws', async () => {
  mock.method(cp, 'execFile', () => { throw new Error('boom'); });
  assert.equal(await sshAgentKeyCount(), null);
  assert.equal(await binaryVersion('claude'), null);
});
