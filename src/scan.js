import { computeScore } from './score.js';
import { VERSION } from './config.js';

/**
 * Check-level status: fail if any result fails, else pass, else info, else skip.
 * @param {Array<{status: string}>} results
 * @returns {'fail'|'pass'|'info'|'skip'}
 */
export function checkStatus(results) {
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.some((r) => r.status === 'pass')) return 'pass';
  if (results.some((r) => r.status === 'info')) return 'info';
  return 'skip';
}

function errorName(err) {
  const name = err && err.constructor && err.constructor.name;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

function cleanResult(r) {
  const out = { agent: r.agent ?? null, status: r.status, message: String(r.message ?? '') };
  if (r.fix) out.fix = String(r.fix);
  if (r.autoFix) out.autoFix = String(r.autoFix);
  return out;
}

async function runOne(check, ctx) {
  let results;
  try {
    const raw = await check.run(ctx);
    results = (Array.isArray(raw) ? raw : []).map(cleanResult);
  } catch (err) {
    // Only the error class name is reported: a message could contain data.
    results = [{ agent: null, status: 'skip', message: `check failed: ${errorName(err)}` }];
  }
  return {
    id: check.id,
    title: check.title,
    severity: check.severity,
    status: checkStatus(results),
    results,
  };
}

/**
 * Run all checks and build the `--json` result.
 * @param {object} ctx
 * @param {Array<object>} checks
 * @returns {Promise<object>}
 */
export async function runScan(ctx, checks) {
  const out = [];
  for (const check of checks) out.push(await runOne(check, ctx));
  const { score, grade } = computeScore(out);
  return {
    tool: 'agent-leakcheck',
    version: VERSION,
    grade,
    score,
    agents: ctx.agents.map((a) => ({ id: a.id, version: a.version ?? null })),
    checks: out,
  };
}
