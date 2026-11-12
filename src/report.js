import { REPO_URL, BRAND_NAME, BRAND_URL } from './config.js';

// "GLOBAL MPC" in the figlet Calvin S font.
const BANNER_ART = [
  '╔═╗╦  ╔═╗╔╗ ╔═╗╦    ╔╦╗╔═╗╔═╗',
  '║ ╦║  ║ ║╠╩╗╠═╣║    ║║║╠═╝║  ',
  '╚═╝╩═╝╚═╝╚═╝╩ ╩╩═╝  ╩ ╩╩  ╚═╝',
];

const CODES = { red: 31, green: 32, yellow: 33, blue: 34, gray: 90, bold: 1 };
const GRADE_COLOR = { A: 'green', B: 'green', C: 'yellow', D: 'yellow', F: 'red' };

function painter(enabled) {
  return (color, text) => (enabled ? `\x1b[${CODES[color]}m${text}\x1b[0m` : text);
}

/**
 * Neutralise control characters (C0, DEL, C1) so names taken from config files
 * (MCP server names, hosts, paths) cannot move the cursor or hide report lines.
 * @param {unknown} s
 * @returns {string}
 */
function clean(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

function rowLines(r, tag, paint, tagColor) {
  const lines = [`  ${paint(tagColor, tag)} ${r.agent ? `${clean(r.agent)}: ` : ''}${clean(r.message)}`];
  if (r.fix) lines.push(`    Fix: ${clean(r.fix)}`);
  return lines;
}

/**
 * Human-readable report.
 * @param {object} result runScan output
 * @param {{ color?: boolean, banner?: boolean }} [opts] banner: print the brand banner first
 * @returns {string}
 */
export function formatHuman(result, { color = false, banner = false } = {}) {
  const paint = painter(color);
  const lines = [];
  if (banner) {
    for (const l of BANNER_ART) lines.push(`  ${paint('bold', l)}`);
    lines.push(`  ${paint('gray', `agent-leakcheck ${result.version} · by ${BRAND_NAME} · ${BRAND_URL}`)}`);
    lines.push('');
  }
  const grade = paint(GRADE_COLOR[result.grade] || 'bold', paint('bold', result.grade));
  lines.push(`agent-leakcheck: grade ${grade} (${result.score}/100)`);
  if (result.agents.length) {
    lines.push(result.agents.map((a) => clean(a.version ? `${a.id} ${a.version}` : a.id)).join(', '));
  }
  lines.push('');

  const notes = [];
  for (const c of result.checks) {
    const fails = c.results.filter((r) => r.status === 'fail');
    const infos = c.results.filter((r) => r.status === 'info');
    if (fails.length && c.severity !== 'warning' && c.severity !== 'info') {
      const tag = c.severity.toUpperCase();
      lines.push(`${paint('red', `[${tag}]`)} ${c.title}`);
      for (const r of fails) lines.push(...rowLines(r, 'fail', paint, 'red'));
      lines.push('');
    } else if (fails.length) {
      notes.push({ c, rows: fails, tag: 'warning', tagColor: 'yellow' });
    }
    if (infos.length) notes.push({ c, rows: infos, tag: 'info', tagColor: 'blue' });
  }
  for (const n of notes) {
    lines.push(`${paint(n.tagColor, `[${n.tag.toUpperCase()}]`)} ${n.c.title}`);
    for (const r of n.rows) lines.push(...rowLines(r, n.tag, paint, n.tagColor));
    lines.push('');
  }

  // A crashed check or an unparseable file must not look like a clean result.
  const problems = [];
  for (const c of result.checks) {
    for (const r of c.results) {
      if (r.status === 'skip' && /^(check failed: |could not parse )/i.test(r.message)) problems.push({ id: c.id, message: r.message });
    }
  }
  for (const p of problems) lines.push(`${paint('yellow', '[SKIPPED]')} ${p.id}: ${clean(p.message)}`);
  if (problems.length) lines.push('');

  const passed = result.checks.filter((c) => c.status === 'pass').map((c) => c.id);
  const skipped = result.checks.filter((c) => c.status === 'skip').length;
  lines.push(`Passed: ${passed.length ? passed.join(', ') : 'none'}`);
  lines.push(`Skipped: ${skipped} check${skipped === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(paint('gray', `agent-leakcheck ${result.version} · ${REPO_URL}`));
  return lines.join('\n');
}

/**
 * JSON output (pretty, trailing newline not included).
 * @param {object} result
 * @returns {string}
 */
export function formatJson(result) {
  return JSON.stringify({ schemaVersion: 1, ...result }, null, 2);
}
