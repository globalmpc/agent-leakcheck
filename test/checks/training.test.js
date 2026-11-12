import { test } from 'node:test';
import assert from 'node:assert/strict';
import check from '../../src/checks/training.js';

const ctxOf = (ids) => ({ agents: ids.map((id) => ({ id, paths: {} })) });

test('one info row per detected agent', () => {
  const rows = check.run(ctxOf(['claude-code', 'codex', 'gemini', 'cursor']));
  assert.deepEqual(rows.map((r) => r.agent), ['claude-code', 'codex', 'gemini', 'cursor']);
  assert.ok(rows.every((r) => r.status === 'info'));
  assert.match(rows[0].message, /claude\.ai\/settings\/data-privacy-controls/);
  assert.match(rows[1].message, /help\.openai\.com\/en\/articles\/7730893/);
  assert.match(rows[2].message, /myactivity\.google\.com\/product\/gemini/);
  assert.match(rows[3].message, /cursor\.com\/data-use/);
  assert.ok(rows.every((r) => !/\b(is|are) (on|off|used|enabled)\b/i.test(r.message)));
});

test('skip when no agent detected', () => {
  assert.deepEqual(check.run(ctxOf([])).map((r) => r.status), ['skip']);
});

test('metadata', () => {
  assert.equal(check.severity, 'info');
  assert.match(check.docs[0], /#training$/);
});
