import path from 'node:path';
import { REPO_URL } from '../config.js';
import { tilde } from './util.js';

const ID = 'gh-token';
const HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

function hostsFile(ctx) {
  return ctx.platform === 'win32'
    ? path.join(ctx.home, 'AppData', 'Roaming', 'GitHub CLI', 'hosts.yml')
    : path.join(ctx.home, '.config', 'gh', 'hosts.yml');
}

// Key-only walk of hosts.yml. Values are never kept, only whether a token value is non-empty.
function walk(text) {
  const hosts = [];
  const withToken = new Set();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const top = line.match(/^(["']?)([^\s#"':][^"':]*)\1:\s*(#.*)?$/);
    if (top) {
      current = HOST_RE.test(top[2]) ? top[2] : null;
      if (current && !hosts.includes(current)) hosts.push(current);
      continue;
    }
    if (/^\S/.test(line)) {
      current = null;
      continue;
    }
    const tok = line.match(/^\s+oauth_token:\s*(.*)$/);
    if (tok && current) {
      const v = tok[1].trim();
      if (v !== '' && !v.startsWith('#') && !/^(""|''|null|~)\s*(#.*)?$/.test(v)) withToken.add(current);
    }
  }
  return { hosts, withToken };
}

function run(ctx) {
  const rows = [];
  for (const name of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (ctx.envNames.includes(name)) {
      rows.push({
        agent: 'system',
        status: 'info',
        message: `${name} is set; only the default gh config location was checked`,
      });
    }
  }
  const file = hostsFile(ctx);
  const shown = tilde(ctx, file);
  const text = ctx.read.exists(file) ? ctx.read.readText(file) : null;
  if (text === null) {
    rows.push({ agent: 'system', status: 'skip', message: `${shown} not found; gh is not set up here` });
    return rows;
  }
  const { hosts, withToken } = walk(text);
  if (hosts.length === 0) {
    rows.push({ agent: 'system', status: 'skip', message: `no hosts listed in ${shown}` });
    return rows;
  }
  for (const host of hosts) {
    if (!withToken.has(host)) continue;
    rows.push({
      agent: 'system',
      status: 'fail',
      message: `gh stores a token for ${host} in ${shown} instead of the system keyring`,
      fix: `Run \`gh auth logout --hostname ${host}\` then \`gh auth login --hostname ${host}\` (stores it in the keyring when one is available).`,
    });
  }
  if (withToken.size === 0) {
    rows.push({ agent: 'system', status: 'pass', message: `${shown} has no token; gh keeps it outside the file` });
  }
  return rows;
}

export default {
  id: ID,
  title: 'GitHub CLI token stored in a plain file',
  severity: 'medium',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
