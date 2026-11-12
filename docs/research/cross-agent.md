# Cross-agent checks and packaging: verified facts

Fetched 2026-11-12. Statuses: `verified-doc`, `verified-source`, `observed-local`, `unverified`.
Local observations are key names / modes / counts only; no values were read.

## 1. GitHub CLI token storage (`gh-token`)

| Fact | Source | Status |
|---|---|---|
| Config dir precedence: `GH_CONFIG_DIR`, then `XDG_CONFIG_HOME/gh`, then (Windows only) `%AppData%\GitHub CLI`, then `~/.config/gh`. No macOS-specific path. | https://github.com/cli/go-gh/blob/trunk/pkg/config/config.go ("Config path precedence: GH_CONFIG_DIR, XDG_CONFIG_HOME, AppData (windows only), HOME."); https://cli.github.com/manual/gh_help_environment | verified-source + verified-doc |
| Hosts file is `<config dir>/hosts.yml`. | go-gh `config.go` (`filepath.Join(ConfigDir(), "hosts.yml")`) | verified-source |
| Keys in `hosts.<host>`: `git_protocol`, `user` (active user), `users` (map user -> {...}), `oauth_token` (active token, plaintext only). Per-user plaintext token: `hosts.<host>.users.<user>.oauth_token`. | https://github.com/cli/cli/blob/trunk/internal/config/config.go (constants `oauthTokenKey`, `userKey`, `usersKey`, `gitProtocolKey`) | verified-source |
| On login gh first tries the keyring (service `gh:<host>`, account = username). Only if secure storage is off or the keyring write fails does it write `oauth_token` to the file. | same file (`login`, `keyringServiceName`) | verified-source |
| Token lookup order: env vars (`GH_TOKEN`, `GITHUB_TOKEN`), config `oauth_token`, per-user keyring, `users.<user>.oauth_token`. | same file (`ActiveToken`, `TokenForUser`) | verified-source |
| Keyring became the default for `gh auth login` in v2.26.0 (release dated 04 Apr; year not shown on the page, so 2023 is inferred from search results). "your credentials will now be stored in your operating system's credential storage instead of directly on disk." | https://github.com/cli/cli/releases/tag/v2.26.0 | verified-doc (year: unverified) |
| `--insecure-storage` flag: "Save authentication credentials in plain text instead of credential store". Doc also says gh falls back to a plain text file if no credential store is found or it fails. | https://cli.github.com/manual/gh_auth_login | verified-doc |
| Backends: macOS Keychain, GNOME Keyring (Secret Service), Windows Credential Manager. | https://github.com/cli/cli/pull/7043 (via search; page not opened) | unverified |
| This machine (gh 2.96.0): `~/.config/gh/hosts.yml` mode 600, keys: `github.com:` > `git_protocol`, `users` > `<one username>` (empty map), `user`. No `oauth_token` anywhere = keyring. Env `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` unset. | local | observed-local |

How to tell plaintext vs keyring from key names only:
- Any `oauth_token` key under `hosts.<host>` or `hosts.<host>.users.<user>` = plaintext token in the file (fail).
- No `oauth_token` key but a `user` / `users` entry = logged in, token not in the file (pass; assumed keyring). The scan cannot prove the keyring entry exists; say "not in the file".
- No `hosts` or no host entries = not logged in via the file (skip / pass "gh not logged in").
- Token supplied via `GH_TOKEN` / `GITHUB_TOKEN` is not in the file. That is an env name matter for `secret-env`, not `gh-token`.

Fix commands (text only, never auto-run, never print the token):
```
gh auth logout --hostname github.com          # per account; add --user NAME if several
gh auth login --hostname github.com           # default stores in the OS keyring (>= v2.26.0)
```
`gh auth login` has no "migrate" mode, so the user must log out and in again. Older gh (< 2.26.0): upgrade gh first. `gh auth status` shows the storage ("(keyring)" vs the file path) in recent versions: unverified, do not rely on it.

## 2. SSH key permissions (`ssh`)

