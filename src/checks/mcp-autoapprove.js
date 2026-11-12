import path from 'node:path';
import { REPO_URL } from '../config.js';
import { agent, tilde } from './util.js';

const ID = 'mcp-autoapprove';
const KEY = 'enableAllProjectMcpServers';

// 'missing' | 'bad' | 'ok' with the flag state; only the boolean is read, never other values.
function load(ctx, file) {
  if (!ctx.read.exists(file)) return { state: 'missing', on: false };
  const data = ctx.read.readJson(file, { jsonc: true });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { state: 'bad', on: false };
  return { state: 'ok', on: data[KEY] === true };
}

function run(ctx) {
  const cc = agent(ctx, 'claude-code');
  if (!cc) return [];
  const p = cc.paths;
  const rows = [];
  const seen = new Set();
  let fails = 0;
  let bad = 0;
  for (const [kind, file] of [
    ['user', p.userSettings],
    ['local', p.localSettings],
    ['project', p.projectSettings],
  ]) {
    // With cwd == home the project file is the user file: check each file once.
    const resolved = path.resolve(file);
    if (kind === 'project') {
      if (seen.has(resolved)) continue;
    } else {
      seen.add(resolved);
    }
    const { state, on } = load(ctx, file);
    const name = tilde(ctx, file);
    if (state === 'bad') {
      if (kind !== 'project') bad++;
      rows.push({ agent: cc.id, status: 'skip', message: `Could not parse ${name}, so it was not checked.` });
    } else if (on && kind === 'project') {
      rows.push({
        agent: cc.id,
        status: 'info',
        message: `${name} sets ${KEY}; Claude Code ignores it until the folder is trusted, so only user and local settings are graded.`,
      });
    } else if (on) {
      fails++;
      rows.push({
        agent: cc.id,
        status: 'fail',
        message: `${name} sets ${KEY} to true: every server in a project's .mcp.json is approved without a prompt.`,
        fix: `Set ${KEY} to false (or remove it) in ${name}, and list the servers you trust in enabledMcpjsonServers.`,
      });
    }
  }
  if (fails === 0 && bad === 0) {
    rows.push({ agent: cc.id, status: 'pass', message: 'Project MCP servers are not approved automatically.' });
  }
  if (cc.customConfigDir) {
    rows.push({
      agent: cc.id,
      status: 'info',
      message: `${cc.customConfigDir} is set; only the default config location was checked.`,
    });
  }
  return rows;
}

export default {
  id: ID,
  title: 'Project MCP servers approved without a prompt',
  severity: 'medium',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
