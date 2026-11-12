// Ordered list of checks. To add one:
//   1. create src/checks/<id>.js with a default export { id, title, severity, docs, run(ctx) }
//   2. import it below and add it to the array.
//
import ccVersion from './cc-version.js';
import envDeny from './env-deny.js';
import riskyMode from './risky-mode.js';
import mcpPlaintext from './mcp-plaintext.js';
import mcpAutoapprove from './mcp-autoapprove.js';
import ghToken from './gh-token.js';
import ssh from './ssh.js';
import credPerms from './cred-perms.js';
import secretEnv from './secret-env.js';
import training from './training.js';

export default [
  ccVersion,
  envDeny,
  riskyMode,
  mcpPlaintext,
  mcpAutoapprove,
  ghToken,
  ssh,
  credPerms,
  secretEnv,
  training,
];