| Fact | Source | Status |
|---|---|---|
| ssh refuses a private key when `st.st_uid == getuid()` and `(st.st_mode & 077) != 0`, i.e. any group or other bit set. Message: "WARNING: UNPROTECTED PRIVATE KEY FILE!". Files owned by another user are not checked by this function. It does not test for a regular file. | https://github.com/openssh/openssh-portable/blob/master/authfile.c (`sshkey_perm_ok`) | verified-source |
| So 600 and 400 pass; 640, 644, 660, 604 fail. 700 passes (owner bits free). SPEC's "looser than 600" = `mode & 0o077 !== 0`. | derived from the line above | verified-source |
| `ssh-add -l`: "Lists fingerprints of all identities currently represented by the agent." Exit status: 0 success, 1 command failed, 2 "unable to contact the authentication agent". | https://man.openbsd.org/ssh-add | verified-doc |
| `SSH_AUTH_SOCK` "Identifies the path of a Unix-domain socket used to communicate with the agent"; it must be set for ssh-add to work. | https://man.openbsd.org/ssh-add | verified-doc |
| Empty agent: exit 1 and ONE line of output ("The agent has no identities."). So counting output lines gives 1 for an empty agent. Use the exit code: only count lines when exit is 0. The man page does not state this; observed here. | local run (`ssh-add -l \| wc -l` printed 1, exit 1) | observed-local |
| This machine: OpenSSH_10.3p1. `~/.ssh` is 700. 4 private keys, all 600, each with a `.pub` sibling (644). `config` 644, `known_hosts`, `known_hosts.old` 600, 2 subdirectories. `SSH_AUTH_SOCK` set; agent has no identities (exit 1). | `ls -l ~/.ssh`, `ssh-add -l` | observed-local |

Finding private keys without opening files. Candidate = regular file (use `lstat`; skip symlinks, dirs, sockets) in the top level of `~/.ssh` only, not recursive, that is not excluded, AND one of:
1. has a sibling `<name>.pub`; or
2. name matches `^id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)$` (any `id_*` without `.pub`); or
3. name ends in `.pem` or `.key`.

Exclude: `*.pub`, `known_hosts*`, `config`, `config.*`, `authorized_keys*`, `environment`, `rc`, `allowed_signers`, `*.leakcheck-bak-*`, `*.old`, `*.bak`, `*~`, sockets, directories, symlinks.
Known gap: a key with no `.pub`, no `id_` prefix and no `.pem/.key` extension (e.g. `must` without `must.pub`) is not found. Accept; the spec forbids opening files to sniff headers.
`ssh_config` `IdentityFile` entries pointing elsewhere are out of scope for P1 (would need to parse `config`; skip).

Windows: OpenSSH on Windows checks ACLs, not mode bits. Skip with reason "Windows uses ACLs, not checked" (the Node mode bits are meaningless there). `unverified` which exact ACL rule Windows OpenSSH applies.

## 3. `secret-env` name rule

No doc source (a heuristic). Tested locally against this machine's 93 env names: matches 4 names ending in `_TOKEN` or `_KEY` (all plausibly real), and nothing else after exclusions. Without exclusions `GIT_CONFIG_KEY_0/1` and `SSH_AUTH_SOCK` also hit. Status: observed-local.

Tested with `PATH`, `PATHEXT`, `KEYTIMEOUT`, `GIT_CONFIG_KEY_0` (no match) and `GITHUB_PAT`, `NPM_TOKEN`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `MY_APIKEY`, `DB_PASSWORD`, `GOOGLE_APPLICATION_CREDENTIALS` (match).

## 4. Training-data reminders (`training`)

