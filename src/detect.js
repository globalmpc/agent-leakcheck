/**
 * Detect which coding agents are installed (config dirs, symlinks, app bundles, package.json
 * files). Facts: docs/research/claude-codex.md and docs/research/cursor-gemini.md.
 * Env values are never read: `customConfigDir` is the env NAME when it is set.
 *
 * Agent object shape (see docs/SPEC.md):
 *   { id, name, version: string|null, paths: object, customConfigDir: string|null }
 * Cursor also has `ide` and `cli` booleans.
 *
 * `ctx.systemRoot` (optional, default '/') is the root for absolute system paths
 * (/Applications, /opt/homebrew, managed settings); tests point it into a temp dir.
 *
 * @param {object} ctx partial context: { home, cwd, platform, envNames, read, exec, systemRoot? }
 * @returns {Promise<Array<{id: string, name: string, version: string|null, paths: object, customConfigDir: string|null}>>}
 */
import path from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+/;
const CC_PKG = ['node_modules', '@anthropic-ai', 'claude-code', 'package.json'];

async function binVersion(ctx, cmd) {
  try {
    return (await ctx.exec.binaryVersion(cmd)) || null;
  } catch {
    return null;
  }
}

// Numeric compare of dotted parts, so 2025.11.x sorts after 2025.9.x; ties fall back to string order.
function compareVersions(a, b) {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function pkgVersion(ctx, file) {
  const pkg = ctx.read.readJson(file);
  return pkg && typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
}

async function claudeCode(ctx, sys) {
  const { home, cwd, platform, read } = ctx;
  const dir = path.join(home, '.claude');
  const userJson = path.join(home, '.claude.json');
  const launcher = path.join(home, '.local', 'bin', 'claude');
  const present = read.exists(dir) || read.exists(userJson) || read.lstat(launcher) !== null;
  if (!present) return null;

  let version = null;
  const target = read.readlink(launcher);
  const base = target ? path.basename(target) : '';
  if (SEMVER.test(base)) version = base;
  if (!version) version = await binVersion(ctx, 'claude');
  if (!version) {
    const pkgs = [
      path.join(home, '.claude', 'local', ...CC_PKG),
      sys('opt', 'homebrew', 'lib', ...CC_PKG),
      sys('usr', 'local', 'lib', ...CC_PKG),
      path.join(home, '.npm-global', 'lib', ...CC_PKG),
    ];
    if (platform === 'win32') pkgs.push(path.join(home, 'AppData', 'Roaming', 'npm', ...CC_PKG));
    for (const file of pkgs) {
      version = pkgVersion(ctx, file);
      if (version) break;
    }
  }

  const managed =
    platform === 'darwin'
      ? sys('Library', 'Application Support', 'ClaudeCode', 'managed-settings.json')
      : platform === 'win32'
        ? sys('Program Files', 'ClaudeCode', 'managed-settings.json')
        : sys('etc', 'claude-code', 'managed-settings.json');
  return {
    id: 'claude-code',
    name: 'Claude Code',
    version,
    customConfigDir: envName(ctx, 'CLAUDE_CONFIG_DIR'),
    paths: {
      dir,
      userSettings: path.join(dir, 'settings.json'),
      userJson,
      managedSettings: managed,
      projectSettings: path.join(cwd, '.claude', 'settings.json'),
      localSettings: path.join(cwd, '.claude', 'settings.local.json'),
      projectMcp: path.join(cwd, '.mcp.json'),
    },
  };
}

async function codex(ctx) {
  const { home, cwd } = ctx;
  const dir = path.join(home, '.codex');
  if (!ctx.read.exists(dir)) return null;
  return {
    id: 'codex',
    name: 'Codex',
    version: await binVersion(ctx, 'codex'),
    customConfigDir: envName(ctx, 'CODEX_HOME'),
    paths: {
      dir,
      config: path.join(dir, 'config.toml'),
      projectConfig: path.join(cwd, '.codex', 'config.toml'),
    },
  };
}

function cursor(ctx, sys) {
  const { home, cwd, platform, read } = ctx;
  const dir = path.join(home, '.cursor');
  const app = sys('Applications', 'Cursor.app');
  const cliConfig = path.join(dir, 'cli-config.json');
  const versionsDir = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
  const appPresent = platform === 'darwin' && read.exists(app);
  const hasDir = read.exists(dir);
  if (!appPresent && !hasDir) return null;

  let version = null;
  if (appPresent) version = pkgVersion(ctx, path.join(app, 'Contents', 'Resources', 'app', 'package.json'));
  if (!version) {
    const newest = read.listDir(versionsDir).sort(compareVersions).pop();
    version = newest || null;
  }
  return {
    id: 'cursor',
    name: 'Cursor',
    version,
    customConfigDir: envName(ctx, 'CURSOR_CONFIG_DIR'),
    ide: appPresent || (platform !== 'darwin' && hasDir),
    cli: read.exists(cliConfig) || read.exists(versionsDir),
    paths: {
      dir,
      cliConfig,
      projectCli: path.join(cwd, '.cursor', 'cli.json'),
      mcp: path.join(dir, 'mcp.json'),
      projectMcp: path.join(cwd, '.cursor', 'mcp.json'),
      ignore: path.join(cwd, '.cursorignore'),
    },
  };
}

async function gemini(ctx, sys) {
  const { home, cwd, platform } = ctx;
  const dir = path.join(home, '.gemini');
  if (!ctx.read.exists(dir)) return null;
  const systemSettings =
    platform === 'darwin'
      ? sys('Library', 'Application Support', 'GeminiCli', 'settings.json')
      : platform === 'win32'
        ? sys('ProgramData', 'gemini-cli', 'settings.json')
        : sys('etc', 'gemini-cli', 'settings.json');
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    version: await binVersion(ctx, 'gemini'),
    customConfigDir: null,
    paths: {
      dir,
      settings: path.join(dir, 'settings.json'),
      projectSettings: path.join(cwd, '.gemini', 'settings.json'),
      systemSettings,
      ignore: path.join(cwd, '.geminiignore'),
    },
  };
}

function envName(ctx, name) {
  return Array.isArray(ctx.envNames) && ctx.envNames.includes(name) ? name : null;
}

export async function detectAgents(ctx) {
  const root = ctx.systemRoot || '/';
  const sys = (...parts) => path.join(root, ...parts);
  const found = [
    await claudeCode(ctx, sys),
    await codex(ctx),
    cursor(ctx, sys),
    await gemini(ctx, sys),
  ];
  return found.filter(Boolean);
}
