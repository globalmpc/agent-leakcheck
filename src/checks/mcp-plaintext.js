import path from 'node:path';
import { REPO_URL } from '../config.js';
import { parseToml } from '../toml.js';
import { tilde } from './util.js';

const ID = 'mcp-plaintext';
const KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|BEARER|CREDENTIAL)/i;
// AUTH only as a whole word (DISABLE_AUTH, X-Auth), not inside "Author".
const AUTH_RE = /(^|[^A-Za-z])AUTH([^A-Za-z]|$)/i;
// Names that hold a location or a flag, not a secret (as secret-env's IGNORE).
const LOCATION_KEY_RE = /_(FILE|PATH|DIR)$/i;
const SHAPE_RE = new RegExp(
  [
    '\\bsk-[A-Za-z0-9_-]{16,}',
    'ghp_[A-Za-z0-9]{8,}',
    'gho_[A-Za-z0-9]{8,}',
    'github_pat_[A-Za-z0-9_]{8,}',
    'xox[abpr]-[A-Za-z0-9-]{8,}',
    'AKIA[0-9A-Z]{16}',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+',
    'Bearer\\s+\\S{20,}',
  ].join('|'),
);
const SAFE_KEY_RE = /^(PATH|NODE_PATH|HOME|PWD|LANG|SHELL|USER|TERM|TMPDIR)$/i;

// Reference syntax per agent (claude-codex.md, cursor-gemini.md). Group 2 of each regex is
// the ":-default" text, which is tested for token shapes but not for the key name.
const REF_DOLLAR_BRACE = { re: /\$\{([^}:-]*)(?::?-([^}]*))?[^}]*\}/g, bare: false };
const REF_CURSOR = { re: /\$\{(env:[^}]*)\}()/g, bare: false };
const REF_GEMINI = { re: REF_DOLLAR_BRACE.re, bare: true };

const FIX = {
  'claude-code':
    'Put "${NAME}" in the value (for example "Bearer ${GITHUB_TOKEN}") and export NAME in your shell profile.',
  codex:
    'Use env_vars = ["NAME"], env_http_headers = { "Header" = "NAME" } or bearer_token_env_var = "NAME" and export NAME.',
  cursor:
    'Put "${env:NAME}" in the value (for example "Bearer ${env:GITHUB_TOKEN}") and export NAME in your shell profile.',
  gemini:
    'Put "$NAME" in the value (for example "Bearer $GITHUB_TOKEN") and export NAME in your shell profile.',
};

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Value of a name-only match that cannot be a secret: flag, number, path or URL.
function isBenignValue(v) {
  return (
    /^(true|false|yes|no|on|off|null|none)$/i.test(v) ||
    /^[+-]?\d+(\.\d+)?$/.test(v) ||
    /^(\/|~[\\/]|[A-Za-z]:[\\/])/.test(v) ||
    /^https?:\/\//i.test(v)
  );
}

function isLiteralSecret(key, value, ref) {
  if (typeof value !== 'string' || value === '') return false;
  if (SAFE_KEY_RE.test(key)) return false;
  let defaults = '';
  let rest = value.replace(ref.re, (m, g1, g2) => {
    if (typeof g2 === 'string') defaults += ` ${g2}`;
    return '';
  });
  if (ref.bare) rest = rest.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
  if (SHAPE_RE.test(rest) || SHAPE_RE.test(defaults)) return true;
  const body = rest.replace(/^\s*(Bearer|Basic|Token)\s*$/i, '').trim();
  if (!/[A-Za-z0-9]/.test(body)) return false;
  if (LOCATION_KEY_RE.test(key) || !(KEY_RE.test(key) || AUTH_RE.test(key))) return false;
  return !isBenignValue(body);
}

// Keys (as "env.NAME") of literal secrets in the given maps of one server.
function scanServer(server, mapNames, ref) {
  const out = [];
  if (!isObj(server)) return out;
  for (const mapName of mapNames) {
    const map = server[mapName];
    if (!isObj(map)) continue;
    for (const [k, v] of Object.entries(map)) {
      if (isLiteralSecret(k, v, ref)) out.push(`${mapName}.${k}`);
    }
  }
  return out;
}

function scanServers(servers, mapNames, ref, extra) {
  const found = [];
  if (!isObj(servers)) return { count: 0, found };
  const names = Object.keys(servers);
  for (const name of names) {
    const keys = scanServer(servers[name], mapNames, ref);
    if (extra) keys.push(...extra(servers[name], ref));
    for (const key of keys) found.push({ server: name, key });
  }
  return { count: names.length, found };
}

// OAuth client secret: Codex oauth.client_secret, Cursor auth.CLIENT_SECRET (cursor-gemini.md).
const oauthSecret = (obj, field) => (server, ref) => {
  const o = isObj(server) ? server[obj] : null;
  if (!isObj(o)) return [];
  return isLiteralSecret(field, o[field], ref) ? [`${obj}.${field}`] : [];
};
const codexOauth = oauthSecret('oauth', 'client_secret');
const cursorAuth = oauthSecret('auth', 'CLIENT_SECRET');

