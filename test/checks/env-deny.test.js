import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import { detectAgents } from '../../src/detect.js';
import { planFixes, applyFixes } from '../../src/fix.js';
import check from '../../src/checks/env-deny.js';

const PLANTED = 'lc_planted_token_9f8e7d6c5b4a';

async function setup(files = {}, { cwdName = 'proj', envNames = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, cwdName);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, 'sys'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof text === 'string' ? text : JSON.stringify(text));
  }
  const ctx = {
    home, cwd, platform: 'linux', envNames, read, systemRoot: path.join(root, 'sys'),
    exec: { binaryVersion: async () => null },
  };
  ctx.agents = await detectAgents(ctx);
  return { ctx, home, cwd, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const rowFor = (rows, agent) => rows.filter((r) => r.agent === agent);
const dump = (rows) => JSON.stringify(rows);

test('metadata', () => {
  assert.equal(check.id, 'env-deny');
  assert.equal(check.severity, 'high');
  assert.equal(check.title, 'Agents can read .env files');
  assert.match(check.docs[0], /#env-deny$/);
});

test('nothing installed: one skip row', async () => {
  const s = await setup();
  try {
    const rows = await check.run(s.ctx);
    assert.deepEqual(rows.map((r) => r.status), ['skip']);
  } finally { s.done(); }
});

test('claude-code: fail without rules, with autofix id', async () => {
  const s = await setup({ '.claude/settings.json': { permissions: { deny: ['Read(~/.ssh/**)'] } } });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'claude-code');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, 'cc-env-deny');
    assert.match(r.fix, /Read\(\/\/\*\*\/\.env\)/);
  } finally { s.done(); }
});

test('claude-code: pass forms, weak user-level rule adds an info row', async () => {
  const strongUser = ['Read(//**/.env)', 'Read(~/**/.env*)'];
  for (const rule of strongUser) {
    const s = await setup({ '.claude/settings.json': { permissions: { deny: [rule] } } });
    try {
      const rows = rowFor(await check.run(s.ctx), 'claude-code');
      assert.deepEqual(rows.map((r) => r.status), ['pass'], rule);
    } finally { s.done(); }
  }
  for (const rule of ['Read(.env)', 'Read(./.env)', 'Read(**/.env)', 'Read(.env*)']) {
    const s = await setup({ '.claude/settings.json': { permissions: { deny: [rule] } } });
    try {
      const rows = rowFor(await check.run(s.ctx), 'claude-code');
      assert.deepEqual(rows.map((r) => r.status), ['pass', 'info'], rule);
      assert.match(rows[1].fix, /Read\(\/\/\*\*\/\.env\)/);
    } finally { s.done(); }
  }
});

test('claude-code: project and local rules count, .env.* alone and other rules do not', async () => {
  let s = await setup({ 'proj/.claude/settings.local.json': { permissions: { deny: ['Read(.env)'] } }, '.claude/settings.json': {} });
  try {
    assert.deepEqual(rowFor(await check.run(s.ctx), 'claude-code').map((r) => r.status), ['pass']);
  } finally { s.done(); }
  s = await setup({ '.claude/settings.json': { permissions: { deny: ['Read(.env.*)', 'Read(.env.local)', 'Edit(.env)', 'Bash(rm:*)'] } } });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'claude-code')[0].status, 'fail');
  } finally { s.done(); }
});

test('claude-code: JSONC settings are read; malformed settings skip instead of fail', async () => {
  let s = await setup({ '.claude/settings.json': '{\n // note\n "permissions": {"deny": ["Read(//**/.env)",],},\n}' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'claude-code')[0].status, 'pass');
  } finally { s.done(); }
  s = await setup({ '.claude/settings.json': '{ not json' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'claude-code');
    assert.equal(r.status, 'skip');
    assert.match(r.message, /~\/\.claude\/settings\.json/);
  } finally { s.done(); }
});

test('claude-code: cc-env-deny autofix adds both rules once, second run changes nothing', async () => {
  const s = await setup({ '.claude/settings.json': { model: 'x', permissions: { deny: ['Read(~/.ssh/**)'] } } });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    assert.deepEqual(plan.map((p) => p.id), ['cc-env-deny']);
    const out = applyFixes(plan, s.ctx);
    assert.equal(out.changed.length, 1);
    const file = path.join(s.home, '.claude', 'settings.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(j.permissions.deny, ['Read(~/.ssh/**)', 'Read(//**/.env)', 'Read(//**/.env.*)']);
    assert.equal(j.model, 'x');
    assert.equal(applyFixes(plan, s.ctx).changed.length, 0);
    assert.equal(planFixes(result, s.ctx).length, 0);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('leakcheck-bak')).length, 1);
    assert.equal(rowFor(await check.run(s.ctx), 'claude-code')[0].status, 'pass');
  } finally { s.done(); }
});

