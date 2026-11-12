# Research: Cursor and Gemini CLI (fetched 2026-11-12)

Status tags: `verified-doc` (official docs page read today), `verified-source` (gemini-cli `main` source read today, npm latest 0.68.0), `observed-local` (this Mac, structure only, no values), `unverified`.
Doc fetches were summarised by a small model; quotes marked "~" are close paraphrase, not byte-exact.

## 1. Cursor facts

### 1.1 Install detection and version
- macOS app: `/Applications/Cursor.app`; version in `Contents/Resources/app/package.json` `.version` = 3.24.12 here, also `Info.plist` `CFBundleShortVersionString` = 3.24.12 (both agree). observed-local.
- `/usr/local/bin/cursor` -> `/Applications/Cursor.app/Contents/Resources/app/bin/code` (shell launcher, symlink). observed-local.
- `~/.cursor/` exists (config dir). Contains `mcp.json`, `cli-config.json`, `hooks.json`, `argv.json`, `projects/`, `skills/`. observed-local. Env `CURSOR_CONFIG_DIR` overrides the CLI config dir; on Linux the CLI reads `$XDG_CONFIG_HOME/cursor/cli-config.json`. https://cursor.com/docs/cli/reference/configuration verified-doc.
- CLI: `~/.local/bin/cursor-agent` and `~/.local/bin/agent` (symlinks into `~/.local/share/cursor-agent/versions/<ver>/cursor-agent`, a bash launcher next to a bundled `node`). Version dir here: `2026.01.23-916f423`. observed-local. Version = the directory name (date + hash). The `package.json` in that dir has only `name`/`private`, NO version field. observed-local.
- Linux/Windows IDE paths: NOT found in official docs. Common (unverified): Linux `/opt/Cursor`, `/usr/share/cursor`, AppImage anywhere; Windows `%LOCALAPPDATA%\Programs\cursor\resources\app\package.json`. Windows settings under `%APPDATA%\Cursor\User\settings.json` (forum, unverified). Linux user dir `~/.config/Cursor/User/settings.json` (absent here, unverified for Linux).
- CLI install (official): `curl https://cursor.com/install -fsS | bash` (mac/Linux/WSL), PowerShell `irm 'https://cursor.com/install?win32=true' | iex`. https://cursor.com/docs/cli/installation verified-doc (layout of the Linux/Windows install dir unverified).
- IDE user settings on macOS: `~/Library/Application Support/Cursor/User/settings.json`. observed-local.

