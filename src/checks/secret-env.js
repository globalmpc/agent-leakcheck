import { REPO_URL } from '../config.js';
import { agent, tilde } from './util.js';

const ID = 'secret-env';
const SECRET =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PAT|APIKEY|API_KEY|ACCESS_KEY|AUTH_KEY|PRIVATE_KEY|CREDENTIALS?)(_|$)|_KEY$|^KEY$/i;
// CLAUDE_CODE_MESSAGING_TOKEN, ORCA_*: observed-local runtime-injected names (agent harness),
// not from docs. Exact names only: CLAUDE_CODE_OAUTH_TOKEN must still warn.
const IGNORE =
  /^(CLAUDE_CODE_MESSAGING_TOKEN|ORCA_AGENT_LAUNCH_TOKEN|ORCA_AGENT_HOOK_TOKEN|ORCA_PANE_KEY|SSH_AUTH_SOCK|GPG_AGENT_INFO|GPG_TTY|KEYTIMEOUT|TERM_SESSION_ID|SECURITYSESSIONID|XPC_.*|__CF.*|GIT_CONFIG_KEY_\d+)$|(^|_)(PUBLIC_KEY|KEYCHAIN)(_|$)|_(FILE|PATH|DIR)$/i;
const MAX_LISTED = 10;

function run(ctx) {
  const names = ctx.envNames.filter((n) => SECRET.test(n) && !IGNORE.test(n));
  if (names.length === 0) {
    return [{ agent: 'system', status: 'pass', message: 'No secret-looking environment variable names' }];
  }
  const shown = names.slice(0, MAX_LISTED).join(', ');
  const more = names.length > MAX_LISTED ? ` +${names.length - MAX_LISTED} more` : '';
  const rows = [
    {
      agent: 'system',
      status: 'fail',
      message: `${names.length} environment variable${names.length === 1 ? ' looks' : 's look'} like secrets; every agent started from this shell inherits them (${shown}${more})`,
      fix: 'Keep them out of your shell profile and load them only for the command that needs them (for example a secrets manager or a per-project direnv .envrc).',
    },
  ];
  const codex = agent(ctx, 'codex');
  if (codex) {
    const file = codex.paths && codex.paths.config ? tilde(ctx, codex.paths.config) : '~/.codex/config.toml';
    rows.push({
      agent: 'codex',
      status: 'info',
      message:
        'Codex passes your full environment to the commands it runs unless [shell_environment_policy] says otherwise',
      fix: `Add to ${file}: [shell_environment_policy] with ignore_default_excludes = false (drops names containing KEY, SECRET or TOKEN); use exclude = ["NAME"] for others.`,
    });
  }
  return rows;
}

export default {
  id: ID,
  title: 'Secret-looking environment variables',
  severity: 'warning',
  docs: [`${REPO_URL}#${ID}`],
  run,
};
