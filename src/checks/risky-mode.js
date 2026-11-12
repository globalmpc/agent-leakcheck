import path from 'node:path';
import { REPO_URL } from '../config.js';
import { parseToml } from '../toml.js';
import { setJsonKey, setTomlTopLevelKey, registerFix } from '../fix.js';
import { agent, tilde } from './util.js';

function loadJson(ctx, p, jsonc = true) {
  if (!ctx.read.exists(p)) return { state: 'missing', data: null };
  const data = ctx.read.readJson(p, { jsonc });
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { state: 'ok', data }
    : { state: 'bad', data: null };
}

function loadToml(ctx, p) {
  if (!ctx.read.exists(p)) return { state: 'missing', data: null };
  const text = ctx.read.readText(p);
  const data = text === null ? null : parseToml(text);
  return data ? { state: 'ok', data } : { state: 'bad', data: null };
}

function customDirRow(a) {
  return {
    agent: a.id,
    status: 'info',
    message: `${a.customConfigDir} is set; only the default config location was checked.`,
  };
}

function atLeast(version, min) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== min[i]) return Number(m[i + 1]) > min[i];
  return true;
}

const isBareBash = (e) => typeof e === 'string' && /^Bash(\(\*\))?$/.test(e.trim());

const get = (o, ...keys) => keys.reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), o);

function claudeRows(ctx, cc) {
  const p = cc.paths;
  const files = [
    ['managed', p.managedSettings],
    ['user', p.userSettings],
    ['project', p.projectSettings],
    ['local', p.localSettings],
  ];
  const rows = [];
  const loaded = {};
  const seen = new Set();
  const live = [];
  for (const [kind, file] of files) {
    // With cwd == home the project files can be the user file: count each file once, as user.
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const { state, data } = loadJson(ctx, file);
    loaded[kind] = data;
    live.push([kind, file, state, data]);
  }
  // disableBypassPermissionsMode works from any settings file (research claude-codex.md).
  const bypassDisabled = live.some(([, , , d]) => get(d, 'permissions', 'disableBypassPermissionsMode') === 'disable');
  const managedMode = get(loaded.managed, 'permissions', 'defaultMode');
  for (const [kind, file, state, data] of live) {
    if (state === 'bad') {
      rows.push({ agent: 'claude-code', status: 'skip', message: `Could not parse ${tilde(ctx, file)}, so it was not checked.` });
      continue;
    }
    const mode = get(data, 'permissions', 'defaultMode');
    const name = tilde(ctx, file);
    const allow = get(data, 'permissions', 'allow');
    if (Array.isArray(allow) && allow.some(isBareBash)) {
      rows.push({
        agent: 'claude-code',
        status: 'fail',
        message: `${name} allows Bash with no command filter in permissions.allow: every Bash command runs without a prompt.`,
        fix: 'Replace the Bash allow rule with specific commands, for example "Bash(npm test)".',
      });
    }
    if (mode === 'bypassPermissions') {
      const overridden = kind === 'user' && typeof managedMode === 'string' && managedMode !== 'bypassPermissions';
      if ((kind === 'user' || kind === 'managed') && (bypassDisabled || overridden)) {
        rows.push({
          agent: 'claude-code',
          status: 'info',
          message: bypassDisabled
            ? `${name} sets bypassPermissions, but permissions.disableBypassPermissionsMode is disable, so Claude Code does not allow it.`
            : `${name} sets bypassPermissions, but the managed settings set a different defaultMode, which wins.`,
        });
      } else if (kind === 'user' || kind === 'managed') {
        const row = {
          agent: 'claude-code',
          status: 'fail',
          message: `Claude Code defaults to bypassPermissions in ${name}: every tool runs without asking.`,
          fix: 'Remove permissions.defaultMode or set it to "default"; optionally set permissions.disableBypassPermissionsMode to "disable".',
        };
        if (kind === 'user' && managedMode !== 'bypassPermissions') {
          row.autoFix = 'cc-risky-mode';
        }
        rows.push(row);
      } else if (atLeast(cc.version, [2, 1, 257])) {
        rows.push({
          agent: 'claude-code',
          status: 'info',
          message: `${name} sets bypassPermissions, which Claude Code ${cc.version} ignores from project files.`,
        });
      } else {
        rows.push({
          agent: 'claude-code',
          status: 'fail',
          message: `${name} sets bypassPermissions, which this Claude Code version may honour: every tool runs without asking.`,
          fix: 'Remove permissions.defaultMode from the project file and update Claude Code.',
        });
      }
    } else if (mode === 'auto' && (kind === 'user' || kind === 'managed')) {
      rows.push({ agent: 'claude-code', status: 'info', message: `Claude Code defaults to auto mode in ${name}.` });
    }
    if (kind !== 'project' && get(data, 'skipDangerousModePermissionPrompt') === true) {
      rows.push({
        agent: 'claude-code',
        status: 'info',
        message: `${name} sets skipDangerousModePermissionPrompt, which skips the bypass confirmation.`,
      });
    }
  }
  // An unparseable file was not checked, so it must not be reported as a pass.
  const unparsed = live.some(([, , state]) => state === 'bad');
  if (!unparsed && !rows.some((r) => r.status === 'fail')) {
    rows.push({ agent: 'claude-code', status: 'pass', message: 'Claude Code does not default to bypassing permissions.' });
  }
  if (cc.customConfigDir) rows.push(customDirRow(cc));
  return rows;
}

