// The ONLY module that imports node:child_process. No generic exec is exported:
// callers get narrow helpers via ctx.exec. execFile only (never a shell).
import cp from 'node:child_process';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;
const VERSION_COMMANDS = ['claude', 'codex', 'gemini', 'cursor-agent'];

function run(file, args) {
  return new Promise((resolve) => {
    try {
      cp.execFile(
        file,
        args,
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, windowsHide: true },
        (err, stdout) => {
          const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
          resolve({ code, stdout: String(stdout || '') });
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Number of keys loaded in ssh-agent (`ssh-add -l`). Output never leaves this function.
 * @returns {Promise<number|null>} null when it cannot be determined
 */
export async function sshAgentKeyCount() {
  const r = await run('ssh-add', ['-l']);
  if (!r) return null;
  if (r.code === 0) return r.stdout.split('\n').filter((l) => l.trim() !== '').length;
  if (r.code === 1) return 0;
  return null;
}

/**
 * Version of an agent binary (`<cmd> --version`). Only allowlisted commands run.
 * @param {string} cmd one of claude, codex, gemini, cursor-agent
 * @returns {Promise<string|null>} first semver-looking token, or null
 */
export async function binaryVersion(cmd) {
  if (!VERSION_COMMANDS.includes(cmd)) return null;
  const r = await run(cmd, ['--version']);
  if (!r || r.code !== 0) return null;
  const m = r.stdout.match(/\d+\.\d+\.\d+[^\s]*/);
  return m ? m[0] : null;
}
