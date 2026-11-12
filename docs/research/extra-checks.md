# Research: credential files, broad allow rules, MCP auto-approve (fetched 2026-11-12)

Status tags as in the other research files: `verified-doc` (official docs page read today), `unverified`.
Quotes are copied from the page unless marked "~" (close paraphrase).

## 1. Credential files (check `cred-perms`, stat only)

| Fact | Source | Status |
|---|---|---|
| Claude Code: "credentials are stored in `~/.claude/.credentials.json` with file mode `0600`" (Linux/Windows). On macOS the login is stored in the Keychain, so the file may be absent. `CLAUDE_CONFIG_DIR` moves the directory. | https://code.claude.com/docs/en/authentication | verified-doc |
| Codex: "treat `~/.codex/auth.json` like a password: it contains access tokens". `CODEX_HOME` moves the directory. A `0600` target is our inference from "like a password". | https://learn.chatgpt.com/docs/auth | verified-doc (mode target inferred) |
| git: "The `.git-credentials` file is stored in plaintext" (`~/.git-credentials`, written by `git credential-store`). | https://git-scm.com/docs/git-credential-store | verified-doc |

Rule: fail when the file exists and `mode & 0o077` is non-zero (group or others can read). Never open the file.

## 2. Broad allow rules (extends check `risky-mode`)

| Fact | Source | Status |
|---|---|---|
| Claude Code: "`Bash(*)` is equivalent to `Bash` and matches all Bash commands". An allow rule skips the permission prompt. | https://code.claude.com/docs/en/permissions | verified-doc |
| Gemini CLI `tools.allowed`: "Tool names that bypass the confirmation dialog". A bare `run_shell_command` entry covers every shell command. | https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md | verified-doc |
| Gemini CLI scoped shell entries: `tools.allowed` example `["run_shell_command(git)", "run_shell_command(npm test)"]`, so a scoped entry is not a broad allow. (The old docs/get-started/configuration.md path now returns 404.) | same page | verified-doc |
| Gemini CLI `security.enablePermanentToolApproval`: "Enable the 'Allow for all future sessions' option in tool confirmation dialogs". | same page | verified-doc |

## 3. MCP auto-approve (check `mcp-autoapprove`)

| Fact | Source | Status |
|---|---|---|
| Claude Code `enableAllProjectMcpServers`: "Approve every server in project .mcp.json files without a prompt". When committed in a project's own settings it is ignored until the folder is trusted, so only user and local settings are graded. | https://code.claude.com/docs/en/mcp | verified-doc |
| Claude Code `enabledMcpjsonServers`: "Approve specific servers from a project's `.mcp.json`" (settings index, scope: any file). It is the narrower alternative to `enableAllProjectMcpServers`. | https://code.claude.com/docs/en/settings-reference.md | verified-doc |

## 4. Peer tools (positioning, not grading)

snyk/agent-scan, cisco mcp-scanner, agentshield (A–F grade, closest peer), codegate, audr, sandshell, Trail of Bits claude-code-config.
Common CLI conventions: exit 0 clean, 1 runtime error, 2 findings at or above a threshold; a `schemaVersion` field in JSON output.
