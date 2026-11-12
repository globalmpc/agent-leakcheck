import { REPO_URL } from '../config.js';
import { agent } from './util.js';

const MIN = [2, 1, 317];
const MIN_TEXT = MIN.join('.');

function parse(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isOlder(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export default {
  id: 'cc-version',
  title: 'Claude Code is up to date',
  severity: 'medium',
  docs: [`${REPO_URL}#cc-version`],
  run(ctx) {
    const cc = agent(ctx, 'claude-code');
    if (!cc) return [{ agent: 'claude-code', status: 'skip', message: 'Claude Code is not installed.' }];
    const v = cc.version ? parse(cc.version) : null;
    if (!v) return [{ agent: 'claude-code', status: 'skip', message: 'Claude Code version is unknown.' }];
    if (isOlder(v, MIN)) {
      return [{
        agent: 'claude-code',
        status: 'fail',
        message: `Claude Code ${cc.version} is older than ${MIN_TEXT}, the first release that checks before your account email is sent to the network (anthropics/claude-code#107757).`,
        fix: 'Run `claude update` (native install) or `npm i -g @anthropic-ai/claude-code@latest`.',
      }];
    }
    return [{
      agent: 'claude-code',
      status: 'pass',
      message: `Claude Code ${cc.version} is at least ${MIN_TEXT}.`,
    }];
  },
};
