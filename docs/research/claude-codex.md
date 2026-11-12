# Claude Code and Codex CLI: verified facts for agent-leakcheck

Date: 2026-11-12. Statuses: `verified-doc` (official docs), `verified-source` (upstream source code),
`observed-local` (structure-only look at the dev laptop, no values read), `unverified`.
No agent binary was run. No secret value was read or copied.

## Part 1. Facts: Claude Code

### Settings files
- User `~/.claude/settings.json`; shared project `.claude/settings.json`; local `.claude/settings.local.json`; managed. `verified-doc`
  https://code.claude.com/docs/en/settings
- Precedence high to low: managed, CLI `--settings`, project local, shared project, user. List keys such as `permissions.allow` / `deny` MERGE across files. `verified-doc` (same URL)
- Files are strict JSON (no comments, no trailing commas). `verified-doc` (same URL)
- `CLAUDE_CONFIG_DIR` moves `~/.claude` and also `~/.claude.json`. `verified-doc`
  https://code.claude.com/docs/en/claude-directory
  Quote: "The same applies to `.claude.json`, which otherwise sits at `~/.claude.json`."
- Windows: `~/.claude` is `%USERPROFILE%\.claude`. `verified-doc`
- Managed settings paths. `verified-doc` https://code.claude.com/docs/en/managed-settings
  - macOS `/Library/Application Support/ClaudeCode/managed-settings.json`
  - Linux/WSL `/etc/claude-code/managed-settings.json`
  - Windows `C:\Program Files\ClaudeCode\managed-settings.json`
  - Optional drop-ins `managed-settings.d/*.json`, merged alphabetically. `managed-mcp.json` is in the same directory.
  - Server-managed and MDM (macOS domain `com.anthropic.claudecode`) also exist; files cannot see them.
  - Local: the macOS managed directory does not exist. `observed-local`

### Deny rules and .env
- Read/Edit deny rules use gitignore syntax. Anchors: `//abs`, `~/home`, `/rel-to-settings-source`, `path` or `./path` = cwd. `verified-doc`
  https://code.claude.com/docs/en/permissions
  Quote: "Bare filenames follow gitignore semantics and match at any depth, so `Read(.env)` and `Read(**/.env)` are equivalent."
- In user settings `/secrets/**` means `~/.claude/secrets/**`, not a project folder. Use `//` or `~/` anchors to cover all projects. `verified-doc`
- The docs table says `Read(.env)` / `Read(**/.env)` blocks `.env` at or under the CURRENT directory; `Read(//**/.env)` blocks any `.env` on the filesystem. `verified-doc`
- Windows paths are normalised to POSIX form (`C:\x` becomes `/c/x`); `//**/.env` covers all drives. `verified-doc`
- A Read deny also blocks Edit/Write on that path. Deny rules apply in every mode, including `bypassPermissions`. `verified-doc`
- Limit: rules cover built-in file tools and recognised Bash file commands (`cat`, `head`, ...), not `grep -r` or arbitrary scripts. Sandbox gives OS-level enforcement. `verified-doc`
  Quote: "They don't apply to a command that reads files without naming them, such as `grep -r pattern .`"
- `.claudeignore` has no effect. `verified-doc`. No built-in default `.env` deny was found in the docs fetched: "not found", not proven absent.
- Sandbox `sandbox.filesystem.denyRead` (example `~/**/.env`) covers sandboxed Bash only, not the Read tool. `verified-doc`
  https://code.claude.com/docs/en/sandboxing
- Local: user settings already deny `Read(**/.env)`, `Read(**/.env.local)`, `Read(**/.env.*.local)`, `Read(~/.ssh/**)`. `observed-local`
- Open question: whether user-level `Read(**/.env)` applies to EVERY project or only the cwd tree. Docs say cwd-relative. `unverified` for "every project". Use `//**/.env` as the unambiguous form.

