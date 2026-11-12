import path from 'node:path';
import { REPO_URL } from '../config.js';
import { agent, tilde } from './util.js';

const ID = 'cred-perms';
const WIN_MSG = 'File modes are not checked on Windows.';

// Stat only: the contents of a credential file are never opened.
function fileRow(ctx, agentId, file, missingMsg) {
  const st = ctx.read.stat(file);
  const name = tilde(ctx, file);
  if (!st || !st.isFile) return { agent: agentId, status: 'skip', message: missingMsg };
  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
    return {
      agent: agentId,
      status: 'fail',
      message: `${name} is readable by other users (mode ${mode}).`,
      fix: `chmod 600 ${name}`,
    };
  }
  return { agent: agentId, status: 'pass', message: `${name} is private to your user.` };
}

function customDirRow(a) {
  return {
    agent: a.id,
    status: 'info',
    message: `${a.customConfigDir} is set; only the default location was checked.`,
  };
}

function run(ctx) {
  const rows = [];
  const win = ctx.platform === 'win32';
  const cc = agent(ctx, 'claude-code');
  const cx = agent(ctx, 'codex');
  if (cc) {
    const file = path.join(cc.paths.dir, '.credentials.json');
    rows.push(
      win
        ? { agent: cc.id, status: 'skip', message: WIN_MSG }
        : fileRow(
            ctx,
            cc.id,
            file,
            `No ${tilde(ctx, file)} found; on macOS Claude Code keeps the login in the Keychain, so this is normal.`,
          ),
    );
    if (cc.customConfigDir) rows.push(customDirRow(cc));
  }
  if (cx) {
    const file = path.join(cx.paths.dir, 'auth.json');
    rows.push(
      win
        ? { agent: cx.id, status: 'skip', message: WIN_MSG }
        : fileRow(ctx, cx.id, file, `No ${tilde(ctx, file)} found.`),
    );
    if (cx.customConfigDir) rows.push(customDirRow(cx));
  }
  const git = path.join(ctx.home, '.git-credentials');
  rows.push(
    win
      ? { agent: 'system', status: 'skip', message: WIN_MSG }
      : fileRow(ctx, 'system', git, `No ${tilde(ctx, git)} found.`),
  );
  return rows;
}

export default {
  id: ID,
  title: 'Credential file permissions',
  severity: 'medium',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
