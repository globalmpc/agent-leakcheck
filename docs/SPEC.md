# agent-leakcheck — build spec (P1)

This file is the contract for everyone building P1. Read it fully before writing code.
If something here is wrong or impossible, say so in your report instead of silently deviating.

## What it is

`npx @globalmpc/agent-leakcheck` scans a developer's machine and reports what their coding agents
(Claude Code, Codex CLI, Cursor, Gemini CLI) can **reach**: `.env` files, plaintext tokens,
SSH keys, credential file permissions, risky auto-approve modes, an outdated Claude Code. It prints a grade A–F, one
finding per problem and one fix per finding. `--fix` applies the safe fixes after a backup.

Positioning line (use as is): "snyk/agent-scan checks what's inside your agent's tools and
skills. agent-leakcheck checks what the agent itself can reach. Different layers, use both."

## Decisions (fixed)

- GitHub: `globalmpc/agent-leakcheck`, MIT. npm: `@globalmpc/agent-leakcheck` (bin `agent-leakcheck`), published from `globalmpc/agent-leakcheck` by CI.
- Share endpoint + stats page: one small Node service in `server/`, deployed on Vercel (a Vercel Function) with Upstash Redis.
- Agents in P1: Claude Code, Codex CLI, Cursor, Gemini CLI. A check that cannot be verified
  against official docs (see `docs/research/`) is left out rather than guessed.
- No token, wallet, `$MPC`, opBNB, blockchain or crypto wording anywhere in P1 (code, CLI
  output, README top, stats page). MPC mentions: one credit line at the very bottom of the
  README and of the stats page (`An open-source tool from [MPC](https://globalmpc.tech).`),
  and the brand banner at the top of the human report.
- Brand banner: "GLOBAL MPC" ASCII art plus `agent-leakcheck <version> · by Global MPC ·
  globalmpc.tech`, printed only when stdout is a TTY. `--json`, `--show`, `--badge`, piped
  output and CI logs never carry it. Apart from the banner, CLI output links only to the
  GitHub repo.

## Hard rules (each one is enforced by a test or the lint script)

1. **Zero runtime dependencies** in the CLI package and in `server/`. Node stdlib only.
   No devDependencies either. Node >= 20. ESM (`"type": "module"`).
2. **No network in the scan path.** Only `src/share.js` may import `node:http`, `node:https`,
   `node:net`, `node:tls`, `node:dns` or call `fetch`. Lint fails otherwise. A test stubs all of
   them to throw and runs a full scan on a fixture home.
3. **All file access goes through `src/read.js`.** No other `src/` file imports `node:fs`
   (except `src/fix.js`, which writes backups and config edits, and only through helpers it
   exports or through `read.js`). Lint enforces this.
4. **Never open secret files.** `.env*` files and SSH private keys are only `stat`-ed
   (existence, mode). `read.js` must refuse to read their contents (throw). A test wraps
   `fs` and fails if any such path is opened.
5. **Secret values never leave memory.** Config files that may hold tokens (MCP configs,
   `gh` hosts file) are parsed in memory to decide "literal value vs env-var reference vs
   keyring". The value is never stored in a finding, printed, written to `--json`, or sent.
   A test plants a fake token string in fixtures and asserts it appears in no output.
6. **Environment variables: names only.** Checks receive `ctx.envNames` (an array of names),
   never `process.env` values.
7. **Child processes:** only through `ctx.exec(file, args)` in `src/exec.js`, which has an
   allowlist (decided after research; at most `ssh-add -l` and, only if no file-based way
   exists, `<agent> --version`). `execFile`, no shell, 5 s timeout. Prefer reading versions
   from files.
8. Checks take the home directory and cwd from `ctx.home` / `ctx.cwd`, never from
   `os.homedir()` / `process.cwd()` directly, so tests can point them at fixtures.

## Layout

