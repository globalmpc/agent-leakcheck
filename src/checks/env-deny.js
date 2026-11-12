import path from 'node:path';
import { REPO_URL } from '../config.js';
import { parseToml } from '../toml.js';
import { addJsonArrayEntries, registerFix } from '../fix.js';
import { agent, tilde } from './util.js';

const CC_ENTRIES = ['Read(//**/.env)', 'Read(//**/.env.*)'];
// `**/` is documented glob syntax; whether a bare `.env*` reaches nested folders is unverified.
const CURSOR_ENTRY = 'Read(**/.env*)';

// Rules that cover a file named exactly `.env` (`.env.*` alone does not match `.env`).
const CC_ANCHORED = /^(\/\/|~\/)\*\*\/\.env\*?$/;
const CC_RELATIVE = /^(\.\/)?(\*\*\/)?\.env\*?$/;
const CURSOR_RULE = /^(\.\/|\*\*\/)?\.env\*?$/;
const IGNORE_LINE = /^(\/|\*\*\/)?(\*)?\.env\*?$/;

function loadJson(ctx, p, jsonc = true) {
  if (!ctx.read.exists(p)) return { state: 'missing', data: null };
  const data = ctx.read.readJson(p, { jsonc });
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { state: 'ok', data }
    : { state: 'bad', data: null };
}

function denyList(data) {
  const d = data && data.permissions && data.permissions.deny;
  return Array.isArray(d) ? d.filter((x) => typeof x === 'string') : [];
}

function ruleArg(entry) {
  const m = entry.trim().match(/^Read\(\s*(.*?)\s*\)$/);
  return m ? m[1] : null;
}

// Last matching line wins (gitignore order); `!` re-includes what an earlier line ignored.
function ignoreCovers(text) {
  let covered = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) continue;
    if (l.startsWith('!')) {
      if (IGNORE_LINE.test(l.slice(1))) covered = false;
    } else if (IGNORE_LINE.test(l)) covered = true;
  }
  return covered;
}

function customDirRow(a) {
  return {
    agent: a.id,
    status: 'info',
    message: `${a.customConfigDir} is set; only the default config location was checked.`,
  };
}

function claudeRows(ctx, cc) {
  const p = cc.paths;
  const files = [
    ['user', p.userSettings],
    ['project', p.projectSettings],
    ['local', p.localSettings],
    ['managed', p.managedSettings],
  ];
  let strong = null;
  let weak = null;
  const bad = [];
  const seen = new Set();
  for (const [kind, file] of files) {
    // With cwd == home the project files can be the user file: count each file once, as user.
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const { state, data } = loadJson(ctx, file);
    if (state === 'bad') bad.push(file);
    for (const entry of denyList(data)) {
      const arg = ruleArg(entry);
      if (arg === null) continue;
      if (CC_ANCHORED.test(arg)) strong = strong || file;
      else if (CC_RELATIVE.test(arg)) {
        if (kind === 'user') weak = weak || file;
        else strong = strong || file;
      }
    }
  }
  const rows = [];
  if (strong || weak) {
    rows.push({
      agent: 'claude-code',
      status: 'pass',
      message: `Claude Code denies reading .env files (rule in ${tilde(ctx, strong || weak)}).`,
    });
    if (!strong) {
      rows.push({
        agent: 'claude-code',
        status: 'info',
        message: 'The user-level .env rule is relative to the current folder; Read(//**/.env) covers every project.',
        fix: 'Add "Read(//**/.env)" to permissions.deny in ~/.claude/settings.json.',
      });
    }
  } else if (bad.length) {
    rows.push({
      agent: 'claude-code',
      status: 'skip',
      message: `Could not parse ${bad.map((f) => tilde(ctx, f)).join(', ')}, so .env rules were not checked.`,
    });
  } else {
    rows.push({
      agent: 'claude-code',
      status: 'fail',
      message: 'Claude Code has no deny rule for .env files.',
      fix: `Add ${CC_ENTRIES.map((e) => `"${e}"`).join(' and ')} to permissions.deny in ~/.claude/settings.json. Rules do not cover every shell command, so a sandbox adds OS-level protection.`,
      autoFix: 'cc-env-deny',
    });
  }
  if (cc.customConfigDir) rows.push(customDirRow(cc));
  return rows;
}

function* walkDeny(node) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (v === 'deny') yield k;
    } else if (v && typeof v === 'object') yield* walkDeny(v);
  }
}

const CODEX_SNIPPET =
  'In ~/.codex/config.toml (beta permission profiles): `default_permissions = "protected"` at the top level (it cannot be combined with sandbox_mode), then a `[permissions.protected.filesystem]` table with `"**/*.env" = "deny"` and `"**/.env.*" = "deny"`.';

const CODEX_BETA = 'This is a beta setting, so it is not part of the grade.';

