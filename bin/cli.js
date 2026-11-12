#!/usr/bin/env node
import os from 'node:os';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { VERSION, REPO_URL, endpoint } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { runScan } from '../src/scan.js';
import { WEIGHTS } from '../src/score.js';
import { formatHuman, formatJson } from '../src/report.js';
import { buildPayload, sendPayload } from '../src/share.js';
import { planFixes, applyFixes } from '../src/fix.js';
import checks from '../src/checks/index.js';

const OPTIONS = {
  json: { type: 'boolean' },
  fix: { type: 'boolean' },
  yes: { type: 'boolean' },
  show: { type: 'boolean' },
  share: { type: 'boolean' },
  badge: { type: 'boolean' },
  'fail-on': { type: 'string' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean' },
  version: { type: 'boolean' },
};

const BADGE_COLORS = { A: 'brightgreen', B: 'green', C: 'yellow', D: 'orange', F: 'red' };

const HELP = `agent-leakcheck ${VERSION}
Check what your coding agents (Claude Code, Codex, Cursor, Gemini CLI) can reach on your machine.

Usage: agent-leakcheck [flags]

Flags:
  --json       print the result as JSON (never prompts)
  --fix        show the planned safe fixes, then apply them after a backup
  --yes        apply --fix without asking (required when there is no TTY)
  --show       print the exact data that sharing would send; sends nothing
  --share      share anonymous results without the prompt
  --badge      print a README badge for your grade
  --fail-on L  exit 2 when a check of severity L or higher fails (high|medium), for CI
  --no-color   disable colors (NO_COLOR is respected too)
  --help       show this help
  --version    show the version

Exit codes: 0 done, 1 internal error, 2 usage error or --fail-on threshold met.

Grade: start at 100. Each failing high check costs ${WEIGHTS.high}, each failing medium check
costs ${WEIGHTS.medium}. Warnings and info never change the score.
A >= 90, B >= 75, C >= 60, D >= 40, F below.

Nothing is sent by default. If you turn sharing on, only the grade and pass/fail per check are sent.

${REPO_URL}`;

/**
 * Test-only overrides: AGENT_LEAKCHECK_HOME / AGENT_LEAKCHECK_CWD / AGENT_LEAKCHECK_SYSTEM_ROOT
 * point the scan at a fixture.
 */
function locations() {
  return {
    home: process.env.AGENT_LEAKCHECK_HOME || os.homedir(),
    cwd: process.env.AGENT_LEAKCHECK_CWD || process.cwd(),
    systemRoot: process.env.AGENT_LEAKCHECK_SYSTEM_ROOT || '/',
  };
}

async function scan() {
  const { home, cwd, systemRoot } = locations();
  const ctx = await buildContext({ home, cwd, systemRoot, platform: process.platform, env: process.env });
  return { ctx, result: await runScan(ctx, checks) };
}

function useColor(values) {
  return !values['no-color'] && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function share(result, via) {
  const url = endpoint();
  const sent = await sendPayload(buildPayload(result, process.platform, via), url);
  if (sent.ok) {
    console.log(
      `Thanks. Your setup is better than ${sent.betterThan}% of ${sent.total} shared scans. Stats: ${url}/`,
    );
  } else {
    console.log(`Could not share (${sent.reason}). Nothing else was sent.`);
  }
}

async function runFix(values) {
  const { ctx, result } = await scan();
  console.log(`Current grade: ${result.grade} (${result.score}/100)`);
  const plan = planFixes(result, ctx);
  if (plan.length === 0) {
    console.log('Nothing to fix automatically.');
    return;
  }
  console.log('Planned changes (a backup is made first):');
  for (const step of plan) console.log(`  - ${step.description}`);
  if (isInteractive() && !values.yes) {
    if (!(await confirm('Apply these changes? [y/N] '))) return;
  } else if (!values.yes) {
    console.log('Not applying: no TTY. Re-run with --yes to apply.');
    return;
  }
  const { changed, skipped } = applyFixes(plan, ctx, { now: new Date() });
  for (const c of changed) {
    console.log(`changed ${c.path}: ${c.what}${c.backup ? ` (backup: ${c.backup})` : ''}`);
  }
  for (const c of skipped) console.log(`skipped ${c.path}: ${c.reason}`);
  const after = (await scan()).result;
  console.log(`New grade: ${after.grade} (${after.score}/100)`);
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, strict: true }));
  } catch (err) {
    console.error(`agent-leakcheck: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 2;
    return;
  }
  const failOn = values['fail-on'];
  if (failOn !== undefined && failOn !== 'high' && failOn !== 'medium') {
    console.error('agent-leakcheck: --fail-on must be high or medium');
    console.error('Run with --help for usage.');
    process.exitCode = 2;
    return;
  }
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);
  if (values.fix && !values.json) return runFix(values);

  const { result } = await scan();
  const levels = failOn === 'high' ? ['high'] : ['high', 'medium'];
  // Set before choosing the output, so every output flag honours --fail-on.
  if (failOn && result.checks.some((c) => c.status === 'fail' && levels.includes(c.severity))) process.exitCode = 2;
  if (values.json) return void console.log(formatJson(result));
  if (values.badge) {
    const g = result.grade;
    return void console.log(
      `[![agent-leakcheck: ${g}](https://img.shields.io/badge/agent--leakcheck-${g}-${BADGE_COLORS[g]})](${REPO_URL})`,
    );
  }
  if (values.show) {
    console.log('This is exactly what --share would send. Nothing is sent now:');
    return void console.log(JSON.stringify(buildPayload(result, process.platform, 'flag'), null, 2));
  }
  // The banner is for people at a terminal; piped output and CI logs stay plain.
  console.log(formatHuman(result, { color: useColor(values), banner: Boolean(process.stdout.isTTY) }));
  if (values.share) return share(result, 'flag');
  if (isInteractive() && (await confirm('\nShare anonymous results? [y/N] '))) await share(result, 'prompt');
}

main().catch((err) => {
  console.error(`agent-leakcheck: internal error (${err && err.name ? err.name : 'Error'})`);
  process.exitCode = 1;
});