```
package.json            # name, bin, files: [bin, src, README.md, LICENSE], engines
bin/cli.js              # node:util parseArgs, wires everything
src/read.js             # the only fs reader: readText, readJson, exists, stat, listDir
src/exec.js             # allowlisted execFile wrapper
src/detect.js           # which agents are installed (config dirs, binaries on PATH, app bundle)
src/checks/index.js     # ordered list of checks
src/checks/<id>.js      # one file per check
src/score.js            # grade
src/report.js           # human output + JSON output
src/fix.js              # backups + safe config edits
src/share.js            # payload, --show, POST to endpoint, percentile
src/config.js           # VERSION, DEFAULT_ENDPOINT, REPO_URL
scripts/lint.js         # node --check on all .js + import guards (rules 2, 3)
scripts/track.js        # daily metrics snapshot (npm, GitHub, endpoint)
test/*.test.js          # node:test
test/fixtures/<case>/   # fake home + cwd trees
server/                 # share endpoint + stats page (own package.json, own tests)
plugin/                 # Claude Code plugin wrapper
docs/research/          # verified facts per agent, with doc links
```

Scripts in root `package.json`: `test` = `node --test`, `lint` = `node scripts/lint.js`.

## Check interface

```js
// src/checks/env-deny.js
export default {
  id: 'env-deny',
  title: 'Agents can read .env files',
  severity: 'high',            // 'high' | 'medium' | 'warning' | 'info'
  docs: ['https://…'],         // official doc(s) this rule is based on
  async run(ctx) {
    // ctx: { home, cwd, platform, envNames, agents, read, exec }
    // ctx.agents: [{ id: 'claude-code'|'codex'|'cursor'|'gemini', name, version|null, paths }]
    return [
      { agent: 'claude-code', status: 'fail', message: '…', fix: '…', autoFix: 'cc-env-deny' },
      { agent: 'codex', status: 'pass', message: '…' },
    ];
    // status: 'pass' | 'fail' | 'skip' | 'info'. autoFix: id handled by src/fix.js, or omitted.
  },
};
```

A check returns `skip` for agents it does not apply to or cannot evaluate, with a short reason.
Messages may name a config file path and a key name, never a value.

## Checks (P1)

Exact config paths, keys and fail rules come from `docs/research/*.md`. Summary:

