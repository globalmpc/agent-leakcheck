import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, gradeFor, WEIGHTS } from '../src/score.js';

const c = (severity, status) => ({ severity, status });

test('weights', () => assert.deepEqual(WEIGHTS, { high: 25, medium: 10 }));

test('no failures is 100 / A', () => assert.deepEqual(computeScore([c('high', 'pass')]), { score: 100, grade: 'A' }));

test('high and medium failures subtract once per check', () => {
  assert.deepEqual(computeScore([c('high', 'fail'), c('medium', 'fail')]), { score: 65, grade: 'C' });
});

test('warning and info never change the score', () => {
  assert.equal(computeScore([c('warning', 'fail'), c('info', 'info'), c('warning', 'fail')]).score, 100);
});

test('floor at 0', () => {
  const many = Array.from({ length: 6 }, () => c('high', 'fail'));
  assert.deepEqual(computeScore(many), { score: 0, grade: 'F' });
});

test('grade boundaries', () => {
  const cases = [[100, 'A'], [90, 'A'], [89, 'B'], [75, 'B'], [74, 'C'], [60, 'C'], [59, 'D'], [40, 'D'], [39, 'F'], [0, 'F']];
  for (const [s, g] of cases) assert.equal(gradeFor(s), g, String(s));
});