test('codex (beta, info only): missing deny, deny in the default profile, workspace_roots subtable', async () => {
  let s = await setup({ '.codex/config.toml': 'model = "x"\n' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'codex');
    assert.equal(r.status, 'info');
    assert.match(r.message, /no default permission profile.*not part of the grade/);
    assert.equal(r.autoFix, undefined);
    assert.match(r.fix, /default_permissions/);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'default_permissions = "safe"\n[permissions.safe.filesystem]\n"**/*.env" = "deny"\n' });
  try {
    assert.match(rowFor(await check.run(s.ctx), 'codex')[0].message, /has a deny entry for \.env files/);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'default_permissions = "safe"\n[permissions.safe.filesystem.":workspace_roots"]\n"**/.env" = "deny"\n' });
  try {
    assert.match(rowFor(await check.run(s.ctx), 'codex')[0].message, /has a deny entry for \.env files/);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'default_permissions = "other"\n[permissions.safe.filesystem]\n"**/*.env" = "deny"\n' });
  try {
    assert.match(rowFor(await check.run(s.ctx), 'codex')[0].message, /has no deny entry for \.env files/);
  } finally { s.done(); }
});

test('codex: unparseable config skips; customConfigDir adds an info row', async () => {
  const s = await setup({ '.codex/config.toml': 'this is = = bad [[' }, { envNames: ['CODEX_HOME'] });
  try {
    const rows = rowFor(await check.run(s.ctx), 'codex');
    assert.deepEqual(rows.map((r) => r.status), ['skip', 'info']);
    assert.equal(rows[1].message, 'CODEX_HOME is set; only the default config location was checked.');
  } finally { s.done(); }
});

test('cursor: fail with autofix when cli-config exists, text-only without it', async () => {
  let s = await setup({ '.cursor/cli-config.json': { permissions: { allow: [], deny: [] }, note: PLANTED } });
  try {
    const rows = await check.run(s.ctx);
    const [r] = rowFor(rows, 'cursor');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, 'cursor-env-deny');
    assert.match(r.fix, /\.cursorignore/);
    assert.ok(!dump(rows).includes(PLANTED));
  } finally { s.done(); }
  s = await setup({ '.cursor/mcp.json': '{}' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'cursor');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, undefined);
  } finally { s.done(); }
});

test('cursor: pass via CLI deny, project cli.json, or .cursorignore', async () => {
  const cases = [
    { '.cursor/cli-config.json': { permissions: { deny: ['Read(.env*)'] } } },
    { 'proj/.cursor/cli.json': { permissions: { deny: ['Read(**/.env*)'] } }, '.cursor/mcp.json': '{}' },
    { 'proj/.cursorignore': '# secrets\n.env\n', '.cursor/mcp.json': '{}' },
  ];
  for (const files of cases) {
    const s = await setup(files);
    try {
      assert.equal(rowFor(await check.run(s.ctx), 'cursor')[0].status, 'pass', JSON.stringify(Object.keys(files)));
    } finally { s.done(); }
  }
  const s = await setup({ 'proj/.cursorignore': '!.env\n# .env\nnode_modules\n', '.cursor/mcp.json': '{}' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'cursor')[0].status, 'fail');
  } finally { s.done(); }
});

test('cursor: autofix adds Read(**/.env*) once and is idempotent', async () => {
  const s = await setup({ '.cursor/cli-config.json': { version: 1, permissions: { allow: ['Shell(ls)'], deny: [] } } });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    assert.deepEqual(plan.map((p) => p.id), ['cursor-env-deny']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 1);
    const j = JSON.parse(fs.readFileSync(path.join(s.home, '.cursor', 'cli-config.json'), 'utf8'));
    assert.deepEqual(j.permissions.deny, ['Read(**/.env*)']);
    assert.deepEqual(j.permissions.allow, ['Shell(ls)']);
    assert.equal(applyFixes(plan, s.ctx).changed.length, 0);
    assert.equal(planFixes(result, s.ctx).length, 0);
  } finally { s.done(); }
});

test('gemini: skip outside a project, fail in a project, pass via ignore files and policy', async () => {
  let s = await setup({ '.gemini/settings.json': '{}' }, { cwdName: '.' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'skip');
  } finally { s.done(); }
  s = await setup({ '.gemini/settings.json': '{}', 'proj/.git/HEAD': 'ref' });
  try {
    const [r] = rowFor(await check.run(s.ctx), 'gemini');
    assert.equal(r.status, 'fail');
    assert.equal(r.autoFix, undefined);
  } finally { s.done(); }
  s = await setup({ '.gemini/settings.json': '{}', 'proj/.gemini/x': '', 'proj/.geminiignore': '.env\n' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'pass');
  } finally { s.done(); }
  s = await setup({ '.gemini/settings.json': '{}', 'proj/.git/HEAD': 'ref', 'proj/.gitignore': 'node_modules\n.env*\n' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'pass');
  } finally { s.done(); }
  s = await setup({
    '.gemini/settings.json': '{}',
    '.gemini/policies/p.toml': '[[rule]]\ntoolName = "read_file"\nargsPattern = "\\\\.env"\ndecision = "deny"\n',
    'proj/.git/HEAD': 'ref',
  });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'pass');
  } finally { s.done(); }
});

