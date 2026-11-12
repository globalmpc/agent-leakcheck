import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import { detectAgents } from '../../src/detect.js';
import { planFixes, applyFixes } from '../../src/fix.js';
import check from '../../src/checks/risky-mode.js';

const PLANTED = 'lc_planted_token_9f8e7d6c5b4a';

async function setup(files = {}, { envNames = [], version = null, sys = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, 'sys'));
  const put = (base, rel, text) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text));
  };
  for (const [rel, text] of Object.entries(files)) put(home, rel, text);
  for (const [rel, text] of Object.entries(sys)) put(path.join(root, 'sys'), rel, text);
  const ctx = {
    home, cwd, platform: 'linux', envNames, read, systemRoot: path.join(root, 'sys'),
    exec: { binaryVersion: async (n) => (n === 'claude' ? version : null) },
  };
  ctx.agents = await detectAgents(ctx);
  return { ctx, home, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const rowFor = (rows, agent) => rows.filter((r) => r.agent === agent);
const statuses = (rows, agent) => rowFor(rows, agent).map((r) => r.status);
const bak = (dir) => fs.readdirSync(dir).filter((f) => f.includes('leakcheck-bak')).length;

test('metadata and empty machine', async () => {
  assert.equal(check.id, 'risky-mode');
  assert.equal(check.severity, 'high');
  assert.match(check.docs[0], /#risky-mode$/);
  const s = await setup();
  try {
    assert.deepEqual((await check.run(s.ctx)).map((r) => r.status), ['skip']);
  } finally { s.done(); }
});

test('claude-code: pass, user bypass fails with autofix, auto is info', async () => {
  let s = await setup({ '.claude/settings.json': { permissions: { defaultMode: 'default' } } });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'claude-code'), ['pass']); } finally { s.done(); }
  s = await setup({ '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'claude-code');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, 'cc-risky-mode');
  } finally { s.done(); }
  s = await setup({ '.claude/settings.json': { permissions: { defaultMode: 'auto' }, skipDangerousModePermissionPrompt: true } });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'claude-code'), ['info', 'info', 'pass']); } finally { s.done(); }
});

test('claude-code: managed bypass fails without autofix on managed, user autofix withheld', async () => {
  const s = await setup(
    { '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } },
    { sys: { 'etc/claude-code/managed-settings.json': { permissions: { defaultMode: 'bypassPermissions' } } } },
  );
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code').filter((r) => r.status === 'fail');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.autoFix));
  } finally { s.done(); }
});

test('claude-code: project bypass is info on new versions, fail on old or unknown', async () => {
  const files = { '.claude/settings.json': {}, 'proj/.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } };
  let s = await setup(files, { version: '2.1.300' });
  try {
    const rows = await check.run(s.ctx);
    assert.deepEqual(statuses(rows, 'claude-code'), ['info', 'pass']);
  } finally { s.done(); }
  for (const version of ['2.1.200', null]) {
    s = await setup(files, { version });
    try {
      const rows = rowFor(await check.run(s.ctx), 'claude-code');
      assert.equal(rows[0].status, 'fail');
      assert.equal(rows[0].autoFix, undefined);
    } finally { s.done(); }
  }
});

test('claude-code: malformed settings skip without crashing', async () => {
  const s = await setup({ '.claude/settings.json': '{ nope' });
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.equal(rows[0].status, 'skip');
    assert.match(rows[0].message, /~\/\.claude\/settings\.json/);
  } finally { s.done(); }
});