function codexRows(ctx, cx) {
  const rows = [];
  const files = [cx.paths.config, cx.paths.projectConfig];
  let profile = null;
  const denies = new Map();
  let bad = null;
  for (const file of files) {
    if (!ctx.read.exists(file)) continue;
    const text = ctx.read.readText(file);
    const cfg = text === null ? null : parseToml(text);
    if (!cfg) {
      bad = bad || file;
      continue;
    }
    if (typeof cfg.default_permissions === 'string') profile = cfg.default_permissions;
    const perms = cfg.permissions;
    if (perms && typeof perms === 'object') {
      for (const [name, def] of Object.entries(perms)) {
        const fsTable = def && def.filesystem;
        const keys = [...walkDeny(fsTable)].filter((k) => /(^|\/)\*?\.env\*?$/.test(k));
        if (keys.length) denies.set(name, file);
      }
    }
  }
  // Permission profiles are beta and the deny syntax is unverified in practice
  // (docs/research/claude-codex.md), so Codex rows are info and never change the grade.
  if (profile && denies.has(profile)) {
    rows.push({
      agent: 'codex',
      status: 'info',
      message: `Codex profile ${profile} has a deny entry for .env files (in ${tilde(ctx, denies.get(profile))}). ${CODEX_BETA}`,
    });
  } else if (bad) {
    rows.push({
      agent: 'codex',
      status: 'skip',
      message: `Could not parse ${tilde(ctx, bad)}, so .env rules were not checked.`,
    });
  } else {
    rows.push({
      agent: 'codex',
      status: 'info',
      message: `${profile
        ? `Codex default profile ${profile} has no deny entry for .env files.`
        : 'Codex has no default permission profile that denies .env files.'} ${CODEX_BETA}`,
      fix: CODEX_SNIPPET,
    });
  }
  if (cx.customConfigDir) rows.push(customDirRow(cx));
  return rows;
}

function cursorRows(ctx, cu) {
  const p = cu.paths;
  let covered = null;
  let bad = null;
  for (const file of [p.cliConfig, p.projectCli]) {
    const { state, data } = loadJson(ctx, file);
    if (state === 'bad') bad = bad || file;
    if (denyList(data).some((e) => CURSOR_RULE.test(ruleArg(e) ?? '\0'))) covered = covered || file;
  }
  const ignoreText = ctx.read.readText(p.ignore);
  const ignoreCovered = ignoreText !== null && ignoreCovers(ignoreText);
  const rows = [];
  if (covered || ignoreCovered) {
    const where = [covered && tilde(ctx, covered), ignoreCovered && '.cursorignore'].filter(Boolean).join(' and ');
    rows.push({
      agent: 'cursor',
      status: 'pass',
      message: `Cursor covers .env files via ${where}; this is best effort and terminal and MCP tools can still read them.`,
    });
  } else if (bad) {
    rows.push({
      agent: 'cursor',
      status: 'skip',
      message: `Could not parse ${tilde(ctx, bad)}, so .env rules were not checked.`,
    });
  } else {
    const canFix = ctx.read.exists(p.cliConfig);
    rows.push({
      agent: 'cursor',
      status: 'fail',
      message: 'Cursor has no Read deny for .env in the CLI config and no .env rule in .cursorignore.',
      fix: `Add "${CURSOR_ENTRY}" to permissions.deny in ~/.cursor/cli-config.json (CLI; "**/" also reaches nested folders), and list .env and .env.* in .cursorignore (IDE; Cursor documents this as best effort, and whether it covers the IDE agent is not verified here).`,
      ...(canFix ? { autoFix: 'cursor-env-deny' } : {}),
    });
  }
  if (cu.customConfigDir) rows.push(customDirRow(cu));
  return rows;
}

function geminiFlag(ctx, gm, key) {
  const p = gm.paths;
  for (const file of [p.systemSettings, p.projectSettings, p.settings]) {
    const { data } = loadJson(ctx, file);
    const v = data && data.context && data.context.fileFiltering && data.context.fileFiltering[key];
    if (typeof v === 'boolean') return v;
  }
  return true;
}

const mentionsEnv = (v) =>
  typeof v === 'string' ? /\.env(?![A-Za-z0-9_])/.test(v) : Array.isArray(v) && v.some(mentionsEnv);

// Parsed, so commented-out examples never count; an unparseable policy file counts as no rule.
function geminiPolicyDenies(ctx, gm) {
  const dir = path.join(gm.paths.dir, 'policies');
  for (const name of ctx.read.listDir(dir)) {
    if (!name.endsWith('.toml')) continue;
    const text = ctx.read.readText(path.join(dir, name));
    const cfg = text === null ? null : parseToml(text);
    const rules = cfg && Array.isArray(cfg.rule) ? cfg.rule : [];
    for (const r of rules) {
      if (r && r.decision === 'deny' && Object.entries(r).some(([k, v]) => k !== 'decision' && mentionsEnv(v))) return true;
    }
  }
  return false;
}