### Risky modes
- `permissions.defaultMode` values: `default`/`manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `verified-doc`
  https://code.claude.com/docs/en/settings-reference
  Quote: "`bypassPermissions`: Claude Code runs everything without asking"
- `auto` and `bypassPermissions` "don't take effect from project or local settings" (so only user or managed count). Before v2.1.257 `bypassPermissions` worked from any file. `verified-doc`
  Note: this contradicts one earlier reading that said "user, local or managed"; the safe reading is user + managed, and scanning local too is harmless (report it as ignored).
- `--dangerously-skip-permissions` is a per-session flag, not a config key. `verified-doc`
- `skipDangerousModePermissionPrompt: true` skips the bypass confirmation (user/local/managed only). `verified-doc`
- `permissions.disableBypassPermissionsMode: "disable"` and `permissions.disableAutoMode: "disable"` work from any file. `verified-doc`
- User settings locally have no `defaultMode`. `observed-local`

### Version detection
- `claude --version` prints `X.Y.Z (Claude Code)`. `verified-doc` https://code.claude.com/docs/en/setup
- Native installer (macOS/Linux): `~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/<ver>`. Installer keeps the linked version plus the 2 newest. `verified-doc`
  Local: link points at `.../versions/2.1.322`; directory holds 2.1.318, 2.1.319, 2.1.322. `observed-local`
  So `readlink` + basename gives the version with no exec.
- Local `~/.claude.json` has key `installMethod` = `native`. `observed-local`
- npm: `npm install -g @anthropic-ai/claude-code`, so `<prefix>/lib/node_modules/@anthropic-ai/claude-code/package.json` `version`. `verified-doc` (path derived from the package name; no local npm install exists to observe).
- Homebrew cask `claude-code` / `claude-code@latest`, WinGet `Anthropic.ClaudeCode`. Windows launcher `%USERPROFILE%\.local\bin\claude.exe`. `verified-doc`. Windows versions directory: `unverified`.

### Version threshold
- Issue https://github.com/anthropics/claude-code/issues/107757 (opened 2026-11-05, still OPEN). Maintainer quote: "We introduced a built-in mod called `cc-plugin-privacy` to deterministically block this behavior in v2.1.317 and later". `verified-doc` (issue text)
- CHANGELOG https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md `verified-doc`
  - 2.1.317: "Added a check that asks before a web or shell tool call sends your account email address to the network"
  - 2.1.322: narrowed to refuse only a shell command holding the email and naming a User-Agent.
- A commenter reported a gap in 2.1.319 (shell `curl -A`). Only the first ~100K chars of the changelog were read.
- Conclusion: 2.1.317 is the first release with a guard, but it asks or blocks; it does not remove the email. SPEC wording "stopped sending" is too strong. Suggested wording: "older than 2.1.317, which added a check before your account email is sent to the network".

### MCP
- Scopes. `verified-doc` https://code.claude.com/docs/en/mcp
  - local: `~/.claude.json` at `projects.<abs path>.mcpServers`
  - project: `.mcp.json` at project root
  - user: `~/.claude.json` top-level `mcpServers`
  - Precedence local, project, user, plugin, claude.ai connectors; whole entry wins.
- Fields: `type` (`http`, `sse`, `ws`, `stdio`; `streamable-http` = `http`), stdio `command`/`args`/`env`, remote `url`/`headers`/`headersHelper`.
- Expansion `${VAR}` and `${VAR:-default}` is supported in `command`, `args`, `env`, `url`, `headers`. Quote: "You can reference an environment variable in a server's `command`, `args`, `env`, `url`, or `headers` value."
- Doc example `"Authorization": "Bearer ${API_KEY}"`.
- The MCP page was truncated (100K of 157K chars). `managed-mcp.json` path comes from the managed-settings page.
- Local structure: top-level `mcpServers` has stdio entries (`args, command, env, type`) and http entries (`type, url`); 3 projects have local-scope servers; no `~/.mcp.json`. `observed-local`

## Part 2. Facts: Codex CLI

Latest release seen: `rust-v0.167.2` (2026-11-11). Local: no `~/.codex`, no `codex` binary. `observed-local`
Sources: https://developers.openai.com/codex/config-reference (redirects to learn.chatgpt.com), and
https://github.com/openai/codex (`codex-rs/core/config.schema.json`, `codex-rs/protocol/src/config_types.rs`,
`codex-rs/config/src/shell_environment_policy.rs`, `codex-rs/login/src/auth/storage.rs`).

### Config
- User config `$CODEX_HOME/config.toml`, default `~/.codex/config.toml`. `verified-doc`
- Profile files `$CODEX_HOME/<name>.config.toml` (newer, `--profile`); legacy `profile = "x"` + `[profiles.x]` still in the schema. `verified-doc` / `verified-source`
- Project `.codex/config.toml` exists; it ignores some keys (`notify`, `profile`, `profiles`, `otel`, ...). The full ignore list is `unverified` (text cut off).
- `approval_policy`: `"on-request"`, `"never"`, or `{ granular = {...} }`. Quote: "`untrusted` is unsupported, and `on-failure` is deprecated" `verified-doc`
- `sandbox_mode`: `read-only | workspace-write | danger-full-access`. `verified-source` (schema)
- `default_permissions` string; built-ins `:read-only`, `:workspace`, `:danger-full-access`; cannot be combined with `sandbox_mode`. `verified-doc`
- CLI flag `--dangerously-bypass-approvals-and-sandbox`: `unverified` (not seen in pages read). It is a flag, not a config key, so no file check depends on it.

### Reading `.env` and env inheritance
- Beta permission profiles: `[permissions.<name>.filesystem]` entries with `"deny"`. Quote: "glob subpaths such as `"**/*.env"` can deny reads with `"deny"`". Needs `default_permissions = "<name>"`. `verified-doc`
  This is a table shape, so it is NOT single-key auto-fixable.
- `[shell_environment_policy]` keys: `inherit` (`all|core|none`), `ignore_default_excludes`, `exclude`, `include_only`, `filters`, `set`, `experimental_use_profile`. `verified-source`
- Defaults: `inherit = All`, `ignore_default_excludes = true`. `verified-source` (`config_types.rs` Default impl; `shell_environment_policy.rs` `unwrap_or(true)`)
  Source comment: "True to skip the check to exclude default environment variables that contain "KEY", "SECRET", or "TOKEN" in their name. Defaults to true."
  Meaning: by default Codex child processes inherit secret-named env vars.
  Setting `ignore_default_excludes = false` turns on removal of `*KEY*`, `*SECRET*`, `*TOKEN*` (case-insensitive).

### MCP
- `[mcp_servers.<id>]` tables. Schema keys include `command, args, env, env_vars, url, http_headers, env_http_headers, bearer_token_env_var, http_headers_helper, oauth, enabled`. `verified-source`
- Literal-value keys: `env` (map), `http_headers` (map), `oauth.client_secret`.
- Env-reference keys (names only, safe): `env_vars`, `env_http_headers`, `bearer_token_env_var`.
- No literal bearer token for MCP. The only literal token key found is `model_providers.<id>.experimental_bearer_token` (model provider, "discouraged").
- TOML shapes: `env = { K = "v" }` inline table, or `[mcp_servers.<id>.env]` subtable.

### Auth and version
- `cli_auth_credentials_store = file | keyring | auto | ephemeral`. `verified-doc` / `verified-source`
- `auth.json` lives at `$CODEX_HOME/auth.json` (source: `codex_home.join("auth.json")`, "Expected structure for $CODEX_HOME/auth.json"). `verified-source`
- Default store when the key is absent: `unverified`.
- Codex version detection (npm `@openai/codex/package.json`, Homebrew, `codex --version` format): `unverified`. The TUI keeps a `version.json` with `latest_version` and `last_checked_at` (`tui/src/updates.rs`), but that is the LATEST seen version, not the installed one. Do not use it for a version check. `verified-source`
- Codex cc-version-style check is not in scope; skip Codex version.

## Part 3. Proposed rules

All rules: read through `read.js`; JSON parse failure means `skip` with reason "unparseable settings" (never fail on parse errors); report names only.

### cc-version (Claude Code)
- Detect, in order:
  1. `readlink ~/.local/bin/claude`, basename matching `^\d+\.\d+\.\d+$` (macOS/Linux; on Windows check `%USERPROFILE%\.local\bin\claude.exe` presence only).
  2. `package.json` `version` under the npm global prefix (`$npm_config_prefix/lib/node_modules/@anthropic-ai/claude-code`, nvm `~/.nvm/versions/node/*/lib/node_modules/...`, `/opt/homebrew/lib/node_modules/...`, `/usr/local/lib/node_modules/...`).
  3. Last resort `ctx.exec('claude', ['--version'])`, parse `^(\d+\.\d+\.\d+)`.
- Several versions found (npm plus native): use the one the PATH launcher resolves to; if unknown, use the lowest and say so.
- Pass: version >= 2.1.317. Fail: lower. Skip: Claude Code not installed or version unreadable (message "version unknown", not a fail).
- Message: "Claude Code <v> is older than 2.1.317, which added a check before your account email is sent to the network (anthropics/claude-code#107757)."
- Fix text: "Update: `claude update` (native) or `npm i -g @anthropic-ai/claude-code`." No auto-fix.
- Edge: 2.1.322 narrowed the check, the issue is still open; do not claim the leak is fully closed in newer versions.

### env-deny (Claude Code)
- Files: user `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`); cwd project `<root>/.claude/settings.json` and `settings.local.json`; managed path per OS (read-only check).
- Parse: JSON; collect `permissions.deny` string arrays from all files (they merge).
- Pass: any entry matches `/^Read\((\.\/)?(\*\*\/)?\.env(\*|\.\*)?\)$/`, `Read(//**/.env...)`, or `Read(~/**/.env...)`. Project-file entries count only for the cwd project.
- Weak pass (note): the only match is an unanchored `Read(**/.env)` in USER settings (cwd-relative per docs). Say "covers the current project tree; use `//**/.env` for all projects".
- Fail (high): no matching entry anywhere. Skip: Claude Code not installed.
- Message: "Claude Code has no deny rule for .env files."
- Fix text: add `"Read(//**/.env)"` and `"Read(//**/.env.*)"` to `permissions.deny`.
- SAFE auto-fix: yes. In user settings, append those two strings to the `permissions.deny` array (create the array if missing; do not duplicate). Backup first.
- Edge: Bash tools can still read `.env` via unrecognised commands; mention sandbox. Windows paths use the same `//**/` form.