test('claude-code: cc-risky-mode applied twice changes once', async () => {
  const s = await setup({ '.claude/settings.json': { model: 'x', permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(ls)'] } } });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    assert.deepEqual(plan.map((p) => p.id), ['cc-risky-mode']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 1);
    const dir = path.join(s.home, '.claude');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(j.permissions.defaultMode, 'default');
    assert.deepEqual(j.permissions.allow, ['Bash(ls)']);
    assert.equal(j.model, 'x');
    assert.equal(applyFixes(plan, s.ctx).changed.length, 0);
    assert.equal(bak(dir), 1);
    assert.equal(planFixes(result, s.ctx).length, 0);
  } finally { s.done(); }
});

test('codex: skip without config, pass, fail via sandbox_mode or default_permissions, info for never', async () => {
  let s = await setup({ '.codex/other': '' });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'codex'), ['skip']); } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'sandbox_mode = "workspace-write"\n' });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'codex'), ['pass']); } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'codex');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, 'codex-risky-mode');
    assert.match(r.message, /approval_policy never/);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'default_permissions = ":danger-full-access"\n' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'codex');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, undefined);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'approval_policy = "never"\n' });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'codex'), ['pass', 'info']); } finally { s.done(); }
});

test('codex: active profile is honoured, no autofix for profile settings; bad toml skips', async () => {
  let s = await setup({ '.codex/config.toml': 'profile = "p"\nsandbox_mode = "danger-full-access"\n[profiles.p]\nsandbox_mode = "read-only"\n' });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'codex'), ['pass']); } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'profile = "p"\n[profiles.p]\nsandbox_mode = "danger-full-access"\n' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'codex');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, undefined);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'bad = = [[' }, { envNames: ['CODEX_HOME'] });
  try {
    const rows = rowFor(await check.run(s.ctx), 'codex');
    assert.deepEqual(rows.map((r) => r.status), ['skip', 'info']);
    assert.equal(rows[1].message, 'CODEX_HOME is set; only the default config location was checked.');
  } finally { s.done(); }
});

test('codex: codex-risky-mode applied twice changes once', async () => {
  const s = await setup({ '.codex/config.toml': 'model = "m"\nsandbox_mode = "danger-full-access"\n[projects.x]\ntrust = "trusted"\n' });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    assert.deepEqual(plan.map((p) => p.id), ['codex-risky-mode']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 1);
    const dir = path.join(s.home, '.codex');
    const text = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    assert.match(text, /sandbox_mode = "workspace-write"/);
    assert.match(text, /\[projects\.x\]/);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 0);
    assert.equal(bak(dir), 1);
    assert.deepEqual(statuses(await check.run(s.ctx), 'codex'), ['pass']);
  } finally { s.done(); }
});

test('cursor: CLI pass, unrestricted fails, bad json skips, IDE info', async () => {
  let s = await setup({ '.cursor/cli-config.json': { version: 1 } });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'cursor'), ['pass', 'info']); } finally { s.done(); }
  s = await setup({ '.cursor/cli-config.json': { approvalMode: 'unrestricted', note: PLANTED } });
  try {
    const rows = await check.run(s.ctx);
    const [r] = rowFor(rows, 'cursor');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, 'cursor-risky-mode');
    assert.ok(!JSON.stringify(rows).includes(PLANTED));
  } finally { s.done(); }
  s = await setup({ '.cursor/cli-config.json': '{ bad' });
  try { assert.deepEqual(statuses(await check.run(s.ctx), 'cursor'), ['skip', 'info']); } finally { s.done(); }
  s = await setup({ '.cursor/mcp.json': '{}' });
  try {
    const rows = rowFor(await check.run(s.ctx), 'cursor');
    assert.deepEqual(rows.map((r) => r.status), ['info']);
    assert.match(rows[0].message, /IDE auto-run/);
  } finally { s.done(); }
});

test('cursor: cursor-risky-mode applied twice changes once', async () => {
  const s = await setup({ '.cursor/cli-config.json': { version: 1, approvalMode: 'unrestricted', permissions: { allow: ['Shell(ls)'] } } });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    assert.deepEqual(plan.map((p) => p.id), ['cursor-risky-mode']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 1);
    const dir = path.join(s.home, '.cursor');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'cli-config.json'), 'utf8'));
    assert.equal(j.approvalMode, 'allowlist');
    assert.deepEqual(j.permissions.allow, ['Shell(ls)']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 0);
    assert.equal(bak(dir), 1);
  } finally { s.done(); }
});

