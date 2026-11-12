import path from 'node:path';

/**
 * Path for messages: home-relative paths start with `~`, everything else is shown as is.
 * @param {{ home: string }} ctx
 * @param {string} p
 * @returns {string}
 */
export function tilde(ctx, p) {
  const rel = path.relative(ctx.home, p);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join('/')}`;
  return p;
}

/**
 * The detected agent with this id, or undefined.
 * @param {{ agents: Array<{id: string}> }} ctx
 * @param {string} id
 */
export function agent(ctx, id) {
  return ctx.agents.find((a) => a.id === id);
}