### risky-mode (Claude Code)
- Files: user and managed settings count; project and local are reported as "ignored by Claude Code" (v2.1.257+).
- Fail (high): `permissions.defaultMode == "bypassPermissions"` in user or managed settings.
- Warn (note): `defaultMode == "auto"`, or `skipDangerousModePermissionPrompt == true` in user/local settings.
- Pass otherwise. `acceptEdits`, `plan`, `dontAsk`, `default`, `manual` are not flagged.
- Message: "Claude Code defaults to bypassPermissions: every tool runs without asking."
- Fix text: remove `permissions.defaultMode` or set it to `default`; optionally set `permissions.disableBypassPermissionsMode` to `"disable"`.
- SAFE auto-fix: yes, single key. In user settings set `permissions.defaultMode` to `"default"`. Do not touch managed files.
- Edge: `--dangerously-skip-permissions` is per-session and cannot be seen from files.

### mcp-plaintext (Claude Code)
- Files: `~/.claude.json` (`mcpServers` and `projects.*.mcpServers`), `<cwd>/.mcp.json`, optional managed `managed-mcp.json`.
- Parse: JSON. For each server, inspect `env` values and `headers` values (strings only).
- Literal secret: the value is non-empty, contains no `${`, and either the KEY name matches `/(KEY|TOKEN|SECRET|PASSWORD|AUTH|BEARER)/i` or the value matches a known token shape (`sk-`, `ghp_`, `github_pat_`, `xox[bap]-`, `AKIA`, `eyJ`, `Bearer <long>`). Entirely `${VAR}` or `Bearer ${VAR}` values pass.
- Fail (medium): at least one literal. Pass: none. Skip: no servers.
- Message: "MCP server <name> has a plaintext value in <env|headers> key <KEY>." (name and key only; never the value)
- Fix text: replace the value with `${ENV_NAME}` and export the variable in your shell profile.
- SAFE auto-fix: not offered. It would move a secret out of the file and needs the user to set the variable first; report only.
- Edge: `~/.claude.json` is large and contains tokens; parse in memory only, never echo. `headersHelper` is a command, not a value, so it passes.

