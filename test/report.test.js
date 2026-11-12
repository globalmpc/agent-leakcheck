import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHuman, formatJson } from '../src/report.js';
import { REPO_URL } from '../src/config.js';

const result = {
  tool: 'agent-leakcheck', version: '0.1.0', grade: 'C', score: 65,
  agents: [{ id: 'claude-code', version: '2.1.320' }],
  checks: [
    { id: 'env-deny', title: 'Agents can read .env files', severity: 'high', status: 'fail',
      results: [{ agent: 'claude-code', status: 'fail', message: 'no deny rule', fix: 'add Read(./.env*) to deny' }] },
    { id: 'ssh', title: 'SSH keys', severity: 'medium', status: 'fail',
      results: [{ agent: null, status: 'fail', message: 'loose key mode', fix: 'chmod 600' }, { agent: null, status: 'info', message: '2 keys in ssh-agent' }] },
    { id: 'secret-env', title: 'Secret-looking env vars', severity: 'warning', status: 'fail',
      results: [{ agent: null, status: 'fail', message: 'FOO_TOKEN is set' }] },
    { id: 'cc-version', title: 'Claude Code version', severity: 'high', status: 'pass', results: [{ agent: 'claude-code', status: 'pass', message: 'ok' }] },
    { id: 'gh-token', title: 'gh token', severity: 'medium', status: 'skip', results: [{ agent: null, status: 'skip', message: 'n/a' }] },
  ],
};

test('human report: grade, failures with fixes, notes, passed, skipped, footer', () => {
  const out = formatHuman(result, { color: false });
  assert.match(out.split('\n')[0], /grade C \(65\/100\)/);
  assert.match(out, /\[HIGH\] Agents can read \.env files/);
  assert.match(out, /Fix: add Read/);
  assert.match(out, /\[MEDIUM\] SSH keys/);
  assert.match(out, /\[WARNING\] Secret-looking env vars/);
  assert.match(out, /\[INFO\] SSH keys/);
  assert.match(out, /Passed: cc-version/);
  assert.match(out, /Skipped: 1 check\n/);
  assert.ok(out.endsWith(`agent-leakcheck 0.1.0 · ${REPO_URL}`));
  assert.ok(!out.includes('\x1b['));
  assert.ok(out.indexOf('[HIGH]') < out.indexOf('[WARNING]'));
});

test('warnings do not render as failures', () => {
  assert.ok(!/\[LOW\]|\[WARNING\].*Fix:/.test(formatHuman(result)));
});

test('color adds ANSI codes only when asked', () => {
  assert.ok(formatHuman(result, { color: true }).includes('\x1b['));
});

test('json output round-trips', () => {
  assert.deepEqual(JSON.parse(formatJson(result)), { schemaVersion: 1, ...result });
});

test('empty result still renders', () => {
  const out = formatHuman({ ...result, grade: 'A', score: 100, agents: [], checks: [] });
  assert.match(out, /grade A/);
  assert.match(out, /Passed: none/);
});

test('crashed checks and unparseable files are listed by id and message', () => {
  const r = {
    ...result,
    checks: [
      { id: 'ssh', title: 'SSH keys', severity: 'medium', status: 'skip', results: [{ agent: null, status: 'skip', message: 'check failed: TypeError' }] },
      { id: 'mcp-plaintext', title: 'MCP', severity: 'medium', status: 'skip', results: [{ agent: 'cursor', status: 'skip', message: 'could not parse ~/.cursor/mcp.json' }] },
      { id: 'gh-token', title: 'gh token', severity: 'medium', status: 'skip', results: [{ agent: null, status: 'skip', message: 'n/a' }] },
    ],
  };
  const out = formatHuman(r);
  assert.match(out, /\[SKIPPED\] ssh: check failed: TypeError/);
  assert.match(out, /\[SKIPPED\] mcp-plaintext: could not parse ~\/\.cursor\/mcp\.json/);
  assert.ok(!out.includes('gh-token:'));
  assert.match(out, /Skipped: 3 checks/);
});

test('"Could not parse" skips are listed regardless of case', () => {
  const r = {
    ...result,
    checks: [
      { id: 'env-deny', title: 'Agents can read .env files', severity: 'high', status: 'skip', results: [{ agent: 'claude-code', status: 'skip', message: 'Could not parse ~/.claude/settings.json, so .env rules were not checked.' }] },
    ],
  };
  assert.match(formatHuman(r), /\[SKIPPED\] env-deny: Could not parse ~\/\.claude\/settings\.json/);
});

test('control characters from config names never reach the terminal', () => {
  const evil = 'x\u001b[1A\u001b[2K\u001b[32mAll checks passed\u009b0m\u0007\r';
  const r = {
    ...result,
    agents: [{ id: 'claude-code', version: `2.1.320${evil}` }],
    checks: [
      { id: 'mcp-plaintext', title: 'Plaintext secrets in MCP configs', severity: 'medium', status: 'fail',
        results: [{ agent: 'claude-code', status: 'fail', message: `server '${evil}' has a plaintext value`, fix: `move ${evil}` }] },
      { id: 'ssh', title: 'SSH keys', severity: 'medium', status: 'skip', results: [{ agent: null, status: 'skip', message: `could not parse ${evil}` }] },
    ],
  };
  for (const color of [false, true]) {
    const out = formatHuman(r, { color });
    // Only the report's own SGR color codes may remain.
    const stripped = out.replace(/\x1b\[\d+m/g, '');
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(stripped), `control character leaked (color=${color})`);
    assert.match(out, /server 'x\?\[1A\?\[2K\?\[32mAll checks passed\?0m\?\?' has a plaintext value/);
  }
});

test('brand banner only when asked, above the grade line', () => {
  assert.ok(!formatHuman(result).includes('Global MPC'));
  const out = formatHuman(result, { banner: true });
  const lines = out.split('\n');
  assert.match(lines[0], /╔═╗╦  ╔═╗╔╗ ╔═╗╦    ╔╦╗╔═╗╔═╗/);
  assert.equal(lines[3], '  agent-leakcheck 0.1.0 · by Global MPC · globalmpc.tech');
  assert.match(lines[5], /^agent-leakcheck: grade C/);
  assert.equal(new Set(lines.slice(0, 3).map((l) => [...l].length)).size, 1, 'art lines have equal width');
});
