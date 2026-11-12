// Safe, idempotent config edits. Writes happen only here; reads go through read.js.
// Every helper backs the file up first and does nothing (no backup) when no change is needed.
import fs from 'node:fs';
import { dirname } from 'node:path';
import * as read from './read.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Copy a file to `<path>.leakcheck-bak-<YYYYMMDDHHmmss>` (local time); `-1`, `-2`, ... is
 * appended if that name exists, so an earlier backup is never overwritten.
 * @param {string} path
 * @param {Date} [now]
 * @returns {string} backup path
 */
export function backupFile(path, now = new Date()) {
  const stamp =
    pad(now.getFullYear(), 4) + pad(now.getMonth() + 1) + pad(now.getDate()) +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  const base = `${path}.leakcheck-bak-${stamp}`;
  // Never overwrite an earlier backup: on a name clash append -1, -2, ...
  for (let i = 0; ; i++) {
    const backup = i === 0 ? base : `${base}-${i}`;
    try {
      fs.copyFileSync(path, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Load a strict-JSON object file. Missing file -> {}. Invalid or non-object -> null (refuse). */
function loadStrictJson(path) {
  if (!read.exists(path)) return {};
  const data = read.readJson(path);
  return isObject(data) ? data : null;
}

function commit(path, text, existed, now) {
  const backup = existed ? backupFile(path, now) : null;
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
  return backup;
}

const refused = (path, reason) => ({ path, changed: false, backup: null, reason });
const unchanged = (path) => ({ path, changed: false, backup: null });

/**
 * Add entries to a JSON array at keyPath, skipping ones already present.
 * Refuses (changes nothing) if the file is not valid strict JSON, so JSONC files are left alone.
 * @param {string} path
 * @param {string[]} keyPath
 * @param {any[]} entries
 * @param {{ now?: Date }} [opts]
 * @returns {{ path: string, changed: boolean, backup: string|null, reason?: string }}
 */
export function addJsonArrayEntries(path, keyPath, entries, { now } = {}) {
  const root = loadStrictJson(path);
  if (root === null) return refused(path, 'not valid strict JSON');
  let node = root;
  for (const key of keyPath.slice(0, -1)) {
    if (node[key] === undefined) node[key] = {};
    if (!isObject(node[key])) return refused(path, `${key} is not an object`);
    node = node[key];
  }
  const last = keyPath[keyPath.length - 1];
  if (node[last] === undefined) node[last] = [];
  if (!Array.isArray(node[last])) return refused(path, `${last} is not an array`);
  const missing = entries.filter((e) => !node[last].some((x) => same(x, e)));
  if (missing.length === 0 && read.exists(path)) return unchanged(path);
  node[last].push(...missing);
  const existed = read.exists(path);
  const backup = commit(path, `${JSON.stringify(root, null, 2)}\n`, existed, now);
  return { path, changed: true, backup };
}

/**
 * Set one key (nested via keyPath) in a strict-JSON object file.
 * @param {string} path
 * @param {string[]} keyPath
 * @param {any} value
 * @param {{ now?: Date }} [opts]
 * @returns {{ path: string, changed: boolean, backup: string|null, reason?: string }}
 */
export function setJsonKey(path, keyPath, value, { now } = {}) {
  const root = loadStrictJson(path);
  if (root === null) return refused(path, 'not valid strict JSON');
  let node = root;
  for (const key of keyPath.slice(0, -1)) {
    if (node[key] === undefined) node[key] = {};
    if (!isObject(node[key])) return refused(path, `${key} is not an object`);
    node = node[key];
  }
  const last = keyPath[keyPath.length - 1];
  const existed = read.exists(path);
  if (existed && same(node[last], value)) return unchanged(path);
  node[last] = value;
  const backup = commit(path, `${JSON.stringify(root, null, 2)}\n`, existed, now);
  return { path, changed: true, backup };
}

function tomlValue(v) {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/**
 * Set a top-level `key = value` line in a TOML file, before the first [table] header.
 * Refuses if the key appears inside any table, more than once, or has a multi-line value.
 * @param {string} path
 * @param {string} key bare key
 * @param {string|number|boolean} value
 * @param {{ now?: Date }} [opts]
 * @returns {{ path: string, changed: boolean, backup: string|null, reason?: string }}
 */
export function setTomlTopLevelKey(path, key, value, { now } = {}) {
  const existed = read.exists(path);
  const text = existed ? read.readText(path) : '';
  if (text === null) return refused(path, 'cannot read file');
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const header = lines.findIndex((l) => /^\s*\[/.test(l));
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bare, "quoted" and 'quoted' spellings of the same key.
  const keyRe = new RegExp(`^\\s*(?:${esc}|"${esc}"|'${esc}')\\s*=`);
  const hits = lines.map((l, i) => (keyRe.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length > 1) return refused(path, 'key appears more than once');
  const wanted = `${key} = ${tomlValue(value)}`;
  if (hits.length === 1) {
    const i = hits[0];
    if (header !== -1 && i > header) return refused(path, 'key is inside a table');
    const rhs = lines[i].slice(lines[i].indexOf('=') + 1).trim();
    if (/^("""|''')/.test(rhs) || (rhs.startsWith('[') && !rhs.includes(']'))) {
      return refused(path, 'multi-line value');
    }
    if (lines[i].trim() === wanted) return unchanged(path);
    lines[i] = wanted;
  } else if (header === -1) {
    lines.push(wanted);
  } else {
    let at = header;
    while (at > 0 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, wanted);
    if (at === header) lines.splice(at + 1, 0, '');
  }
  const backup = commit(path, `${lines.join('\n')}\n`, existed, now);
  return { path, changed: true, backup };
}

const registry = new Map();

/**
 * Register an automatic fix. describe(ctx, result) returns a one-line string, or null
 * when nothing needs doing. apply(ctx, result, { now }) returns a change
 * ({ path, what, backup }), a refusal ({ path, skipped: reason }), an array of them, or null. Both must be idempotent.
 * @param {string} id value of a result's `autoFix`
 * @param {{ describe: Function, apply: Function }} fix
 */
export function registerFix(id, fix) {
  registry.set(id, fix);
}

/**
 * Plan the fixes for failing results that name a registered autoFix.
 * @param {object} result runScan output
 * @param {object} ctx
 * @returns {Array<{ id: string, agent: string|null, description: string, result: object }>}
 */
export function planFixes(result, ctx) {
  const plan = [];
  const seen = new Set();
  for (const check of result.checks) {
    for (const r of check.results) {
      const fix = r.status === 'fail' && r.autoFix ? registry.get(r.autoFix) : null;
      const key = `${r.autoFix}|${r.agent}`;
      if (!fix || seen.has(key)) continue;
      seen.add(key);
      const description = fix.describe(ctx, r);
      if (description) plan.push({ id: r.autoFix, agent: r.agent ?? null, description, result: r });
    }
  }
  return plan;
}

/**
 * Apply a plan. A second run changes nothing and creates no backup.
 * @param {Array<object>} plan from planFixes
 * @param {object} ctx
 * @param {{ now?: Date }} [opts]
 * @returns {{ changed: Array<{ path: string, what: string, backup: string|null }>, skipped: Array<{ path: string, reason: string }> }}
 */
export function applyFixes(plan, ctx, { now = new Date() } = {}) {
  const changed = [];
  const skipped = [];
  for (const step of plan) {
    const out = registry.get(step.id).apply(ctx, step.result, { now });
    if (!out) continue;
    for (const c of Array.isArray(out) ? out : [out]) {
      if (c.skipped) skipped.push({ path: c.path, reason: c.skipped });
      else changed.push(c);
    }
  }
  return { changed, skipped };
}