### secret-env (notes, Claude Code and Codex)
- Claude Code: subprocess scrubbing exists via `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` and `sandbox.credentials.envVars`. Not verified in depth; treat as advice text only.
- Codex: default `ignore_default_excludes = true` and `inherit = all` means secret-named variables reach every child process. Advice: add `[shell_environment_policy]` with `ignore_default_excludes = false`.
- Not a safe auto-fix: it is a key inside a table, not a top-level key. Report only.

### env-deny (Codex)
- Files: `$CODEX_HOME/config.toml`, default `~/.codex/config.toml`; project `.codex/config.toml`.
- Parse with a line-based TOML reader: track current `[table]` header; match `[permissions.<name>.filesystem]` / `[permissions.<name>.filesystem.":workspace_roots"]` lines and `"**/*.env" = "deny"` or `"**/.env" = "deny"` entries; read top-level `default_permissions = "<name>"`.
- Pass: a deny entry for `.env` exists in the profile named by `default_permissions`. Fail (high): Codex installed (config or `~/.codex` exists) and no such entry. Skip: no Codex footprint.
- Fix text: documentation-only; show the beta profile snippet. No auto-fix (table shape, and `default_permissions` conflicts with `sandbox_mode`).
- Edge: feature is labelled beta; the exact subpath key syntax is `unverified` in practice.