| id | Severity | Fails when |
|---|---|---|
| `cc-version` | medium | Claude Code is older than 2.1.317 (the first release with a check before the account email is sent to the network; it asks or blocks, the issue anthropics/claude-code#107757 is still open) |
| `env-deny` | high | an installed agent has no deny / ignore rule that covers `.env` files (user-level or in the cwd project). Mention if `.env*` exists in cwd (stat only) . Codex rows are `info` only: its permission profiles are beta and the deny syntax is unverified in practice |
| `risky-mode` | high | an auto-approve / bypass / yolo / full-access mode is the configured default. Also: Claude Code bare `Bash` or `Bash(*)` in `permissions.allow` (managed, user, project or local settings); Gemini CLI bare `run_shell_command` in `tools.allowed`, or `security.enablePermanentToolApproval: true` |
| `mcp-plaintext` | medium | an MCP server config holds a literal secret-looking value in `env` / `headers` instead of an env-var reference. Report server name + key name only |
| `mcp-autoapprove` | medium | Claude Code `enableAllProjectMcpServers: true` in user or local settings. In a project's own settings it is an `info` row only (ignored until the folder is trusted) |
| `gh-token` | medium | the GitHub CLI token is stored in its plain hosts file instead of the OS keyring |
| `ssh` | medium | a private key file in `~/.ssh` has permissions looser than 600 (fail). Keys loaded in ssh-agent → `warning`-level `info` row with the count only. No passphrase check |
| `cred-perms` | medium | `~/.claude/.credentials.json` (absent on macOS, where the login is in the Keychain: skip), `~/.codex/auth.json` or `~/.git-credentials` exists and `mode & 0o077` is non-zero. Stat only, never opened. Fix: `chmod 600 <file>`. Windows → skip. Custom config dir set → `info` row |
| `secret-env` | warning | exported env var names look secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*API_KEY*`). Names listed, values never read |
| `training` | info | never pass/fail. A reminder with the official settings links for model-training data sharing (Claude, ChatGPT/Codex, Gemini) because it is an account setting a local scan cannot read |

## Grade

- Start at 100. For each check id with at least one `fail`: high −25 (`env-deny`, `risky-mode`), medium −10 (`cc-version`, `mcp-plaintext`, `mcp-autoapprove`, `gh-token`, `ssh`, `cred-perms`). `warning`
  and `info` never change the score. Each check id counts once, however many agents fail it.
- A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F < 40. Floor at 0.
- Print the weights in `--help` and the README.

## CLI

```
npx @globalmpc/agent-leakcheck            scan, print grade + findings, then (TTY only) ask to share
npx @globalmpc/agent-leakcheck --json     machine-readable result on stdout; never prompts
npx @globalmpc/agent-leakcheck --fix      show planned safe fixes, ask y/N (TTY) or require --yes, back up, apply
npx @globalmpc/agent-leakcheck --show     print the exact share payload; sends nothing
npx @globalmpc/agent-leakcheck --share    opt in without the prompt (explicit flag)
npx @globalmpc/agent-leakcheck --badge    print a README badge (static shields.io URL, no network)
npx @globalmpc/agent-leakcheck --fail-on high|medium   exit 2 when a failing check at that severity or higher exists (for CI)
npx @globalmpc/agent-leakcheck --no-color / --help / --version
```

- Exit code 0 on a completed scan, 1 on an internal error, 2 on a usage error (including any `--fail-on` value other than `high` or `medium`) or when the `--fail-on` threshold is met.
- The share prompt is `Share anonymous results? [y/N]`, asked once after the report, only
  when stdin and stdout are TTYs and neither `--json` nor `--show` is set. Empty answer = No.
- Footer line: `agent-leakcheck <version> · https://github.com/globalmpc/agent-leakcheck`.
- Human output: grade first, then findings grouped by check (fail, then info/warning, then
  pass summarised in one line), each fail with its fix. Respect `NO_COLOR` and non-TTY.

### `--json` shape

```json
{ "schemaVersion": 1, "tool": "agent-leakcheck", "version": "0.1.0", "grade": "B", "score": 80,
  "agents": [{ "id": "claude-code", "version": "2.1.320" }],
  "checks": [{ "id": "env-deny", "severity": "high", "status": "fail",
               "results": [{ "agent": "claude-code", "status": "fail", "message": "…", "fix": "…" }] }] }
```

Check-level `status` = `fail` if any result fails, else `pass` if any passes, else `info` if any
info, else `skip`.

## `--fix`

- Only edits that are one key/array entry in a JSON settings file (or a single top-level key
  in Codex TOML, by exact line match before the first `[table]`; if unsure, don't touch it).
- Before any write: copy the file to `<file>.leakcheck-bak-<YYYYMMDDHHmmss>`. Then write, then
  print `changed <path>: <what>` and the backup path.
- Never moves tokens, never touches `~/.ssh`, never logs in to anything: those fixes are text
  instructions only.
- Without a TTY, `--fix` requires `--yes`; otherwise it prints the plan and exits 0.

## Opt-in share

Payload (exactly these fields; `--show` prints it):

```json
{ "v": "0.1.0", "os": "macos", "grade": "B",
  "agents": [{ "name": "claude-code", "version": "2.1.320" }],
  "checks": { "cc-version": "pass", "env-deny": "fail", "risky-mode": "pass", "mcp-plaintext": "skip",
              "mcp-autoapprove": "pass", "gh-token": "pass", "ssh": "pass", "cred-perms": "pass",
              "secret-env": "pass" },
  "via": "flag" }
```

- `os` ∈ `macos | linux | windows | other`. Agent `version` is a semver string or null.
- `checks` covers every non-info check id with `pass | fail | skip` (`warning`-severity checks
  report `fail` when they would warn).
- `via` ∈ `prompt | flag`: `prompt` when the user answered y to the share prompt, `flag` for
  `--share` (`--show` prints `flag`).
- Never sent: paths, values, usernames, hostnames, env var names, server names, scores per agent.
- `POST <endpoint>/api/scan`, `content-type: application/json`, 5 s timeout. On success the
  server answers `{ "ok": true, "total": 123, "betterThan": 64 }` and the CLI prints
  `Thanks. Your setup is better than 64% of 123 shared scans. Stats: <endpoint>/`.
  On any error print one line `Could not share (…). Nothing else was sent.` and exit 0.
- Endpoint: `AGENT_LEAKCHECK_ENDPOINT` env var, else `DEFAULT_ENDPOINT` in `src/config.js`.

## Server (`server/`)

- Zero dependencies: Node stdlib and global `fetch` only. Production is a Vercel Function (`server/api/index.js`); `server/vercel.json` rewrites every path to it. Local dev runs `server/index.js` (`PORT` from env) with an in-memory store when the Redis env vars are unset.
- Storage is Upstash Redis through its REST API. Env: `KV_REST_API_URL` / `KV_REST_API_TOKEN`, falling back to `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (see `.env.example`). Without them the data routes answer 503 and `/healthz` still answers 200.
- **Aggregates only, no rows.** Store counters, never individual payloads:
  `{ total, byDay: { "YYYY-MM-DD": n }, grade: { A..F }, os: {…}, toolVersion: {…},
     agents: { name: n }, agentVersions: { name: { version: n } },
     checks: { id: { pass, fail, skip } }, via: { prompt, flag },
     sharersByDay: { "YYYY-MM-DD": n } }`. Kept as Redis counters (keys prefixed `alc:`).
  `sharersByDay` (last 14 UTC days, estimated) exists only when the `STATS_SALT` secret is set:
  a keyed hash of UTC day + client key goes into a per-day HyperLogLog that expires after 16 days.
- `POST /api/scan`: strict validation (max 2 KB body; exact keys; enums; check ids and agent
  names from an allowlist; version strings `^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]{1,20})?$`
  or null; at most 4 agents). Reject with 400 otherwise. Respond
  `{ ok, total, betterThan }` where `betterThan` = round(100 × scans with a worse grade ÷ total).
- `GET /api/stats`: the aggregates JSON plus derived `failRate` per check. Stats and the page are cached 60 s (`public, max-age=60, s-maxage=60`).
- `GET /`: the stats page (server-rendered single HTML file, inline CSS, no scripts, no external requests, light + dark,
  works at phone width): total shared scans with a prompt / `--share` split, shares per day
  (last 14 UTC days, plus distinct people when counted), grade distribution, fail rate per check, agents
  seen, short "what is collected" box with the exact field list, credit line at the bottom.
- `GET /healthz` → `ok`.
- Never log or store IPs, user agents or bodies. Rate limit: 20 POSTs per client per 60 s window, a fixed window in Redis. The client key is keyed-hashed (HMAC-SHA256 with `STATS_SALT`, else the Redis token) before it reaches Redis, so raw IPs are never stored; counters expire after two windows. Distinct-sharer ids are keyed (HMAC with `STATS_SALT`) and per day. Details in `server/README.md`.
- `server/package.json` with `start`, `test`; `server/vercel.json` (rewrite to `api/index.js`). Env vars and deploy steps are documented in `server/README.md`.

## Tests (node:test, all must pass offline)

- Unit tests per check against fixtures (pass and fail cases for each agent it covers).
- `test/trust.test.js`: rules 2, 4, 5 (network stubs throw; fs wrapper records opened paths;
  planted fake token never appears in human output, `--json`, or the share payload).
- `test/score.test.js`, `test/cli.test.js` (spawn `bin/cli.js` with a fixture home via an
  env override `AGENT_LEAKCHECK_HOME` / `AGENT_LEAKCHECK_CWD`, used only for tests and
  documented as such), `test/fix.test.js` (backup created, only intended key changed,
  idempotent second run).
- `server/test/*.test.js`: validation rejects bad payloads, aggregates update, betterThan math,
  no IP or body persisted.

## Style

- 2-space indent, single quotes, semicolons, small pure functions, JSDoc on exported functions.
- English for code, comments, docs, commit messages. No emojis in CLI output except the grade
  colour. Keep README plain and short.
