// The ONLY module allowed to use the network. Opt-in sharing of grade + pass/fail per check.
import { VERSION } from './config.js';

const OS_MAP = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]{1,20})?$/;
const MAX_AGENTS = 4;

function cleanVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
}

function shareStatus(check) {
  if (check.status === 'fail') return 'fail';
  if (check.status === 'pass') return 'pass';
  return 'skip';
}

/**
 * The exact payload that would be shared. Nothing else is ever sent.
 * @param {object} result runScan output
 * @param {string} platform process.platform value
 * @param {'prompt'|'flag'} [via] how sharing was chosen: the y/N prompt or the --share flag
 * @returns {{ v: string, os: string, grade: string, agents: Array<{name: string, version: string|null}>, checks: Record<string,string>, via: string }}
 */
export function buildPayload(result, platform, via = 'flag') {
  const checks = {};
  for (const c of result.checks) {
    if (c.severity === 'info') continue;
    checks[c.id] = shareStatus(c);
  }
  return {
    v: VERSION,
    os: OS_MAP[platform] || 'other',
    grade: result.grade,
    agents: result.agents.slice(0, MAX_AGENTS).map((a) => ({
      name: a.id,
      version: cleanVersion(a.version),
    })),
    checks,
    via: via === 'prompt' ? 'prompt' : 'flag',
  };
}

function isCount(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * POST the payload. Never throws.
 * @param {object} payload from buildPayload
 * @param {string} endpoint base URL
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ok: true, total: number, betterThan: number} | {ok: false, reason: string}>}
 */
export async function sendPayload(payload, endpoint, { timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const body = await res.json();
    if (!body || body.ok !== true || !isCount(body.total) || !isCount(body.betterThan)) {
      return { ok: false, reason: 'unexpected response' };
    }
    return { ok: true, total: body.total, betterThan: body.betterThan };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'network error' };
  }
}