test('gemini: .gitignore without a git repo, or with respectGitIgnore false, does not count', async () => {
  let s = await setup({ '.gemini/settings.json': '{}', 'proj/.gemini/x': '', 'proj/.gitignore': '.env\n' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'fail');
  } finally { s.done(); }
  s = await setup({
    '.gemini/settings.json': '{"context":{"fileFiltering":{"respectGitIgnore":false}}}',
    'proj/.git/HEAD': 'ref',
    'proj/.gitignore': '.env\n',
  });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'fail');
  } finally { s.done(); }
});

test('system info row lists .env basenames only, never contents', async () => {
  const s = await setup({ '.claude/settings.json': {}, 'proj/.env': PLANTED, 'proj/.env.local': PLANTED, 'proj/readme.md': '' });
  try {
    const rows = await check.run(s.ctx);
    const sys = rowFor(rows, 'system');
    assert.equal(sys.length, 1);
    assert.equal(sys[0].status, 'info');
    assert.match(sys[0].message, /\.env, \.env\.local/);
    assert.ok(!dump(rows).includes(PLANTED));
  } finally { s.done(); }
});

test('customConfigDir adds one info row for Claude Code', async () => {
  const s = await setup({ '.claude/settings.json': {} }, { envNames: ['CLAUDE_CONFIG_DIR'] });
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.equal(rows.at(-1).status, 'info');
    assert.equal(rows.at(-1).message, 'CLAUDE_CONFIG_DIR is set; only the default config location was checked.');
  } finally { s.done(); }
});

test('codex: .env.* alone does not cover .env; **/.env* does (info rows)', async () => {
  let s = await setup({ '.codex/config.toml': 'default_permissions = "s"\n[permissions.s.filesystem]\n"**/.env.*" = "deny"\n' });
  try {
    assert.match(rowFor(await check.run(s.ctx), 'codex')[0].message, /has no deny entry for \.env files/);
  } finally { s.done(); }
  s = await setup({ '.codex/config.toml': 'default_permissions = "s"\n[permissions.s.filesystem]\n"**/.env*" = "deny"\n' });
  try {
    assert.match(rowFor(await check.run(s.ctx), 'codex')[0].message, /has a deny entry for \.env files/);
  } finally { s.done(); }
});

test('cursor: docs example Read(.env*) still passes', async () => {
  const s = await setup({ '.cursor/cli-config.json': { permissions: { deny: ['Read(.env*)'] } } });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'cursor')[0].status, 'pass');
  } finally { s.done(); }
});

test('gemini: a later !.env negation uncovers .env; .environment in a policy does not count', async () => {
  let s = await setup({ '.gemini/settings.json': '{}', 'proj/.geminiignore': '.env\n!.env\n', 'proj/.gemini/x': '' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'fail');
  } finally { s.done(); }
  s = await setup({ '.gemini/settings.json': '{}', 'proj/.geminiignore': '!.env\n.env\n', 'proj/.gemini/x': '' });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'pass');
  } finally { s.done(); }
  s = await setup({
    '.gemini/settings.json': '{}',
    '.gemini/policies/p.toml': '[[rule]]\ntoolName = "read_file"\nargsPattern = "\\\\.environment"\ndecision = "deny"\n',
    'proj/.git/HEAD': 'ref',
  });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'fail');
  } finally { s.done(); }
  // A commented-out example rule is not protection.
  s = await setup({
    '.gemini/settings.json': '{}',
    '.gemini/policies/p.toml': '[[rule]]\ntoolName = "read_file"\n# argsPattern = "\\\\.env"\n# decision = "deny"\ndecision = "ask_user"\n',
    'proj/.git/HEAD': 'ref',
  });
  try {
    assert.equal(rowFor(await check.run(s.ctx), 'gemini')[0].status, 'fail');
  } finally { s.done(); }
});

test('claude-code: cwd == home does not turn a relative user rule into a strong project rule', async () => {
  const s = await setup({ '.claude/settings.json': { permissions: { deny: ['Read(.env)'] } } }, { cwdName: '.' });
  try {
    const rows = rowFor(await check.run(s.ctx), 'claude-code');
    assert.deepEqual(rows.map((r) => r.status), ['pass', 'info']);
  } finally { s.done(); }
});

test('two autofixes in the same second keep the original in the first backup', async () => {
  const orig = '{"permissions":{"deny":[]}}';
  const s = await setup({ '.claude/settings.json': orig });
  try {
    const result = { checks: [{ results: await check.run(s.ctx) }] };
    const plan = planFixes(result, s.ctx);
    const now = new Date(2026, 10, 12, 9, 0, 0);
    applyFixes(plan, s.ctx, { now });
    const dir = path.join(s.home, '.claude');
    const baks = fs.readdirSync(dir).filter((f) => f.includes('leakcheck-bak'));
    assert.equal(baks.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, baks[0]), 'utf8'), orig);
  } finally { s.done(); }
});
