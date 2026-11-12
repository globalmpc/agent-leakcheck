import * as read from './read.js';
import * as defaultExec from './exec.js';
import { detectAgents } from './detect.js';

/**
 * Build the context handed to every check. Env values are never stored: names only.
 * `systemRoot` is the root for absolute system paths (tests point it at a temp dir).
 * @param {{ home: string, cwd: string, platform: string, env: Record<string,string|undefined>, exec?: object, uid?: number|null, systemRoot?: string }} opts
 * @returns {Promise<object>}
 */
export async function buildContext({
  home,
  cwd,
  platform,
  env,
  exec = defaultExec,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  systemRoot = '/',
}) {
  const ctx = { home, cwd, platform, uid, systemRoot, envNames: Object.keys(env), read, exec, agents: [] };
  ctx.agents = await detectAgents(ctx);
  return ctx;
}
