import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../src/read.js';
import { detectAgents } from '../src/detect.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  const home = path.join(root, 'home');
  const sysRoot = path.join(root, 'sys');
  fs.mkdirSync(home);
  fs.mkdirSync(sysRoot);
  return { root, home, sysRoot };
}
const put = (p, text = '') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const mk = (t, extra = {}) => ({
  home: t.home,
  cwd: path.join(t.home, 'proj'),
  platform: 'darwin',
  envNames: [],
  read,
  systemRoot: t.sysRoot,
  exec: { binaryVersion: async () => null },
  ...extra,
});
const byId = (agents, id) => agents.find((a) => a.id === id);

test('empty home detects nothing', async () => {
  const t = setup();
  try {
    assert.deepEqual(await detectAgents(mk(t)), []);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('claude-code: version from the launcher symlink, paths and customConfigDir', async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.home, '.local', 'bin'), { recursive: true });
    fs.symlinkSync('/x/share/claude/versions/2.1.322', path.join(t.home, '.local', 'bin', 'claude'));
    const ctx = mk(t, { envNames: ['CLAUDE_CONFIG_DIR', 'HOME'] });
    const cc = byId(await detectAgents(ctx), 'claude-code');
    assert.equal(cc.name, 'Claude Code');
    assert.equal(cc.version, '2.1.322');
    assert.equal(cc.customConfigDir, 'CLAUDE_CONFIG_DIR');
    assert.deepEqual(Object.keys(cc.paths).sort(), [
      'dir', 'localSettings', 'managedSettings', 'projectMcp', 'projectSettings', 'userJson', 'userSettings',
    ]);
    assert.equal(cc.paths.userJson, path.join(t.home, '.claude.json'));
    assert.equal(cc.paths.managedSettings, path.join(t.sysRoot, 'Library', 'Application Support', 'ClaudeCode', 'managed-settings.json'));
    assert.equal(cc.paths.projectMcp, path.join(t.home, 'proj', '.mcp.json'));
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('claude-code: version from npm package.json, then from the binary, else null', async () => {
  const t = setup();
  try {
    put(path.join(t.home, '.claude.json'), '{}');
    assert.equal(byId(await detectAgents(mk(t)), 'claude-code').version, null);
    const exec = { binaryVersion: async (c) => (c === 'claude' ? '2.0.5' : null) };
    assert.equal(byId(await detectAgents(mk(t, { exec })), 'claude-code').version, '2.0.5');
    put(
      path.join(t.sysRoot, 'opt', 'homebrew', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
      '{"version":"2.1.400"}',
    );
    // The PATH launcher's version wins over a package.json; package.json is the fallback.
    assert.equal(byId(await detectAgents(mk(t, { exec })), 'claude-code').version, '2.0.5');
    assert.equal(byId(await detectAgents(mk(t)), 'claude-code').version, '2.1.400');
    const linux = byId(await detectAgents(mk(t, { platform: 'linux' })), 'claude-code');
    assert.equal(linux.paths.managedSettings, path.join(t.sysRoot, 'etc', 'claude-code', 'managed-settings.json'));
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('codex and gemini: dir detection, binary version, paths', async () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.home, '.codex'));
    fs.mkdirSync(path.join(t.home, '.gemini'));
    const exec = { binaryVersion: async (c) => (c === 'codex' ? '0.167.2' : null) };
    const agents = await detectAgents(mk(t, { exec, envNames: ['CODEX_HOME'] }));
    const cx = byId(agents, 'codex');
    assert.equal(cx.version, '0.167.2');
    assert.equal(cx.customConfigDir, 'CODEX_HOME');
    assert.equal(cx.paths.config, path.join(t.home, '.codex', 'config.toml'));
    assert.equal(cx.paths.projectConfig, path.join(t.home, 'proj', '.codex', 'config.toml'));
    const gm = byId(agents, 'gemini');
    assert.equal(gm.name, 'Gemini CLI');
    assert.equal(gm.version, null);
    assert.equal(gm.customConfigDir, null);
    assert.equal(gm.paths.settings, path.join(t.home, '.gemini', 'settings.json'));
    assert.equal(gm.paths.ignore, path.join(t.home, 'proj', '.geminiignore'));
    assert.equal(gm.paths.systemSettings, path.join(t.sysRoot, 'Library', 'Application Support', 'GeminiCli', 'settings.json'));
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('cursor: IDE app version, CLI flag, newest cursor-agent version', async () => {
  const t = setup();
  try {
    put(path.join(t.sysRoot, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'package.json'), '{"version":"3.24.12"}');
    let cu = byId(await detectAgents(mk(t)), 'cursor');
    assert.equal(cu.version, '3.24.12');
    assert.equal(cu.ide, true);
    assert.equal(cu.cli, false);
    fs.mkdirSync(path.join(t.home, '.local', 'share', 'cursor-agent', 'versions', '2026.01.23-916f423'), { recursive: true });
    cu = byId(await detectAgents(mk(t)), 'cursor');
    assert.equal(cu.cli, true);
    assert.deepEqual(Object.keys(cu.paths).sort(), ['cliConfig', 'dir', 'ignore', 'mcp', 'projectCli', 'projectMcp']);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('cursor: CLI-only machine falls back to the versions directory name', async () => {
  const t = setup();
  try {
    put(path.join(t.home, '.cursor', 'cli-config.json'), '{}');
    for (const v of ['2026.01.01-aaa', '2026.01.23-916f423']) {
      fs.mkdirSync(path.join(t.home, '.local', 'share', 'cursor-agent', 'versions', v), { recursive: true });
    }
    const cu = byId(await detectAgents(mk(t)), 'cursor');
    assert.equal(cu.version, '2026.01.23-916f423');
    assert.equal(cu.ide, false);
    assert.equal(cu.cli, true);
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('claude-code: PATH launcher version beats a stale npm package.json', async () => {
  const t = setup();
  try {
    put(path.join(t.home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), '{"version":"1.0.0"}');
    const ctx = mk(t, { exec: { binaryVersion: async (n) => (n === 'claude' ? '2.1.400' : null) } });
    assert.equal(byId(await detectAgents(ctx), 'claude-code').version, '2.1.400');
    const none = byId(await detectAgents(mk(t)), 'claude-code');
    assert.equal(none.version, '1.0.0');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test('cursor: versions directory is sorted numerically', async () => {
  const t = setup();
  try {
    put(path.join(t.home, '.cursor', 'cli-config.json'), '{}');
    for (const v of ['2025.9.5-aaa', '2025.11.2-bbb']) {
      fs.mkdirSync(path.join(t.home, '.local', 'share', 'cursor-agent', 'versions', v), { recursive: true });
    }
    assert.equal(byId(await detectAgents(mk(t)), 'cursor').version, '2025.11.2-bbb');
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