function geminiRows(ctx, gm) {
  const { cwd, home, read } = ctx;
  const isGit = read.exists(path.join(cwd, '.git'));
  const isProject = cwd !== home && (isGit || read.exists(path.join(cwd, '.gemini')));
  if (!isProject) {
    return [{
      agent: 'gemini',
      status: 'skip',
      message: 'Gemini CLI has no user-level ignore file; run this from a project folder to check .env rules.',
    }];
  }
  const geminiIgnore = read.readText(gm.paths.ignore);
  const ignoreOk = geminiIgnore !== null && ignoreCovers(geminiIgnore) && geminiFlag(ctx, gm, 'respectGeminiIgnore');
  const gitignore = isGit ? read.readText(path.join(cwd, '.gitignore')) : null;
  const gitOk = gitignore !== null && ignoreCovers(gitignore) && geminiFlag(ctx, gm, 'respectGitIgnore');
  const policyOk = geminiPolicyDenies(ctx, gm);
  if (ignoreOk || gitOk || policyOk) {
    const how = ignoreOk ? '.geminiignore' : gitOk ? '.gitignore' : 'a deny policy';
    return [{
      agent: 'gemini',
      status: 'pass',
      message: `Gemini CLI file tools skip .env through ${how}; its shell tool is not filtered.`,
    }];
  }
  return [{
    agent: 'gemini',
    status: 'fail',
    message: 'Gemini CLI can read .env: no .geminiignore or gitignored .env, and no deny policy.',
    fix: 'Create .geminiignore in the project with the lines `.env` and `.env.*`, or gitignore them. Gemini shell commands are not filtered.',
  }];
}

function envFilesRow(ctx) {
  const names = ctx.read.listDir(ctx.cwd).filter((n) => /^\.env(\..+)?$/.test(n)).sort();
  if (!names.length) return [];
  return [{
    agent: 'system',
    status: 'info',
    message: `This folder has env files: ${names.join(', ')} (names only; contents were not read).`,
  }];
}

registerFix('cc-env-deny', {
  describe(ctx) {
    const cc = agent(ctx, 'claude-code');
    if (!cc) return null;
    const { state, data } = loadJson(ctx, cc.paths.userSettings, false);
    if (state === 'bad') return null;
    const have = denyList(data);
    if (CC_ENTRIES.every((e) => have.includes(e))) return null;
    return `Add ${CC_ENTRIES.join(' and ')} to permissions.deny in ${tilde(ctx, cc.paths.userSettings)}.`;
  },
  apply(ctx, _result, { now } = {}) {
    const cc = agent(ctx, 'claude-code');
    if (!cc) return null;
    const r = addJsonArrayEntries(cc.paths.userSettings, ['permissions', 'deny'], CC_ENTRIES, { now });
    if (r.reason) return { path: r.path, skipped: r.reason };
    return r.changed ? { path: r.path, what: 'Added .env deny rules', backup: r.backup } : null;
  },
});

registerFix('cursor-env-deny', {
  describe(ctx) {
    const cu = agent(ctx, 'cursor');
    if (!cu || !ctx.read.exists(cu.paths.cliConfig)) return null;
    const { state, data } = loadJson(ctx, cu.paths.cliConfig, false);
    if (state === 'bad' || denyList(data).includes(CURSOR_ENTRY)) return null;
    return `Add ${CURSOR_ENTRY} to permissions.deny in ${tilde(ctx, cu.paths.cliConfig)}.`;
  },
  apply(ctx, _result, { now } = {}) {
    const cu = agent(ctx, 'cursor');
    if (!cu) return null;
    const r = addJsonArrayEntries(cu.paths.cliConfig, ['permissions', 'deny'], [CURSOR_ENTRY], { now });
    if (r.reason) return { path: r.path, skipped: r.reason };
    return r.changed ? { path: r.path, what: 'Added .env deny rule', backup: r.backup } : null;
  },
});

export default {
  id: 'env-deny',
  title: 'Agents can read .env files',
  severity: 'high',
  docs: [`${REPO_URL}#env-deny`],
  run(ctx) {
    const rows = [];
    const cc = agent(ctx, 'claude-code');
    const cx = agent(ctx, 'codex');
    const cu = agent(ctx, 'cursor');
    const gm = agent(ctx, 'gemini');
    if (cc) rows.push(...claudeRows(ctx, cc));
    if (cx) rows.push(...codexRows(ctx, cx));
    if (cu) rows.push(...cursorRows(ctx, cu));
    if (gm) rows.push(...geminiRows(ctx, gm));
    if (!rows.length) rows.push({ agent: 'system', status: 'skip', message: 'No supported agent is installed.' });
    rows.push(...envFilesRow(ctx));
    return rows;
  },
};
