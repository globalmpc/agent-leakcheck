/** Points lost per failing check id, by severity. Warning and info never count. */
export const WEIGHTS = { high: 25, medium: 10 };

/**
 * Letter grade for a numeric score.
 * @param {number} score
 * @returns {'A'|'B'|'C'|'D'|'F'}
 */
export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Score and grade from check-level results. Each failing check id counts once.
 * @param {Array<{severity: string, status: string}>} checks
 * @returns {{ score: number, grade: string }}
 */
export function computeScore(checks) {
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= WEIGHTS[c.severity] || 0;
  }
  score = Math.max(0, score);
  return { score, grade: gradeFor(score) };
}