test('gemini: pass, auto_edit info, yolo info, unparseable skips; project overrides user', async () => {
  const cases = [
    [{ '.gemini/settings.json': '{}' }, ['pass']],
    [{ '.gemini/settings.json': { general: { defaultApprovalMode: 'auto_edit' } } }, ['info']],
    [{ '.gemini/settings.json': { general: { defaultApprovalMode: 'yolo' } } }, ['info']],
    [{ '.gemini/settings.json': { general: { defaultApprovalMode: 'yolo' } }, 'proj/.gemini/settings.json': { general: { defaultApprovalMode: 'default' } } }, ['pass']],
    [{ '.gemini/settings.json': '{ bad' }, ['skip']],
    [{ '.gemini/settings.json': '{ bad', 'proj/.gemini/settings.json': { tools: { allowed: ['run_shell_command'] } } }, ['fail', 'skip']],
  ];
  for (const [files, want] of cases) {
    const s = await setup(files);
    try { assert.deepEqual(statuses(await check.run(s.ctx), 'gemini'), want); } finally { s.done(); }
  }
});

test('claude-code: user bypass is info (no autofix) when disableBypassPermissionsMode is disable', async () => {
  const s = await setup({
    '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions', disableBypassPermissionsMode: 'disable' } },
  });
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.ok(rows.every((r) => r.status !== 'fail' && !r.autoFix));
    assert.ok(rows.some((r) => r.status === 'info' && /disableBypassPermissionsMode/.test(r.message)));
  } finally { s.done(); }
});

test('claude-code: user bypass is info when managed settings set another defaultMode', async () => {
  const s = await setup(
    { '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } },
    { sys: { 'etc/claude-code/managed-settings.json': { permissions: { defaultMode: 'default' } } } },
  );
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.ok(rows.every((r) => r.status !== 'fail' && !r.autoFix));
    assert.ok(rows.some((r) => r.status === 'info' && /managed/.test(r.message)));
  } finally { s.done(); }
});

test('claude-code: cwd == home reports the user file once', async () => {
  const s = await setup({ '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } } }, { version: '2.1.300' });
  try {
    s.ctx.cwd = s.home;
    s.ctx.agents = await detectAgents(s.ctx);
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.deepEqual(rows.map((r) => r.status), ['fail']);
    assert.equal(rows[0].autoFix, 'cc-risky-mode');
  } finally { s.done(); }
});

test('codex: default_permissions danger cause suggests :workspace, not sandbox_mode, and no autofix', async () => {
  const s = await setup({ '.codex/config.toml': 'default_permissions = ":danger-full-access"\n' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'codex');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, undefined);
    assert.match(r.fix, /default_permissions to ":workspace"/);
    assert.match(r.fix, /do not add sandbox_mode/);
  } finally { s.done(); }
});

test('codex autofix: quoted sandbox_mode key is replaced, not duplicated', async () => {
  const s = await setup({ '.codex/config.toml': '"sandbox_mode" = "danger-full-access"\n' });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    applyFixes(plan, s.ctx, { now: new Date() });
    assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), 'sandbox_mode = "workspace-write"\n');
  } finally { s.done(); }
});