function codexRows(ctx, cx) {
  const { state, data } = loadToml(ctx, cx.paths.config);
  const name = tilde(ctx, cx.paths.config);
  const rows = [];
  if (state === 'missing') {
    rows.push({ agent: 'codex', status: 'skip', message: 'Codex has no config file to check.' });
  } else if (state === 'bad') {
    rows.push({ agent: 'codex', status: 'skip', message: `Could not parse ${name}, so it was not checked.` });
  } else {
    const prof = typeof data.profile === 'string' ? get(data, 'profiles', data.profile) : null;
    const pick = (key) => (prof && prof[key] !== undefined ? prof[key] : data[key]);
    const topSandbox = data.sandbox_mode === 'danger-full-access';
    const full = pick('sandbox_mode') === 'danger-full-access' || pick('default_permissions') === ':danger-full-access';
    const never = pick('approval_policy') === 'never';
    if (full) {
      const row = {
        agent: 'codex',
        status: 'fail',
        message: never
          ? `Codex has full filesystem access (danger-full-access) and approval_policy never in ${name}: it runs anything without asking.`
          : `Codex defaults to full filesystem access (danger-full-access) in ${name}.`,
        fix: pick('sandbox_mode') === 'danger-full-access'
          ? 'Set sandbox_mode = "workspace-write" and approval_policy = "on-request".'
          : 'Set default_permissions to ":workspace" (do not add sandbox_mode; it cannot be combined) and approval_policy to "on-request".',
      };
      if (topSandbox && !prof) row.autoFix = 'codex-risky-mode';
      rows.push(row);
    } else {
      rows.push({ agent: 'codex', status: 'pass', message: 'Codex does not default to full filesystem access.' });
    }
    if (never && !full) {
      rows.push({ agent: 'codex', status: 'info', message: `Codex approval_policy is never in ${name}: it runs commands without asking.` });
    }
  }
  if (cx.customConfigDir) rows.push(customDirRow(cx));
  return rows;
}

function cursorRows(ctx, cu) {
  const rows = [];
  if (cu.cli) {
    const { state, data } = loadJson(ctx, cu.paths.cliConfig, false);
    if (state === 'bad') {
      rows.push({ agent: 'cursor', status: 'skip', message: `Could not parse ${tilde(ctx, cu.paths.cliConfig)}, so it was not checked.` });
    } else if (data && data.approvalMode === 'unrestricted') {
      rows.push({
        agent: 'cursor',
        status: 'fail',
        message: `Cursor CLI approvalMode is unrestricted in ${tilde(ctx, cu.paths.cliConfig)}: commands run without asking.`,
        fix: 'Set approvalMode to "allowlist" in ~/.cursor/cli-config.json.',
        autoFix: 'cursor-risky-mode',
      });
    } else {
      rows.push({ agent: 'cursor', status: 'pass', message: 'Cursor CLI does not run unrestricted.' });
    }
  }
  if (cu.ide) {
    rows.push({
      agent: 'cursor',
      status: 'info',
      message: 'The Cursor IDE auto-run setting is not stored in a readable file, so it was not checked.',
    });
  }
  if (cu.customConfigDir) rows.push(customDirRow(cu));
  return rows;
}

