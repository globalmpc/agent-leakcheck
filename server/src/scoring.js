// Keep in sync with the CLI's src/score.js (docs/SPEC.md, section "Grade").

/** Penalty per check id when it has status `fail`. Warning-level checks weigh 0. */
export const CHECK_WEIGHTS = {
  'cc-version': 10,
  'env-deny': 25,
  'risky-mode': 25,
  'mcp-plaintext': 10,
  'mcp-autoapprove': 10,
  'gh-token': 10,
  ssh: 10,
  'cred-perms': 10,
  'secret-env': 0,
};

export const CHECK_IDS = Object.keys(CHECK_WEIGHTS);

/**
 * Compute the grade from per-check statuses.
 * @param {Record<string, string>} checks check id to pass|fail|skip
 * @returns {'A'|'B'|'C'|'D'|'F'}
 */
export function gradeFor(checks) {
  let score = 100;
  for (const id of CHECK_IDS) {
    if (checks[id] === 'fail') score -= CHECK_WEIGHTS[id];
  }
  score = Math.max(0, score);
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}