test('claude-code: bare Bash allow fails in every scope, scoped Bash does not', async () => {
  const bare = (e) => ({ permissions: { allow: [e], note: PLANTED } });
  for (const e of ['Bash', ' Bash(*) ']) {
    const s = await setup({ '.claude/settings.json': bare(e) });
    try {
      const rows = await check.run(s.ctx);
      const [r] = rowFor(rows, 'claude-code');
      assert.equal(r.status, 'fail');
      assert.equal(r.autoFix, undefined);
      assert.match(r.message, /~\/\.claude\/settings\.json/);
      assert.match(r.message, /every Bash command runs without a prompt/);
      assert.ok(!JSON.stringify(rows).includes(PLANTED));
    } finally { s.done(); }
  }
  const s = await setup(
    { '.claude/settings.json': {}, 'proj/.claude/settings.json': bare('Bash'), 'proj/.claude/settings.local.json': bare('Bash') },
    { sys: { 'etc/claude-code/managed-settings.json': bare('Bash') } },
  );
  try {
    const fails = rowFor(await check.run(s.ctx), 'claude-code').filter((r) => r.status === 'fail');
    assert.equal(fails.length, 3);
  } finally { s.done(); }
  const ok = await setup({ '.claude/settings.json': { permissions: { allow: ['Bash(npm test)', 'Read'] } } });
  try { assert.deepEqual(statuses(await check.run(ok.ctx), 'claude-code'), ['pass']); } finally { ok.done(); }
  const odd = await setup({ '.claude/settings.json': { permissions: { allow: 'Bash' } } });
  try { assert.deepEqual(statuses(await check.run(odd.ctx), 'claude-code'), ['pass']); } finally { odd.done(); }
});

test('gemini: bare run_shell_command and permanent approval fail per scope', async () => {
  const cfg = (extra) => ({ ...extra, note: PLANTED });
  const cases = [
    ['.gemini/settings.json', cfg({ tools: { allowed: ['run_shell_command'] } })],
    ['proj/.gemini/settings.json', cfg({ tools: { allowed: [' run_shell_command '] } })],
    ['.gemini/settings.json', cfg({ security: { enablePermanentToolApproval: true } })],
  ];
  for (const [file, data] of cases) {
    const s = await setup({ '.gemini/keep': '', [file]: data });
    try {
      const rows = await check.run(s.ctx);
      assert.deepEqual(statuses(rows, 'gemini'), ['fail']);
      assert.ok(!JSON.stringify(rows).includes(PLANTED));
    } finally { s.done(); }
  }
  const sys = await setup({ '.gemini/keep': '' }, { sys: { 'etc/gemini-cli/settings.json': { tools: { allowed: ['run_shell_command'] } } } });
  try { assert.deepEqual(statuses(await check.run(sys.ctx), 'gemini'), ['fail']); } finally { sys.done(); }
  const both = await setup({ '.gemini/settings.json': { general: { defaultApprovalMode: 'auto_edit' }, tools: { allowed: ['run_shell_command'] } } });
  try { assert.deepEqual(statuses(await check.run(both.ctx), 'gemini').sort(), ['fail', 'info']); } finally { both.done(); }
  const ok = await setup({ '.gemini/settings.json': { tools: { allowed: ['run_shell_command(git)', 'run_shell_command(npm test)'] }, security: { enablePermanentToolApproval: false } } });
  try { assert.deepEqual(statuses(await check.run(ok.ctx), 'gemini'), ['pass']); } finally { ok.done(); }
  const bad = await setup({ '.gemini/settings.json': '{ "tools": { "allowed": [' });
  try {
    const rows = rowFor(await check.run(bad.ctx), 'gemini');
    assert.deepEqual(rows.map((r) => r.status), ['skip']);
    assert.match(rows[0].message, /^Could not parse ~\/\.gemini\/settings\.json/);
  } finally { bad.done(); }
});

test('claude-code: an unparseable settings file skips and never yields pass', async () => {
  const s = await setup({ '.claude/settings.json': '{"permissions": {"deny": [],}' });
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.deepEqual(rows.map((r) => r.status), ['skip']);
    assert.match(rows[0].message, /^Could not parse ~\/\.claude\/settings\.json/);
  } finally { s.done(); }
  const both = await setup({
    '.claude/settings.json': { permissions: { defaultMode: 'bypassPermissions' } },
    'proj/.claude/settings.local.json': '{ bad',
  });
  try { assert.deepEqual(statuses(await check.run(both.ctx), 'claude-code').sort(), ['fail', 'skip']); } finally { both.done(); }
});