function geminiRows(ctx, gm) {
  const p = gm.paths;
  let mode;
  let where = null;
  const rows = [];
  let unparsed = false;
  for (const file of [p.systemSettings, p.projectSettings, p.settings]) {
    const { state, data } = loadJson(ctx, file);
    if (state === 'bad') {
      unparsed = true;
      rows.push({ agent: 'gemini', status: 'skip', message: `Could not parse ${tilde(ctx, file)}, so it was not checked.` });
      continue;
    }
    const v = get(data, 'general', 'defaultApprovalMode');
    if (typeof v === 'string' && mode === undefined) {
      mode = v;
      where = file;
    }
    const name = tilde(ctx, file);
    const allowed = get(data, 'tools', 'allowed');
    if (Array.isArray(allowed) && allowed.some((e) => typeof e === 'string' && e.trim() === 'run_shell_command')) {
      rows.push({
        agent: 'gemini',
        status: 'fail',
        message: `${name} lists run_shell_command in tools.allowed: every shell command runs without a prompt.`,
        fix: 'Replace it with specific commands in tools.allowed, for example "run_shell_command(npm test)".',
      });
    }
    if (get(data, 'security', 'enablePermanentToolApproval') === true) {
      rows.push({
        agent: 'gemini',
        status: 'fail',
        message: `${name} sets security.enablePermanentToolApproval, which offers "Allow for all future sessions" in every tool confirmation.`,
        fix: 'Remove security.enablePermanentToolApproval or set it to false.',
      });
    }
  }
  if (mode === 'auto_edit') {
    rows.push({ agent: 'gemini', status: 'info', message: `Gemini CLI auto-approves file edits (defaultApprovalMode auto_edit in ${tilde(ctx, where)}).` });
  } else if (mode === 'yolo') {
    rows.push({ agent: 'gemini', status: 'info', message: `${tilde(ctx, where)} sets yolo as default, which Gemini CLI ignores; yolo only works through the --yolo flag.` });
  }
  // An unparseable file was not checked, so it must not be reported as a pass.
  if (!unparsed && !rows.some((r) => r.status === 'fail') && mode !== 'auto_edit' && mode !== 'yolo') {
    rows.push({ agent: 'gemini', status: 'pass', message: 'Gemini CLI settings do not enable auto-approval by default.' });
  }
  return rows;
}

registerFix('cc-risky-mode', {
  describe(ctx) {
    const cc = agent(ctx, 'claude-code');
    if (!cc) return null;
    const { data } = loadJson(ctx, cc.paths.userSettings, false);
    if (get(data, 'permissions', 'defaultMode') !== 'bypassPermissions') return null;
    return `Set permissions.defaultMode to "default" in ${tilde(ctx, cc.paths.userSettings)}.`;
  },
  apply(ctx, _result, { now } = {}) {
    const cc = agent(ctx, 'claude-code');
    if (!cc) return null;
    const { data } = loadJson(ctx, cc.paths.userSettings, false);
    if (get(data, 'permissions', 'defaultMode') !== 'bypassPermissions') return null;
    const r = setJsonKey(cc.paths.userSettings, ['permissions', 'defaultMode'], 'default', { now });
    if (r.reason) return { path: r.path, skipped: r.reason };
    return r.changed ? { path: r.path, what: 'Set permissions.defaultMode to default', backup: r.backup } : null;
  },
});

registerFix('codex-risky-mode', {
  describe(ctx) {
    const cx = agent(ctx, 'codex');
    if (!cx) return null;
    const { data } = loadToml(ctx, cx.paths.config);
    if (!data || data.sandbox_mode !== 'danger-full-access') return null;
    return `Set sandbox_mode to "workspace-write" in ${tilde(ctx, cx.paths.config)}.`;
  },
  apply(ctx, _result, { now } = {}) {
    const cx = agent(ctx, 'codex');
    if (!cx) return null;
    const { data } = loadToml(ctx, cx.paths.config);
    if (!data || data.sandbox_mode !== 'danger-full-access') return null;
    const r = setTomlTopLevelKey(cx.paths.config, 'sandbox_mode', 'workspace-write', { now });
    if (r.reason) return { path: r.path, skipped: r.reason };
    return r.changed ? { path: r.path, what: 'Set sandbox_mode to workspace-write', backup: r.backup } : null;
  },
});

registerFix('cursor-risky-mode', {
  describe(ctx) {
    const cu = agent(ctx, 'cursor');
    if (!cu) return null;
    const { data } = loadJson(ctx, cu.paths.cliConfig, false);
    if (!data || data.approvalMode !== 'unrestricted') return null;
    return `Set approvalMode to "allowlist" in ${tilde(ctx, cu.paths.cliConfig)}.`;
  },
  apply(ctx, _result, { now } = {}) {
    const cu = agent(ctx, 'cursor');
    if (!cu) return null;
    const { data } = loadJson(ctx, cu.paths.cliConfig, false);
    if (!data || data.approvalMode !== 'unrestricted') return null;
    const r = setJsonKey(cu.paths.cliConfig, ['approvalMode'], 'allowlist', { now });
    if (r.reason) return { path: r.path, skipped: r.reason };
    return r.changed ? { path: r.path, what: 'Set approvalMode to allowlist', backup: r.backup } : null;
  },
});

export default {
  id: 'risky-mode',
  title: 'An agent runs without asking',
  severity: 'high',
  docs: [`${REPO_URL}#risky-mode`],
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
    return rows;
  },
};