| Provider | Fact | Source | Status |
|---|---|---|---|
| Claude consumer | Setting is called "Model Improvement" in Privacy Settings (older UI text: "Help improve Claude"; the current page does not use that label). URL: https://claude.ai/settings/data-privacy-controls. Covers Free, Pro, Max and Claude Code on those accounts. | https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training ("You choose to allow us to use your chats and coding sessions to improve Claude.") | verified-doc |
| Claude commercial | Claude for Work and the Anthropic API are governed by a separate article; the page above does not describe the rules. Say "API keys and Claude for Work are covered by commercial terms, not this toggle" only as "see Anthropic's commercial terms". | same page | verified-doc (rules themselves: unverified) |
| ChatGPT | Toggle "Improve the model for everyone", web: account menu > Settings > Data controls. Off = new conversations not used for training, chats stay in history. Thumbs up/down feedback may still send the whole conversation. Business/Enterprise/Edu are not trained on by default. | https://help.openai.com/en/articles/7730893-data-controls-faq (search snippets; the page itself returned 403 to fetch) | verified-doc (via search snippet) |
| Codex | OpenAI help says ChatGPT training data controls cover content processed through Codex (search snippet, article 11369540). The Codex auth page says sign-in method "determines which admin controls and data-handling policies apply": ChatGPT sign-in follows the ChatGPT workspace, API-key sign-in follows the API organization's data-sharing settings. It does not itself mention training. Also: Codex caches login in a plaintext file by default (`~/.codex/auth.json`) unless an OS credential store is configured. | https://learn.chatgpt.com/docs/auth (redirect from developers.openai.com/codex/auth); https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan | verified-doc (Codex-covered claim: snippet only, article 403) |
| Gemini apps | Setting "Keep Activity" in Gemini Apps Activity; off = future chats not used to train AI models (except sent feedback). URL: https://myactivity.google.com/product/gemini | https://support.google.com/gemini/answer/13594961 | verified-doc |
| Gemini CLI | IMPORTANT: on 2026-06-18 Gemini CLI and Code Assist IDE extensions stopped serving Google AI Pro/Ultra and free Gemini Code Assist for individuals requests (moved to Antigravity CLI). Gemini CLI remains for paid Gemini / Enterprise Agent Platform API keys and Code Assist Standard/Enterprise. So the "Code Assist for individuals privacy notice" no longer applies to most Gemini CLI users; that notice page (https://developers.google.com/gemini-code-assist/resources/privacy-notice-gemini-code-assist-individuals) did not state an opt-out. | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli | verified-doc |
| Cursor | "Privacy Mode" in Cursor settings: "Customer Data will not be used for training by Cursor"; zero data retention agreements with providers (may be stored if abuse detectors trigger). Own-API-key use is excluded (search snippet). Exact settings path (Cursor Settings > General) from a search snippet only. | https://cursor.com/data-use | verified-doc (path: unverified) |

Not found: official Gemini CLI privacy page for API-key users (training use of the free API tier); Cursor's old docs URL docs.cursor.com/account/privacy now redirects to cursor.com/docs (404 on the new path).

## 5. Claude Code plugin and marketplace

| Fact | Source | Status |
|---|---|---|
| `plugin.json` lives at `.claude-plugin/plugin.json`; the manifest is optional; `name` is the only required key (kebab-case); `description`, `version`, `author`, `license`, `repository`, `homepage` optional; unknown top-level keys are stripped with a validate warning. | https://code.claude.com/docs/en/plugins-reference | verified-doc |
| Layout: `skills/<name>/SKILL.md`; `commands/` = flat `.md` files, "Prefer `skills/` for new plugins"; skills/commands/hooks sit at the plugin root, NOT inside `.claude-plugin/`. | same | verified-doc |
| Plugin skills are namespaced `/plugin-name:skill-name`. | https://code.claude.com/docs/en/skills | verified-doc |
| SKILL.md frontmatter: `description` recommended; `name` (defaults to dir name), `when_to_use`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `context`, `paths` etc. Unknown fields ignored. | https://code.claude.com/docs/en/skills | verified-doc |
| `plugin.json` `name` must not start with `claude-` / `anthropic-`; `agent-leakcheck` is fine. | plugins-reference | verified-doc |
| `marketplace.json` at `.claude-plugin/marketplace.json` requires `name`, `owner` (object, `name`), `plugins[]`; each entry needs `name` and `source`; relative `source` is written from the marketplace root, e.g. `"./plugins/my-first-plugin"`, no `..`. Entry `name` must equal the plugin's manifest name. | https://code.claude.com/docs/en/plugin-marketplaces | verified-doc |
| Install: shell `claude plugin marketplace add <owner>/<repo>`, `claude plugin install <plugin>@<marketplace>`; in a session `/plugin marketplace add <owner>/<repo>` and `/plugin install <plugin>@<marketplace>`. | same | verified-doc |
| Validate: `claude plugin validate <dir>` for a plugin dir or a marketplace dir; `--strict` makes warnings fail. Not run here (would need a local `claude` build and the files). | plugins-reference, plugin-marketplaces | verified-doc |
| Marketplace `name` must not be a reserved official name (e.g. `claude-plugins-official`); pick a unique one. | plugin-marketplaces | verified-doc |

Note: the repo's marketplace root is the repo root, so the entry's `source` is `./plugin` (folder `plugin/`).

### Ready-to-copy files

`plugin/.claude-plugin/plugin.json`
```json
{
  "name": "agent-leakcheck",
  "version": "0.1.0",
  "description": "Scan what your coding agents can reach (.env files, plaintext tokens, SSH keys, risky modes) with agent-leakcheck.",
  "author": { "name": "MPC" },
  "homepage": "https://github.com/globalmpc/agent-leakcheck",
  "repository": "https://github.com/globalmpc/agent-leakcheck",
  "license": "MIT",
  "keywords": ["security", "privacy", "audit"]
}
```

`.claude-plugin/marketplace.json` (repo root)
```json
{
  "name": "agent-leakcheck",
  "description": "agent-leakcheck: audit what your coding agents can reach",
  "owner": { "name": "MPC" },
  "plugins": [
    {
      "name": "agent-leakcheck",
      "source": "./plugin",
      "description": "Run agent-leakcheck from Claude Code and get a plain summary of the findings."
    }
  ]
}
```

`plugin/skills/leakcheck/SKILL.md` (invoked as `/agent-leakcheck:leakcheck`)
```markdown
---
description: Scan this machine for what coding agents (Claude Code, Codex, Cursor, Gemini CLI) can reach, such as .env files, plaintext tokens, loose SSH key permissions and risky approval modes. Use when the user asks to run agent-leakcheck, audit agent security or check for leaked secrets.
allowed-tools: Bash(npx -y agent-leakcheck@latest --json)
---

Run `npx -y agent-leakcheck@latest --json` and read the JSON from stdout.

Then tell the user, in plain words:
1. The grade and score.
2. Each failing check: what it means, which agent, and the `fix` text from the output.
3. Info and warning rows (for example secret-looking env var names) in one short list.

Rules:
- Never run `--fix` or `--share` unless the user explicitly asks for it in this conversation. If they ask for `--fix`, show the planned changes first and wait for a clear yes.
- Never print, guess or ask for secret values. The tool only reports names and paths.
- Do not edit config files yourself to apply fixes; give the fix text and let the user decide.
- If `npx` is missing or the command fails, show the error as is and stop.
```
(`allowed-tools` pre-approves only that exact command; `--fix` and `--share` stay behind a normal permission prompt.)

## 6. shields.io static badge

| Fact | Source | Status |
|---|---|---|
| Path form `https://img.shields.io/badge/<label>-<message>-<color>`; `-` in text written `--`; `_` written `__`; space written `_` or `%20`. Colors: hex, rgb(a), hsl(a), CSS named colors (some differ from CSS). `?style=flat\|flat-square\|plastic\|for-the-badge\|social`. | https://shields.io/badges/static-badge | verified-doc |
| Full named-color list (`brightgreen`, `green`, `yellowgreen`, `yellow`, `orange`, `red`, `blue`, `lightgrey`...) is in the badge-maker readme, not opened. | - | unverified |

Proposed badge (hex avoids named-color ambiguity; no `#` in the path):
`https://img.shields.io/badge/agent--leakcheck-B-yellowgreen` (label `agent-leakcheck` -> `agent--leakcheck`).

| Grade | Color |
|---|---|
| A | `2ea44f` |
| B | `97ca00` |
| C | `dfb317` |
| D | `fe7d37` |
| F | `e05d44` |

README line printed by `--badge`:
`[![agent-leakcheck: B](https://img.shields.io/badge/agent--leakcheck-B-97ca00)](https://github.com/globalmpc/agent-leakcheck)`
Static URL, so no network from the CLI; shields.io fetches it when the README renders.

---

# Proposed rules

All four are read-only and have no `autoFix`. Messages may name a path and a key name, never a value.

## `gh-token` (medium)

Files: path = `GH_CONFIG_DIR` env (name exists in `ctx.envNames` but its value is unreadable by rule 6, so P1 cannot honour it: decide below), else `XDG_CONFIG_HOME/gh`, else Windows `%AppData%\GitHub CLI`, else `<home>/.config/gh`; file `hosts.yml`.
Decision needed: rule 6 gives names only, so `GH_CONFIG_DIR` / `XDG_CONFIG_HOME` / `AppData` values are unavailable. Proposal: add one narrow `ctx.envPaths` (those three values only, they are paths not secrets), or check only `<home>/.config/gh` and, on Windows, `<home>\AppData\Roaming\GitHub CLI`. Recommended: the second, plus an info line if `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` is in `ctx.envNames` ("custom gh config dir not scanned").
Parse (in memory, keys only): lightweight indent-based YAML key walk; do not keep values. Find `oauth_token` keys at depth under `hosts.<host>` and `hosts.<host>.users.<user>`.
- skip: no file, or no `hosts` key ("gh not logged in").
- fail: any `oauth_token` key found. Message: `GitHub CLI token is stored in plain text in <path> (host <host>).` Fix: `gh auth logout --hostname <host>` then `gh auth login --hostname <host>`; recent gh stores it in the OS keyring. Never print the token.
- pass: host entries exist, no `oauth_token` key. Message: `No token in <path>; gh keeps it outside the file (OS keyring).`
Agent: `agent` field not tied to one agent; use `claude-code`-style fan-out? Recommended: single result with `agent: 'all'` is not in the type; instead report once under the first detected agent.

## `ssh` (medium)

Files: `<home>/.ssh` listing via `read.listDir`, `stat` each candidate (never open). Skip on `ctx.platform === 'win32'` ("Windows uses ACLs, not checked").
Logic: candidates per section 2; `bad = (st.mode & 0o077) !== 0` and `st.uid === process.getuid()` (if uid not available in stat, skip that part).
- skip: no `~/.ssh`, or Windows, or no candidate keys.
- fail: one or more bad. Message: `SSH private key <name> is readable by other users (mode <octal>); ssh refuses keys like this.` Fix: `chmod 600 ~/.ssh/<name>`. List names, modes only.
- pass: keys found, all fine ("N private keys, all owner-only").
- agent: `ssh-add -l` via `ctx.exec('ssh-add', ['-l'])` only if `SSH_AUTH_SOCK` is in `ctx.envNames`. Exit 0: count lines, add an `info` row `N keys loaded in ssh-agent (any process of yours can sign with them)`. Exit 1 ("no identities") or 2 (no agent) or exec error: no row. Never print fingerprints or key comments (they can contain an email).
- Also info (optional): `~/.ssh` itself looser than 700 is not checked by ssh-keygen docs we verified; leave out.

## `secret-env` (warning)

Input: `ctx.envNames` only.
```js
const SECRET = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PAT|APIKEY|API_KEY|ACCESS_KEY|AUTH_KEY|PRIVATE_KEY|CREDENTIALS?)(_|$)|_KEY$|^KEY$/;
const IGNORE = /^(SSH_AUTH_SOCK|GPG_AGENT_INFO|GPG_TTY|KEYTIMEOUT|TERM_SESSION_ID|SECURITYSESSIONID|XPC_.*|__CF.*|GIT_CONFIG_KEY_\d+)$|(^|_)(PUBLIC_KEY|KEYCHAIN)(_|$)|_(FILE|PATH|DIR)$/;
// test on name.toUpperCase()
```
- pass: no matches. skip: never.
- fail (status `fail`, severity warning, no score change): `N exported environment variables look like secrets: A, B, C (names only). Any agent you start inherits them.` Fix: `Remove them from your shell profile and load them per command (for example a secrets manager or a direnv .envrc in the project) instead of exporting them globally.` Cap the listed names at 10, then "and N more".
- Share payload: reports `fail` when it would warn; names are never sent.
Caveat: the `_FILE|_PATH|_DIR` exclusion hides `GOOGLE_APPLICATION_CREDENTIALS` style names only when they end that way; `GOOGLE_APPLICATION_CREDENTIALS` itself still matches (it holds a path, so it is a mild false positive but still sensitive). Keep.

## `training` (info)

Never pass or fail; one `info` row per product that is installed or detected, else a single generic row. No network, no file reads. Suggested text, one line each, with the link:
- Claude: `Claude (consumer accounts): check Settings > Privacy > "Model Improvement" - https://claude.ai/settings/data-privacy-controls. API and Claude for Work are covered by commercial terms, not this toggle.`
- ChatGPT / Codex: `ChatGPT: Settings > Data controls > "Improve the model for everyone" - https://help.openai.com/en/articles/7730893-data-controls-faq . Codex signed in with ChatGPT follows your ChatGPT workspace; with an API key it follows your API organization's data-sharing settings.` (Do not state that the toggle covers Codex as fact; the official snippet says training controls apply to Codex content, article fetch blocked.)
- Gemini: `Gemini apps: turn off "Keep Activity" - https://myactivity.google.com/product/gemini . Gemini CLI: free Code Assist for individuals access ended 2026-06-18; check the privacy terms of the plan or API key you use.`
- Cursor: `Cursor: turn on "Privacy Mode" in Cursor settings - https://cursor.com/data-use`

## Spec notes

- `docs/SPEC.md` says Gemini CLI is a P1 agent. Since 2026-06-18 consumers no longer get service in it. Detection and config checks still apply to existing installs (API key / enterprise users), but the README should not imply free Gemini CLI use.
- Rule 7 allowlist: `ssh-add -l` suffices for `ssh`; no `gh` child process is needed (hosts file is enough).
- Local `ls` of `~/.ssh` revealed an `agent` dir and a `backup` dir: both are excluded by the dir rule.
