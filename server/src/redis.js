// Minimal Upstash Redis REST client (https://upstash.com/docs/redis/features/restapi).
// Errors are generic on purpose: the URL and token never appear in messages.

const TIMEOUT_MS = 5000;

/**
 * @param {{ url: string, token: string, fetch?: typeof fetch }} opts
 * @returns {{ pipeline: (cmds: Array<Array<string|number>>) => Promise<unknown[]>, multi: (cmds: Array<Array<string|number>>) => Promise<unknown[]> }}
 */
export function createRedisClient({ url, token, fetch = globalThis.fetch }) {
  if (typeof url !== 'string' || !url || typeof token !== 'string' || !token) {
    throw new Error('redis is not configured');
  }
  const base = url.replace(/\/+$/, '');

  async function send(path, cmds) {
    let results;
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('bad status');
      results = await res.json();
    } catch {
      throw new Error('redis request failed');
    }
    if (!Array.isArray(results) || results.length !== cmds.length || results.some((r) => !r || 'error' in r)) {
      throw new Error('redis request failed');
    }
    return results.map((r) => r.result);
  }

  return {
    /** Commands run in order, not atomically. */
    pipeline: (cmds) => send('/pipeline', cmds),
    /** Commands run as one transaction. */
    multi: (cmds) => send('/multi-exec', cmds),
  };
}
