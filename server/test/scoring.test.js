import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeFor } from '../src/scoring.js';
import { checksWith } from './helpers.js';

test('gradeFor thresholds', () => {
  assert.equal(gradeFor(checksWith([])), 'A');
  assert.equal(gradeFor(checksWith(['secret-env'])), 'A');
  assert.equal(gradeFor(checksWith(['ssh'])), 'A'); // 90
  assert.equal(gradeFor(checksWith(['env-deny'])), 'B'); // 75
  assert.equal(gradeFor(checksWith(['env-deny', 'ssh'])), 'C'); // 65
  assert.equal(gradeFor(checksWith(['cc-version'])), 'A'); // 90
  assert.equal(gradeFor(checksWith(['env-deny', 'cc-version'])), 'C'); // 65
  assert.equal(gradeFor(checksWith(['env-deny', 'risky-mode'])), 'D'); // 50
  assert.equal(gradeFor(checksWith(['env-deny', 'risky-mode', 'cc-version', 'mcp-plaintext'])), 'F'); // 30
});
