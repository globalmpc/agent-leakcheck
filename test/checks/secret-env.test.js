import { test } from 'node:test';
import assert from 'node:assert/strict';
import check from '../../src/checks/secret-env.js';

const ctxOf = (envNames, agents = []) => ({
  home: '/home/u',
  cwd: '/home/u',
  platform: 'linux',
  uid: 1,
  envNames,
  read: {},
  exec: {},
  agents,
});

test('matches secret-looking names, ignores known non-secrets', () => {
  const names = ['PATH', 'PATHEXT', 'KEYTIMEOUT', 'GIT_CONFIG_KEY_0', 'SSH_AUTH_SOCK', 'TLS_KEY_FILE', 'HOME',
    'GITHUB_PAT', 'NPM_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'MY_APIKEY', 'DB_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const rows = check.run(ctxOf(names));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'fail');
  assert.equal(rows[0].agent, 'system');
  assert.match(rows[0].message, /^7 environment variables look like secrets;/);
  assert.ok(rows[0].message.includes('NPM_TOKEN'));
  assert.ok(!rows[0].message.includes('KEYTIMEOUT'));
  assert.ok(!rows[0].message.includes('GIT_CONFIG_KEY_0'));
});

test('lists at most 10 names, then +N more', () => {
  const names = Array.from({ length: 13 }, (_, i) => `SVC${i}_TOKEN`);
  const m = check.run(ctxOf(names))[0].message;
  assert.match(m, /13 environment variables/);
  assert.ok(m.includes('SVC9_TOKEN') && !m.includes('SVC10_TOKEN'));
  assert.ok(m.includes('+3 more'));
});

test('pass when none', () => {
  const rows = check.run(ctxOf(['PATH', 'HOME', 'SHELL']));
  assert.deepEqual(rows.map((r) => r.status), ['pass']);
});

test('codex adds an info row with shell_environment_policy', () => {
  const rows = check.run(ctxOf(['A_TOKEN'], [{ id: 'codex', paths: { config: '/home/u/.codex/config.toml' } }]));
  assert.deepEqual(rows.map((r) => r.status), ['fail', 'info']);
  assert.equal(rows[1].agent, 'codex');
  assert.match(rows[1].fix, /~\/\.codex\/config\.toml.*\[shell_environment_policy\].*ignore_default_excludes = false/);
});

test('harness-injected names are ignored by exact name only', () => {
  const rows = check.run(ctxOf(['CLAUDE_CODE_MESSAGING_TOKEN', 'ORCA_AGENT_LAUNCH_TOKEN', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_PANE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ORCA_OTHER_TOKEN']));
  assert.match(rows[0].message, /^2 environment variables look like secrets;/);
  assert.ok(rows[0].message.includes('CLAUDE_CODE_OAUTH_TOKEN') && rows[0].message.includes('ORCA_OTHER_TOKEN'));
  assert.ok(!rows[0].message.includes('MESSAGING'));
});
