import { test } from 'node:test';
import assert from 'node:assert/strict';
import check from '../../src/checks/cc-version.js';

const run = (version, present = true) =>
  check.run({ agents: present ? [{ id: 'claude-code', version, paths: {} }] : [] });

test('metadata', () => {
  assert.equal(check.id, 'cc-version');
  assert.equal(check.severity, 'medium');
  assert.match(check.docs[0], /#cc-version$/);
});

test('pass at and above 2.1.317, numeric compare', () => {
  for (const v of ['2.1.317', '2.1.322', '2.2.0', '3.0.0', '2.1.1000', '2.1.317-beta.1']) {
    assert.equal(run(v)[0].status, 'pass', v);
  }
});

test('fail below 2.1.317 with the documented message and fix', () => {
  for (const v of ['2.1.316', '2.1.9', '2.0.999', '1.9.9999']) {
    const [r] = run(v);
    assert.equal(r.status, 'fail', v);
    assert.equal(
      r.message,
      `Claude Code ${v} is older than 2.1.317, the first release that checks before your account email is sent to the network (anthropics/claude-code#107757).`,
    );
    assert.equal(r.fix, 'Run `claude update` (native install) or `npm i -g @anthropic-ai/claude-code@latest`.');
  }
});

test('skip when absent or version unknown or not semver', () => {
  assert.equal(run(null, false)[0].status, 'skip');
  assert.equal(run(null)[0].status, 'skip');
  assert.equal(run('latest')[0].status, 'skip');
});
