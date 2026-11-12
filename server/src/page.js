import { CHECK_IDS } from './scoring.js';
import { GRADES } from './validate.js';

const REPO_URL = 'https://github.com/globalmpc/agent-leakcheck';
const DAYS = 14;

const CHECK_INFO = {
  'cc-version': ['Claude Code is up to date', 'Claude Code is older than 2.1.317.'],
  'env-deny': ['.env files are blocked for agents', 'An agent has no deny or ignore rule covering .env files.'],
  'risky-mode': ['No auto-approve default', 'An auto-approve, bypass or full-access mode is the default.'],
  'mcp-plaintext': ['MCP configs avoid literal secrets', 'An MCP server config holds a literal secret instead of an env reference.'],
  'mcp-autoapprove': ['Project MCP servers need approval', 'Claude Code approves every project MCP server without a prompt.'],
  'gh-token': ['GitHub CLI login is in the keyring', 'The GitHub CLI login is stored in a plain file instead of the OS keyring.'],
  ssh: ['SSH key permissions', 'A private key in ~/.ssh has permissions looser than 600.'],
  'cred-perms': ['Agent login files are private', 'An agent or git login file can be read by other users on the machine.'],
  'secret-env': ['Secret-looking environment variables', 'Exported variable names look like secrets (names only are inspected).'],
};

const CSS = `
:root{--bg:#fafaf8;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--bar:#3b6fd4;--bad:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1d1d1b;--line:#33332f;--bar:#6c9bf0;--bad:#fb923c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:28px 0 10px}
p{margin:6px 0}
a{color:var(--bar)}
.muted{color:var(--muted);font-size:.9rem}
.big{font-size:2.4rem;font-weight:700;line-height:1.1}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-wrap:anywhere}
.row{display:grid;grid-template-columns:2.2rem 1fr 3.4rem;gap:8px;align-items:center;margin:6px 0}
.row.day{grid-template-columns:3.2rem 1fr 3.4rem}
.row.day.ppl{grid-template-columns:3.2rem 1fr 3.4rem 3.4rem}
.track{background:var(--line);border-radius:4px;height:14px;overflow:hidden}
.fill{background:var(--bar);height:100%;min-width:0}
.fill.bad{background:var(--bad)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.check{margin:12px 0}
.check b{display:block}
ul{margin:6px 0;padding-left:20px}
footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line)}
`;

/**
 * Escape text for safe use in HTML content and attribute values.
 * @param {unknown} s
 * @returns {string}
 */
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bar(label, value, pct, bad, cls = '', extra = null) {
  const w = Math.max(0, Math.min(100, pct));
  const more = extra === null ? '' : `<span class="num">${esc(extra)}</span>`;
  return `<div class="row${cls}"><span>${esc(label)}</span><div class="track"><div class="fill${bad ? ' bad' : ''}" style="width:${w.toFixed(1)}%"></div></div><span class="num">${esc(value)}</span>${more}</div>`;
}

/** Last DAYS UTC days up to the stats date, zero-filled, oldest first. */
function daySection(s) {
  if (!s.byDay) return '';
  const end = s.generatedAt || Object.keys(s.byDay).sort().pop();
  if (!end) return '';
  const last = Date.parse(`${String(end).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(last)) return '';
  const days = Array.from({ length: DAYS }, (_, i) => new Date(last - (DAYS - 1 - i) * 86400000).toISOString().slice(0, 10));
  const max = Math.max(1, ...days.map((d) => s.byDay[d] || 0));
  const ppl = s.sharersByDay;
  const cls = ppl ? ' day ppl' : ' day';
  const head = ppl ? `<div class="row${cls} muted"><span></span><span></span><span class="num">shares</span><span class="num">people</span></div>` : '';
  const rows = days.map((d) => bar(d.slice(5), s.byDay[d] || 0, (100 * (s.byDay[d] || 0)) / max, false, cls, ppl ? ppl[d] || 0 : null)).join('');
  const note = ppl ? ' People: distinct sharers per day, estimated.' : '';
  return `<h2>Shares per day</h2><div class="card">${head}${rows}<p class="muted">Last ${DAYS} days, UTC.${note}</p></div>`;
}

function viaLine(s) {
  if (!s.via) return '';
  return `<p class="muted">From the prompt: ${esc(s.via.prompt || 0)}. With --share: ${esc(s.via.flag || 0)}.</p>`;
}

function gradeSection(s) {
  const rows = GRADES.map((g) => bar(g, s.grade[g] || 0, (100 * (s.grade[g] || 0)) / s.total)).join('');
  return `<h2>Grade distribution</h2><div class="card">${rows}</div>`;
}

function checkSection(s) {
  const items = CHECK_IDS.filter((id) => s.checks[id]).map((id) => {
    const c = s.checks[id];
    const rate = s.failRate[id];
    const [title, desc] = CHECK_INFO[id];
    const label = rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
    return `<div class="check"><b>${esc(title)}</b>${bar('', label, (rate || 0) * 100, true)}<span class="muted">${esc(desc)} Pass ${c.pass}, fail ${c.fail}, skip ${c.skip}.</span></div>`;
  });
  return `<h2>Fail rate per check</h2><div class="card">${items.join('')}</div>`;
}

function agentSection(s) {
  const names = Object.keys(s.agents).sort();
  if (!names.length) return '';
  const rows = names.map((n) => `<li>${esc(n)}: ${esc(s.agents[n])}</li>`).join('');
  return `<h2>Agents seen</h2><div class="card"><ul>${rows}</ul></div>`;
}

const SHARERS_NOTE = `<p class="muted">To count distinct sharers per day, a keyed hash of the IP address is added to a per-day counting sketch (HyperLogLog). The sketch gives only an estimated count, cannot list addresses and is deleted after 16 days. The IP address itself is never stored.</p>`;

const collected = (s) => `<h2>What is collected</h2><div class="card">
<ul>
<li>tool version</li>
<li>OS family</li>
<li>grade</li>
<li>agent name + version</li>
<li>pass/fail/skip per check id</li>
<li>how it was shared (prompt or --share)</li>
</ul>
<p>Never collected: file paths, secret values, usernames, hostnames, env var names, IP addresses (not stored).</p>
<p class="muted">Only counters are kept. Individual scans are not stored.</p>
${s.sharersByDay ? SHARERS_NOTE : ''}</div>`;

/**
 * Render the stats page. Server-rendered, no scripts, no external requests.
 * @param {object} s stats with derived failRate
 * @returns {string} HTML document
 */
export function renderPage(s) {
  const body = s.total === 0
    ? '<div class="card"><p>No shared scans yet.</p></div>'
    : daySection(s) + gradeSection(s) + checkSection(s) + agentSection(s);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-leakcheck stats</title><style>${CSS}</style></head>
<body><main>
<h1>agent-leakcheck stats</h1>
<p class="muted">Anonymous, opt-in results. <a href="${REPO_URL}">${REPO_URL}</a></p>
<h2>Total shared scans</h2><div class="big">${esc(s.total)}</div>
${s.total === 0 ? '' : viaLine(s)}
${body}
${collected(s)}
<footer><p class="muted">An open-source tool from <a href="https://globalmpc.tech">MPC</a>.</p></footer>
</main></body></html>`;
}