### risky-mode (Codex)
- Parse top-level keys (before the first `[table]`) with line match `^\s*(key)\s*=\s*"([^"]*)"`. Also read the active profile table if `profile = "x"` and `[profiles.x]` exist (same keys). TOML shapes needed: bare keys, basic strings, `[table]` and `[a.b.c]` headers, inline tables only for `env`/`http_headers`, `#` comments. Ignore multi-line arrays and strings.
- Fail (high): `sandbox_mode = "danger-full-access"`, or `default_permissions = ":danger-full-access"`. Worst case when also `approval_policy = "never"`.
- Warn: `approval_policy = "never"` with a non-full-access sandbox.
- Pass: otherwise. Skip: no config file.
- Message: "Codex defaults to full filesystem access (danger-full-access)."
- Fix text: set `sandbox_mode = "workspace-write"` and `approval_policy = "on-request"`.
- SAFE auto-fix: yes, only if the offending line is a top-level key before the first `[table]`. Exact edit: replace the line `sandbox_mode = "danger-full-access"` with `sandbox_mode = "workspace-write"` (exact line match); same for `approval_policy = "never"` to `"on-request"`. If the key is inside a profile table, or `default_permissions` is the cause, report only.
- Edge: `CODEX_HOME` override; profile files `<name>.config.toml`; managed requirements (`allowed_sandbox_modes`) are not read.

### mcp-plaintext (Codex)
- Parse `[mcp_servers.<id>]` headers; inside, `env = { ... }`, `http_headers = { ... }`, and subtables `[mcp_servers.<id>.env]` / `[mcp_servers.<id>.http_headers]`. Also `[mcp_servers.<id>.oauth]` `client_secret`.
- Same literal test as Claude Code. `env_vars`, `env_http_headers`, `bearer_token_env_var` always pass (names only).
- Fix text: switch to `env_vars = ["NAME"]`, `env_http_headers = { "Header" = "NAME" }` or `bearer_token_env_var = "NAME"`. No auto-fix.
- Edge: multi-line inline tables are `unverified` for the line parser; on unparseable shapes, skip with a note.

## Part 4. Not verified
- Codex version detection and `codex --version` format; Codex `auth.json` default store.
- Codex `--dangerously-bypass-approvals-and-sandbox` flag; full list of keys ignored in project `.codex/config.toml`.
- Windows native Claude versions directory.
- Whether user-level `Read(**/.env)` covers every project (docs say cwd-relative).
- Absence of any built-in `.env` default in Claude Code (only "not found in docs").
- `managed-mcp.json` path on the MCP page itself; CHANGELOG range beyond the first ~100K characters.
- Exact `permissions.<name>.filesystem` glob syntax behaviour in a real Codex run.
