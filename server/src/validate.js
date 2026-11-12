import { CHECK_IDS, gradeFor } from './scoring.js';

const VERSION_RE = /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}([-+][0-9A-Za-z.-]{1,20})?$/;
const MAX_VERSION_LEN = 32;

export const OS_FAMILIES = ['macos', 'linux', 'windows', 'other'];
export const GRADES = ['A', 'B', 'C', 'D', 'F'];
export const AGENT_NAMES = ['claude-code', 'codex', 'cursor', 'gemini'];
export const VIAS = ['prompt', 'flag'];
const STATUSES = ['pass', 'fail', 'skip'];
const TOP_KEYS = ['v', 'os', 'grade', 'agents', 'checks', 'via'];

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function hasExactKeys(obj, keys) {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function isVersion(x) {
  return typeof x === 'string' && x.length <= MAX_VERSION_LEN && VERSION_RE.test(x);
}

function checkAgents(agents) {
  if (!Array.isArray(agents) || agents.length > 4) return 'agents invalid';
  const seen = new Set();
  for (const a of agents) {
    if (!isPlainObject(a) || !hasExactKeys(a, ['name', 'version'])) return 'agent shape invalid';
    if (!AGENT_NAMES.includes(a.name)) return 'agent name invalid';
    if (seen.has(a.name)) return 'agent duplicated';
    seen.add(a.name);
    if (a.version !== null && !isVersion(a.version)) return 'agent version invalid';
  }
  return null;
}

function checkChecks(checks) {
  if (!isPlainObject(checks)) return 'checks invalid';
  const ids = Object.keys(checks);
  if (ids.length === 0) return 'checks empty';
  for (const id of ids) {
    if (!CHECK_IDS.includes(id)) return 'check id invalid';
    if (!STATUSES.includes(checks[id])) return 'check status invalid';
  }
  if (ids.length !== CHECK_IDS.length) return 'checks incomplete';
  return null;
}

/**
 * Strictly validate a share payload. Reasons never echo input values.
 * @param {unknown} p parsed JSON body
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validatePayload(p) {
  const fail = (error) => ({ ok: false, error });
  if (!isPlainObject(p)) return fail('body must be an object');
  if (!hasExactKeys(p, TOP_KEYS)) return fail('unexpected or missing fields');
  if (!isVersion(p.v)) return fail('v invalid');
  if (!OS_FAMILIES.includes(p.os)) return fail('os invalid');
  if (!GRADES.includes(p.grade)) return fail('grade invalid');
  if (!VIAS.includes(p.via)) return fail('via invalid');
  const reason = checkAgents(p.agents) || checkChecks(p.checks);
  if (reason) return fail(reason);
  if (gradeFor(p.checks) !== p.grade) return fail('grade does not match checks');
  return { ok: true, value: p };
}