### 1.2 MCP config
- Files: global `~/.cursor/mcp.json`, project `.cursor/mcp.json`. https://cursor.com/docs/mcp verified-doc.
- Schema: stdio = `type:"stdio"`, `command`, `args`, `env`, `envFile` (stdio only); remote = `url`, `headers`; OAuth = `auth{CLIENT_ID,CLIENT_SECRET,scopes}`. Local file also has `type` on a remote server. observed-local.
- Interpolation: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`, `${/}`. Applies to `command`, `args`, `env`, `url`, `headers` (and `auth` values). `envFile` not listed as interpolated. verified-doc. Quote ~: "resolves variables in these fields: command, args, env, url, headers".
- Reference forms: any string containing `${env:NAME}` (also `Bearer ${env:NAME}`). Literal: everything else. `${userHome}` etc. are path vars, not secrets.
- Local file parses as strict JSON (jq ok). It has real literal values under `headers.Authorization` for 2 servers and literal non-secret `env.PATH`/`NODE_PATH` for one stdio server. Key names only. observed-local. So the check must not flag `PATH`/`NODE_PATH`.

### 1.3 .env protection
- `.cursorignore` in project root, `.gitignore` syntax. Optional hierarchical mode: Cursor Settings > Indexing > Ignore Files > Hierarchical Cursor Ignore (parent dirs). https://cursor.com/docs/context/ignore-files verified-doc.
- It blocks ignored files from Agent and Tab code access and @-mentions. Quote ~: "terminal and MCP server tools used by Agent cannot block access". "Best effort": "complete protection isn't guaranteed due to LLM unpredictability". verified-doc.
- Default ignore list: doc has a "Files ignored by default" section, lists `**/.env` / `**/.env.*` under environment files and `.env*` in the default list code block. verified-doc. BUT whether defaults/.gitignore/global list apply to Agent reads or only to indexing is not stated in the docs; a Cursor staff reply on the forum says global list and `.gitignore` only affect indexing and `.cursorignore` is needed to block Agent/Tab. https://forum.cursor.com/t/cursor-does-not-ignore-files-in-gitignore/154430 (forum, treat as unverified).
- Global ignore setting: name `cursor.general.globalCursorIgnoreList` (forum + third-party, unverified); UI "Settings > General > Global Cursor Ignore List". Empty by default per docs (verified-doc). On disk: the key is NOT in `~/Library/Application Support/Cursor/User/settings.json` here (observed-local; the grep found no match), so it is likely kept in Cursor's internal SQLite storage. Decision: do not read it.
- CLI permissions: global `~/.cursor/cli-config.json`, project `<project>/.cursor/cli.json` (only `permissions` honoured at project level). https://cursor.com/docs/cli/reference/configuration and https://cursor.com/docs/cli/reference/permissions verified-doc.
  - Entries: `Shell(cmd)`, `Read(pathOrGlob)`, `Write(pathOrGlob)`, `WebFetch(domain)`, `Mcp(server:tool)`. Globs `**`, `*`, `?`. Relative paths are scoped to the workspace. "Deny rules take precedence over allow rules." Example from docs: `"deny": ["Read(.env*)", "Write(**/*.key)"]`. verified-doc.
  - Local `cli-config.json`: `permissions.allow` has 1 entry, `permissions.deny` is `[]`. So this machine has NO read deny. observed-local.
  - Does `Read(.env*)` (no `**/`) match `src/.env`? Unverified; relative patterns are workspace-scoped.
- Limits: CLI deny governs the CLI agent's tools; Shell tool `cat .env` is a separate permission (deny `Shell(cat)` is impractical). Say so in the message.

### 1.4 Risky mode
- CLI `approvalMode` key in `cli-config.json`: `allowlist`, `auto-review`, `unrestricted`. verified-doc. Local value `allowlist`. observed-local. Fail on `unrestricted`.
- CLI `sandbox.mode` exists (values not documented; local `disabled`), `sandbox.networkAccess` (local `allowlist`), `sandbox.readBoundary` `system`(default)|`workspace`. verified-doc / observed-local. Do NOT fail on `sandbox.mode`.
- CLI flag `--force` auto-runs; it is a flag, not a config key. verified-doc (permissions page, vague).
- IDE run modes: Auto-review (default since 3.6), Allowlist, Run Everything; set in Settings > Agents > Approvals & Execution. https://cursor.com/docs/agent/security/run-modes verified-doc. `~/.cursor/permissions.json` and `sandbox.json` (global + project) only steer auto-review and sandbox; neither exists here. observed-local.
- Where the chosen IDE run mode is stored: NOT documented. No `state.vscdb` at `User/globalStorage` here; only per-workspace `User/workspaceStorage/*/state.vscdb` exist. observed-local. Decision: SKIP IDE risky-mode (SQLite/undocumented).

### 1.5 Privacy Mode (training)
- Setting: Cursor Settings (Cmd/Ctrl+Shift+J) > General > "Privacy Mode". Quote: "With Privacy Mode enabled, your code is never used for training." https://cursor.com/help/security-and-privacy/privacy verified-doc. Overview: https://cursor.com/data-use (search result, not read).
- Local `cli-config.json` has a cached `privacyCache.privacyMode` = 3 and `ghostMode` = false. Meaning of the number is undocumented. observed-local; unverified, do not interpret.

## 2. Gemini CLI facts

### 2.0 Status warning (affects the training reminder and detection)
- Google ended "Login with Google" for consumer accounts in Gemini CLI and the IDE extensions (June 18, 2026 per third-party press; the official page confirms the end of login, not the date); Standard/Enterprise Code Assist and API keys keep working. Successor: Antigravity CLI. https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals verified-doc (date: unverified). The old individuals privacy notice page now only shows the deprecation text.
- Repo still active: npm `@google/gemini-cli` latest = 0.68.0 (registry, today). verified-source.

### 2.1 Settings paths and precedence (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md, verified-doc)
| Layer | macOS | Linux | Windows |
|---|---|---|---|
| system defaults | `/Library/Application Support/GeminiCli/system-defaults.json` | `/etc/gemini-cli/system-defaults.json` | `C:\ProgramData\gemini-cli\system-defaults.json` |
| user | `~/.gemini/settings.json` | same | same (`%USERPROFILE%`) |
| project | `<project>/.gemini/settings.json` | same | same |
| system | `/Library/Application Support/GeminiCli/settings.json` | `/etc/gemini-cli/settings.json` | `C:\ProgramData\gemini-cli\settings.json` |
- Env overrides: `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`.
- Precedence low to high: defaults, system-defaults, user, project, system, env vars, CLI args. The system file wins over user and project.
- Nested schema since v0.3.0 (`general`, `tools`, `security`, `context`, `privacy`, `mcpServers` top level, ...). Legacy flat keys: docs do not list them. `tools.autoAccept` does not exist in current docs or `settingsSchema.ts`. verified-doc/verified-source. Old flat keys: unverified, ignore them.
- Parsing: source uses `JSON.parse(stripJsonComments(content))` (packages/cli/src/config/settings.ts) => `//` and `/* */` comments allowed. Trailing commas are not allowed by default in strip-json-comments (library behaviour, unverified for this exact version). verified-source.
- Strings in settings expand `$VAR`, `${VAR}`, `${VAR:-default}` (resolveEnvVarsInObject). verified-doc+source.
- Local: no `~/.gemini` on this machine. observed-local.

### 2.2 Risky mode
- `general.defaultApprovalMode` options in schema: `default`, `auto_edit`, `plan`. Description: "YOLO mode ... can only be enabled via command line (--yolo or --approval-mode=yolo)". verified-source.
- config.ts: a `defaultApprovalMode: "yolo"` in settings is explicitly ignored (treated as undefined). So settings cannot make yolo the default. verified-source. (Invalid values throw at startup.)
- `security.disableYoloMode` (bool) blocks the `--yolo` flag; `admin.secureModeEnabled` also. Untrusted folders force `default`. verified-source.
- `auto_edit` auto-approves edit tools only. Not full access.
- Conclusion: there is no config-level high-severity risky-mode fail for Gemini. Only `auto_edit` gets an info row. A shell alias with `--yolo` is outside scope (unverified, not detectable from files).
- Policy engine (`~/.gemini/policies/*.toml`, admin dir `/Library/Application Support/GeminiCli/policies` etc.) can allow-all in yolo mode; not used for risky-mode.

### 2.3 .env protection
- `.geminiignore` lives in the project root, gitignore-like. https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-ignore.md verified-doc. Quote ~: tools that respect it exclude matching files; "still visible to other services".
- Settings `context.fileFiltering.respectGitIgnore` (default true) and `respectGeminiIgnore` (default true). verified-doc/source.
- `read_file` refuses a path when `fileDiscoveryService.shouldIgnoreFile` is true (gitignore + .geminiignore), message "ignored by configured ignore patterns". `read_many_files`/`glob` use the same filters. verified-source (packages/core/src/tools/read-file.ts).
- `.gitignore` is consulted only if the project root is a git repo (`isGitRepository`). verified-source (fileDiscoveryService.ts).
- Built-in: `read_many_files` default excludes include `**/.env` (exact name only, NOT `.env.local`, `.env.production`). `read_file` does NOT use the default excludes list. verified-source (ignorePatterns.ts, read-many-files.ts).
- No user-level (home) ignore file found. Only per project. verified-source (searched fileDiscoveryService). `customIgnoreFilePaths` exists in `context.fileFiltering` (doc). 
- Shell tool (`cat .env`) is not filtered. Policy engine user rules (`~/.gemini/policies/*.toml`, `decision = "deny"`, `toolName`, `argsPattern`, `commandPrefix`) can deny; no official example for denying `.env` reads. https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/policy-engine.md verified-doc. Workspace policies are currently disabled.

### 2.4 MCP
- `mcpServers.<name>`: `command,args,env,cwd` (stdio), `url` (SSE), `httpUrl` (streamable HTTP), `headers`, `timeout`, `trust`, `description`, `includeTools`, `excludeTools` (exclude wins). Transport precedence httpUrl > url > command. verified-doc.
- `env`/`headers` strings expand `$VAR`/`${VAR}` through the settings-wide resolver. Reference = value consisting of or containing `$NAME`/`${NAME}`; literal otherwise. verified-source.
- Gemini stores MCP in the same settings files (user/project/system), JSON with comments.

### 2.5 Version detection
- npm global: `<prefix>/lib/node_modules/@google/gemini-cli/package.json` `.version` (standard npm layout; prefixes `/usr/local`, `/opt/homebrew`, `~/.npm-global`, `~/.nvm/versions/node/*`, `~/.volta`). unverified (layout inferred).
- Homebrew: `/opt/homebrew/Cellar/gemini-cli/<ver>` (Apple Silicon), `/usr/local/Cellar/...` (Intel), `/home/linuxbrew/.linuxbrew/Cellar/...`. unverified.
- `gemini --version` output format: not verified (believed bare semver). Not needed: no check uses the Gemini version.
- Detection of "installed": `~/.gemini` dir OR binary `gemini` on PATH OR npm package dir.

### 2.6 Training / data use
- Per auth type (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/resources/tos-privacy.md, verified-source): Google account -> Gemini Code Assist (individuals / AI Pro-Ultra / Standard-Enterprise notices; individuals now discontinued); Gemini API key -> Gemini API Terms unpaid vs paid https://ai.google.dev/gemini-api/terms ; Vertex -> https://cloud.google.com/terms/cloud-privacy-notice.
- I did NOT verify the actual training/retention wording of those terms. Remind with links only, no claims.
- `privacy.usageStatisticsEnabled` (default true): anonymised usage statistics (tool names, model, durations, config); docs say it does not collect prompt, response or file content. It is NOT a training opt-out. verified-doc/source.
- Gemini Apps Activity (consumer account setting): not verified for Gemini CLI. Do not mention.

## 3. Proposed rules

General: parse with a tolerant JSONC reader (strip `//` and `/* */` outside strings, optionally trailing commas). Cursor `settings.json` is JSONC (30 comment lines here); Cursor `mcp.json`/`cli-config.json` are strict JSON here; Gemini settings allow comments. Read only structure; never put values in findings.

### 3.1 env-deny
Cursor (installed = app dir or `~/.cursor` or cursor-agent found):
- Read `~/.cursor/cli-config.json` and `<cwd>/.cursor/cli.json` -> `permissions.deny[]`; read `<cwd>/.cursorignore` as text (plain ignore file, not secret).
- covers(.env) when: a deny entry matches `/^Read\(\s*(\*\*\/|\.\/)?\.env(\*|\.\*|\.\*\*)?\s*\)$/` or contains `.env` inside `Read(...)`; or a `.cursorignore` line (non-comment, non-negated) equals one of `.env`, `.env*`, `.env.*`, `**/.env`, `**/.env*`, `**/.env.*`, `*.env`.
- pass: covers via either. Message: "Cursor: .env is covered by <file> (Agent file reads only; terminal and MCP tools can still read it)".
- fail: neither. Message: "Cursor agents can read .env files: no Read deny in ~/.cursor/cli-config.json and no .env rule in .cursorignore." Fix: "Add `Read(.env*)` to permissions.deny in ~/.cursor/cli-config.json and add `.env` and `.env.*` to .cursorignore. Cursor says protection is best effort and does not cover terminal/MCP tools."
- skip: Cursor not installed; or cwd is home / has no project markers (no `.git`, no `.env*`, no `.cursorignore`) and no global CLI deny -> still fail only for the CLI-global part? Simplest: in that case `skip` "run from a project folder".
- Do not count the default ignore list or `cursor.general.globalCursorIgnoreList` as pass (indexing-only per staff, and key not on disk).
- Safe auto-fix (JSON): in `~/.cursor/cli-config.json` add `"Read(.env*)"` to `permissions.deny` if absent (create `permissions` `{allow:[],deny:[]}` and `version:1` only if the file is missing; file is 180 KB with unrelated keys, so parse + stringify with 2 spaces, back up first; JSON order preserved). Second fix (text append, not JSON): append `.env` and `.env.*` lines to `<cwd>/.cursorignore`, create if missing. Edge: `deny` entry `Read(.env*)` only workspace-relative; deny does not stop Shell reads.

Gemini (installed = see 3.4):
- Inputs: merged settings (system > project > user for `context.fileFiltering.respectGitIgnore`/`respectGeminiIgnore`, default true), `<cwd>/.geminiignore`, `<cwd>/.gitignore` and `<cwd>/.git` (stat), `~/.gemini/policies/*.toml` text.
- pass when any: (a) `.geminiignore` has a covering line (same pattern list as Cursor) and `respectGeminiIgnore !== false`; (b) cwd has `.git` and `.gitignore` has a covering line and `respectGitIgnore !== false`; (c) a policy TOML has `decision = "deny"` and the text `.env` in the same `[[rule]]`.
- fail: none of these. Message: "Gemini CLI can read .env: no .geminiignore or gitignored .env, and no deny policy." Fix: "Create .geminiignore with `.env` and `.env.*`, or gitignore them. Gemini's shell tool is not filtered."
- Note: even in pass case, `cat .env` via shell works. Built-in `**/.env` exclude is only in `read_many_files`, so do not count it as pass.
- skip: Gemini not installed; or cwd is not a project (no `.git`, no `.env*`, no `.geminiignore`), reason "no user-level ignore exists; run from a project".
- Safe auto-fix: append `.env` and `.env.*` lines to `<cwd>/.geminiignore` (text, create if missing). If `respectGeminiIgnore` is `false` in a settings file, the fix is the JSON edit `context.fileFiltering.respectGeminiIgnore = true` (delete the key) in the file that sets it. No JSON array fix otherwise.

### 3.2 risky-mode
- Cursor CLI: read `~/.cursor/cli-config.json` `approvalMode`. fail (high) when `"unrestricted"`; pass for `allowlist`/`auto-review`/missing. Fix: set `approvalMode` to `"allowlist"` (single key edit, safe, back up). Also check `<cwd>/.cursor/cli.json`? Only permissions are honoured there, ignore.
- Cursor IDE: skip with reason "IDE run mode is not stored in a readable file (Run Everything is in Cursor's app storage)". No auto-fix.
- Gemini: no fail path from settings. `general.defaultApprovalMode == "auto_edit"` -> `info` "auto-approves file edits". `"yolo"` in settings -> `info` "ignored by Gemini CLI (yolo only via --yolo)". Pass otherwise. `security.disableYoloMode: true` may be mentioned as a pass note. No auto-fix. Invalid value -> info.
- Edge: system settings can override; read all three layers, highest priority wins (system > project > user).

### 3.3 mcp-plaintext
- Cursor files: `~/.cursor/mcp.json`, `<cwd>/.cursor/mcp.json`. For each `mcpServers.<name>`, scan `env` and `headers` (string values only).
- Reference if value matches `\$\{env:[A-Za-z_][A-Za-z0-9_]*\}` anywhere. Other `${...}` path vars (`userHome`, `workspaceFolder`) are not secrets. `envFile` present -> not flagged.
- Literal secret-looking when no reference and: key name matches `/(token|secret|key|password|passwd|auth|bearer|credential)/i` and value length >= 8; OR value matches known prefixes (`ghp_`, `github_pat_`, `sk-`, `xox`, `AKIA`, `AIza`, `pm-`...) or `Bearer ` + 16+ chars; OR 32+ char base64/hex-like. Do not flag `PATH`, `NODE_PATH`, `HOME`, `LANG`. Report `server.key` only.
- This machine would fail: 2 servers with a literal `headers.Authorization`. observed-local.
- Fix text: replace the value with `${env:NAME}` (e.g. `"Authorization": "Bearer ${env:GITHUB_TOKEN}"`) and export the variable. Auto-fix: NOT safe (needs the user to set the env var first, else the server breaks). No auto-fix.
- Gemini: same logic over `mcpServers.<name>.env|headers` in the three settings files; reference = contains `$NAME` or `${NAME}` (also `${NAME:-default}`: treat as reference). Fix text: `"Authorization": "Bearer $GITHUB_TOKEN"`. No auto-fix.
- Edge: `url` with a token in the query string (e.g. `?key=...`) is also a leak; unverified rule, report as warning only if the query key name matches the secret regex.

### 3.4 version detection
- Cursor IDE: macOS `/Applications/Cursor.app/Contents/Resources/app/package.json` `.version` (fallback `~/Applications/Cursor.app`, Info.plist). Linux/Windows: try the paths in 1.1, else version `null` (unverified paths). Cursor CLI: basename of the `readlink` target dir `.../cursor-agent/versions/<ver>/` (no exec). Report as version info only; no check uses it.
- Gemini: `package.json` under the npm/Homebrew paths in 2.5; else `null`. Never exec `gemini --version`.
- Agent id `cursor` = IDE and CLI combined; show `version` of IDE, mention CLI version in paths.

### 3.5 training reminder (info only)
- Cursor: "Cursor Settings > General > Privacy Mode: with it on, Cursor says your code is never used for training. https://cursor.com/help/security-and-privacy/privacy" (also https://cursor.com/data-use). Do not claim the on/off state; do not interpret `privacyCache.privacyMode`.
- Gemini: "Training use depends on how you sign in; see https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md. Note: Login with Google for personal accounts was discontinued; API key terms: https://ai.google.dev/gemini-api/terms; Vertex: https://cloud.google.com/terms/cloud-privacy-notice. `privacy.usageStatisticsEnabled` only controls anonymous usage stats, not training." No claim about what each tier does with prompts.

## 4. Could not verify
- Cursor Linux/Windows IDE and CLI install paths and version file location.
- Exact current name/location of the Cursor global ignore setting on disk (forum says `cursor.general.globalCursorIgnoreList`; absent from settings.json here).
- Whether Cursor's default ignore list, `.gitignore` or global list block Agent reads (docs silent; forum says indexing only).
- Where the IDE Run Everything / auto-run choice is stored; meaning of `privacyCache.privacyMode` values; whether `Read(.env*)` matches nested `.env`; `sandbox.mode` values.
- Gemini: legacy flat keys and `tools.autoAccept` history; trailing-comma tolerance; `gemini --version` format; Homebrew/npm global layouts; official June 18 2026 date; training/retention wording for each auth type; whether workspace policies become enabled.