// Each loader returns { state: 'missing' | 'bad' | 'ok', scopes: [{ label, servers }] }.
function loadJson(ctx, file, pick, opts) {
  if (!ctx.read.exists(file)) return { state: 'missing', scopes: [] };
  const data = ctx.read.readJson(file, opts);
  if (!isObj(data)) return { state: 'bad', scopes: [] };
  return { state: 'ok', scopes: pick(data) };
}

function loadToml(ctx, file) {
  if (!ctx.read.exists(file)) return { state: 'missing', scopes: [] };
  const text = ctx.read.readText(file);
  const data = text === null ? null : parseToml(text);
  if (!isObj(data)) return { state: 'bad', scopes: [] };
  return { state: 'ok', scopes: [{ label: '', servers: data.mcp_servers }] };
}

const topLevel = (key) => (data) => [{ label: '', servers: data[key] }];

function claudeUser(data) {
  const scopes = [{ label: 'user', servers: data.mcpServers }];
  if (isObj(data.projects)) {
    for (const [p, proj] of Object.entries(data.projects)) {
      if (isObj(proj)) scopes.push({ label: `project ${path.basename(p)}`, servers: proj.mcpServers });
    }
  }
  return scopes;
}

function specs(ctx, a) {
  const p = a.paths || {};
  switch (a.id) {
    case 'claude-code':
      return {
        mapNames: ['env', 'headers'],
        ref: REF_DOLLAR_BRACE,
        files: [
          p.userJson && [p.userJson, () => loadJson(ctx, p.userJson, claudeUser)],
          p.projectMcp && [p.projectMcp, () => loadJson(ctx, p.projectMcp, topLevel('mcpServers'))],
        ],
      };
    case 'codex':
      return {
        mapNames: ['env', 'http_headers'],
        ref: REF_DOLLAR_BRACE,
        extra: codexOauth,
        files: [
          p.config && [p.config, () => loadToml(ctx, p.config)],
          p.projectConfig && [p.projectConfig, () => loadToml(ctx, p.projectConfig)],
        ],
      };
    case 'cursor':
      return {
        mapNames: ['env', 'headers'],
        ref: REF_CURSOR,
        extra: cursorAuth,
        files: [
          p.mcp && [p.mcp, () => loadJson(ctx, p.mcp, topLevel('mcpServers'))],
          p.projectMcp && [p.projectMcp, () => loadJson(ctx, p.projectMcp, topLevel('mcpServers'))],
        ],
      };
    case 'gemini':
      return {
        mapNames: ['env', 'headers'],
        ref: REF_GEMINI,
        files: [
          p.settings && [p.settings, () => loadJson(ctx, p.settings, topLevel('mcpServers'), { jsonc: true })],
          p.projectSettings && [
            p.projectSettings,
            () => loadJson(ctx, p.projectSettings, topLevel('mcpServers'), { jsonc: true }),
          ],
          // System settings can define MCP servers too (cursor-gemini.md).
          p.systemSettings && [
            p.systemSettings,
            () => loadJson(ctx, p.systemSettings, topLevel('mcpServers'), { jsonc: true }),
          ],
        ],
      };
    default:
      return null;
  }
}

function run(ctx) {
  const rows = [];
  for (const a of ctx.agents) {
    const spec = specs(ctx, a);
    if (!spec) continue;
    if (a.customConfigDir) {
      rows.push({
        agent: a.id,
        status: 'info',
        message: `${a.customConfigDir} is set; only the default config location was checked`,
      });
    }
    let servers = 0;
    let fails = 0;
    let bad = 0;
    const seen = new Set();
    for (const entry of spec.files) {
      if (!entry) continue;
      const [file, load] = entry;
      // cwd == home makes the user and project paths the same file.
      const resolved = path.resolve(file);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const res = load();
      if (res.state === 'bad') {
        bad++;
        rows.push({ agent: a.id, status: 'skip', message: `could not parse ${tilde(ctx, file)}` });
        continue;
      }
      for (const scope of res.scopes) {
        const r = scanServers(scope.servers, spec.mapNames, spec.ref, spec.extra);
        servers += r.count;
        const where = scope.label ? `${tilde(ctx, file)} (${scope.label})` : tilde(ctx, file);
        for (const f of r.found) {
          fails++;
          rows.push({
            agent: a.id,
            status: 'fail',
            message: `${where}: server '${f.server}' has a plaintext value in ${f.key}`,
            fix: FIX[a.id],
          });
        }
      }
    }
    if (fails === 0 && servers > 0 && bad === 0) {
      rows.push({ agent: a.id, status: 'pass', message: 'No plaintext secrets found in MCP server configs' });
    } else if (fails === 0 && bad === 0) {
      rows.push({ agent: a.id, status: 'skip', message: 'No MCP servers configured' });
    }
  }
  return rows;
}

export default {
  id: ID,
  title: 'Plaintext secrets in MCP configs',
  severity: 'medium',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
