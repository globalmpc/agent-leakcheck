/** Package version. A test asserts it equals package.json's version. */
export const VERSION = '0.1.0';

/** Public repository URL. */
export const REPO_URL = 'https://github.com/globalmpc/agent-leakcheck';

/** Brand shown in the human report banner (TTY only). */
export const BRAND_NAME = 'Global MPC';
export const BRAND_URL = 'globalmpc.tech';

// Production share endpoint (Vercel project must-company1/agent-leakcheck).
export const DEFAULT_ENDPOINT = 'https://agent-leakcheck.vercel.app';

/**
 * Share endpoint: AGENT_LEAKCHECK_ENDPOINT if set, else the default.
 * @returns {string}
 */
export function endpoint() {
  return process.env.AGENT_LEAKCHECK_ENDPOINT || DEFAULT_ENDPOINT;
}
