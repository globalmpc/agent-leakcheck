import path from 'node:path';
import { REPO_URL } from '../config.js';

const ID = 'ssh';
const EXCLUDE =
  /^(known_hosts.*|config(\..*)?|authorized_keys.*|environment|rc|allowed_signers)$|\.pub$|\.leakcheck-bak-|\.old$|\.bak$|~$/;

const quote = (n) => (/^[\w.@+-]+$/.test(n) ? n : `'${n.replace(/'/g, `'\\''`)}'`);

function candidates(ctx, dir) {
  const names = ctx.read.listDir(dir);
  const set = new Set(names);
  const out = [];
  for (const name of names.sort()) {
    if (EXCLUDE.test(name)) continue;
    const st = ctx.read.lstat(path.join(dir, name));
    if (!st || !st.isFile || st.isSymlink) continue;
    if (set.has(`${name}.pub`) || /^id_/.test(name) || /\.(pem|key)$/.test(name)) out.push({ name, st });
  }
  return out;
}

async function agentRow(ctx) {
  if (!ctx.envNames.includes('SSH_AUTH_SOCK')) return [];
  let n = null;
  try {
    n = await ctx.exec.sshAgentKeyCount();
  } catch {
    n = null;
  }
  if (!(n > 0)) return [];
  return [
    {
      agent: 'system',
      status: 'info',
      message: `ssh-agent holds ${n} key${n === 1 ? '' : 's'}; any agent that can run shell commands can use them (it cannot read them)`,
    },
  ];
}

async function run(ctx) {
  if (ctx.platform === 'win32') {
    return [{ agent: 'system', status: 'skip', message: 'Windows uses ACLs, not checked' }];
  }
  const dir = path.join(ctx.home, '.ssh');
  const keys = candidates(ctx, dir);
  const rows = [];
  if (keys.length === 0) {
    rows.push({ agent: 'system', status: 'skip', message: 'no SSH private keys found in ~/.ssh' });
  } else {
    const mine = (k) => ctx.uid === null || ctx.uid === undefined || k.st.uid === ctx.uid;
    const loose = keys.filter((k) => (k.st.mode & 0o077) !== 0);
    const bad = loose.filter(mine);
    for (const k of loose.filter((x) => !mine(x))) {
      rows.push({
        agent: 'system',
        status: 'info',
        message: `~/.ssh/${k.name} is owned by another user and readable by others; not checked further`,
      });
    }
    if (bad.length > 0) {
      rows.push({
        agent: 'system',
        status: 'fail',
        message: `SSH private keys readable by others: ${bad.map((k) => k.name).join(', ')}`,
        fix: `chmod 600 ${bad.map((k) => `~/.ssh/${quote(k.name)}`).join(' ')}`,
      });
    } else if (loose.length === 0) {
      rows.push({
        agent: 'system',
        status: 'pass',
        message: `${keys.length} SSH private key${keys.length === 1 ? '' : 's'} in ~/.ssh, all owner-only`,
      });
    }
  }
  rows.push(...(await agentRow(ctx)));
  return rows;
}

export default {
  id: ID,
  title: 'SSH private keys readable by others',
  severity: 'medium',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
