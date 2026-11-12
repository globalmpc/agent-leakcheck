import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backupFile, addJsonArrayEntries, setJsonKey, setTomlTopLevelKey,
  registerFix, planFixes, applyFixes,
} from '../src/fix.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fix-'));
let n = 0;
const file = (name) => path.join(tmp, `${n++}-${name}`);
const baks = (p) => fs.readdirSync(tmp).filter((f) => f.startsWith(`${path.basename(p)}.leakcheck-bak-`));
const NOW = new Date(2026, 10, 12, 9, 5, 3);

test('backupFile names the copy with a local timestamp', () => {
  const p = file('a.json');
  fs.writeFileSync(p, 'orig');
  const b = backupFile(p, NOW);
  assert.equal(b, `${p}.leakcheck-bak-20261112090503`);
  assert.equal(fs.readFileSync(b, 'utf8'), 'orig');
});

test('addJsonArrayEntries changes only the intended key, backs up, is idempotent', () => {
  const p = file('s.json');
  fs.writeFileSync(p, JSON.stringify({ model: 'x', permissions: { allow: ['a'], deny: ['Read(./x)'] } }));
  const r = addJsonArrayEntries(p, ['permissions', 'deny'], ['Read(./.env*)', 'Read(./x)'], { now: NOW });
  assert.equal(r.changed, true);
  assert.equal(r.backup, `${p}.leakcheck-bak-20261112090503`);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n  "model"'));
  assert.deepEqual(JSON.parse(text), { model: 'x', permissions: { allow: ['a'], deny: ['Read(./x)', 'Read(./.env*)'] } });
  const again = addJsonArrayEntries(p, ['permissions', 'deny'], ['Read(./.env*)'], { now: new Date(2027, 0, 1) });
  assert.equal(again.changed, false);
  assert.equal(baks(p).length, 1);
});

test('addJsonArrayEntries creates missing objects, arrays and file (no backup for a new file)', () => {
  const p = file('new/settings.json');
  const r = addJsonArrayEntries(p, ['permissions', 'deny'], ['Read(./.env)'], { now: NOW });
  assert.deepEqual([r.changed, r.backup], [true, null]);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { permissions: { deny: ['Read(./.env)'] } });
});

test('JSONC and non-object files are refused and untouched', () => {
  const p = file('c.json');
  const text = '{\n // comment\n "permissions": {},\n}\n';
  fs.writeFileSync(p, text);
  const r = addJsonArrayEntries(p, ['permissions', 'deny'], ['x'], { now: NOW });
  assert.equal(r.changed, false);
  assert.ok(r.reason);
  assert.equal(setJsonKey(p, ['a'], 1, { now: NOW }).changed, false);
  assert.equal(fs.readFileSync(p, 'utf8'), text);
  assert.equal(baks(p).length, 0);
  const q = file('arr.json');
  fs.writeFileSync(q, '[1]');
  assert.equal(setJsonKey(q, ['a'], 1).changed, false);
  const w = file('wrong.json');
  fs.writeFileSync(w, '{"permissions":{"deny":"nope"}}');
  assert.equal(addJsonArrayEntries(w, ['permissions', 'deny'], ['x']).changed, false);
});

test('setJsonKey sets once and is idempotent', () => {
  const p = file('k.json');
  fs.writeFileSync(p, '{"keep":1,"a":{"b":false}}');
  assert.equal(setJsonKey(p, ['a', 'b'], true, { now: NOW }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { keep: 1, a: { b: true } });
  assert.equal(setJsonKey(p, ['a', 'b'], true, { now: NOW }).changed, false);
  assert.equal(baks(p).length, 1);
});

test('setTomlTopLevelKey inserts before the first table header', () => {
  const p = file('c.toml');
  fs.writeFileSync(p, 'model = "x"\n\n[mcp_servers.a]\ncommand = "a"\n');
  const r = setTomlTopLevelKey(p, 'approval_policy', 'on-request', { now: NOW });
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'model = "x"\napproval_policy = "on-request"\n\n[mcp_servers.a]\ncommand = "a"\n');
  assert.equal(setTomlTopLevelKey(p, 'approval_policy', 'on-request', { now: NOW }).changed, false);
  assert.equal(baks(p).length, 1);
});

test('setTomlTopLevelKey replaces an existing top-level line and handles edge layouts', () => {
  const p = file('r.toml');
  fs.writeFileSync(p, 'approval_policy = "never"\n[x]\ny = 1\n');
  assert.equal(setTomlTopLevelKey(p, 'approval_policy', 'untrusted', { now: NOW }).changed, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'approval_policy = "untrusted"\n[x]\ny = 1\n');
  const q = file('nohdr.toml');
  fs.writeFileSync(q, '[x]\ny = 1\n');
  setTomlTopLevelKey(q, 'k', 'v');
  assert.equal(fs.readFileSync(q, 'utf8'), 'k = "v"\n\n[x]\ny = 1\n');
  const m = file('missing.toml');
  setTomlTopLevelKey(m, 'k', true);
  assert.equal(fs.readFileSync(m, 'utf8'), 'k = true\n');
});

test('setTomlTopLevelKey refuses when the key is inside a table or duplicated', () => {
  const p = file('t.toml');
  const text = 'model = "x"\n[profiles.a]\napproval_policy = "never"\n';
  fs.writeFileSync(p, text);
  const r = setTomlTopLevelKey(p, 'approval_policy', 'on-request', { now: NOW });
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(p, 'utf8'), text);
  assert.equal(baks(p).length, 0);
  const d = file('d.toml');
  fs.writeFileSync(d, 'k = 1\nk = 2\n');
  assert.equal(setTomlTopLevelKey(d, 'k', 3).changed, false);
});

test('registry: plan from failing results, apply, second run changes nothing', () => {
  const p = file('reg.json');
  fs.writeFileSync(p, '{}');
  registerFix('test-fix', {
    describe: (ctx, r) => `add deny to ${r.agent}`,
    apply: (ctx, r, { now }) => {
      const out = addJsonArrayEntries(p, ['deny'], ['x'], { now });
      return out.changed ? { path: p, what: 'added deny', backup: out.backup } : null;
    },
  });
  const result = { checks: [{ results: [
    { agent: 'claude-code', status: 'fail', autoFix: 'test-fix' },
    { agent: 'codex', status: 'pass', autoFix: 'test-fix' },
    { agent: 'cursor', status: 'fail', autoFix: 'unregistered' },
    { agent: 'claude-code', status: 'fail', autoFix: 'test-fix' },
  ] }] };
  const plan = planFixes(result, {});
  assert.equal(plan.length, 1);
  assert.equal(plan[0].description, 'add deny to claude-code');
  const first = applyFixes(plan, {}, { now: NOW });
  assert.equal(first.changed.length, 1);
  assert.equal(first.changed[0].what, 'added deny');
  assert.ok(first.changed[0].backup);
  const second = applyFixes(plan, {}, { now: new Date(2030, 0, 1) });
  assert.deepEqual(second, { changed: [], skipped: [] });
  assert.equal(baks(p).length, 1);
});

test('backupFile never overwrites: same-second backups get -1, -2 suffixes', () => {
  const p = file('clash.json');
  fs.writeFileSync(p, 'one');
  const b0 = backupFile(p, NOW);
  fs.writeFileSync(p, 'two');
  const b1 = backupFile(p, NOW);
  const b2 = backupFile(p, NOW);
  assert.equal(b1, `${b0}-1`);
  assert.equal(b2, `${b0}-2`);
  assert.equal(fs.readFileSync(b0, 'utf8'), 'one');
  assert.equal(fs.readFileSync(b1, 'utf8'), 'two');
});

test('two fixes on one file with the same now keep the original bytes in the first backup', () => {
  const p = file('two.json');
  const original = '{"permissions":{"defaultMode":"bypassPermissions"}}';
  fs.writeFileSync(p, original);
  const a = addJsonArrayEntries(p, ['permissions', 'deny'], ['Read(x)'], { now: NOW });
  const b = setJsonKey(p, ['permissions', 'defaultMode'], 'default', { now: NOW });
  assert.notEqual(a.backup, b.backup);
  assert.equal(fs.readFileSync(a.backup, 'utf8'), original);
});

test('setTomlTopLevelKey matches quoted keys and replaces them with the bare key', () => {
  for (const q of ['"', "'"]) {
    const p = file('q.toml');
    fs.writeFileSync(p, `model = "x"\n${q}sandbox_mode${q} = "danger-full-access"\n[t]\na = 1\n`);
    const r = setTomlTopLevelKey(p, 'sandbox_mode', 'workspace-write', { now: NOW });
    assert.equal(r.changed, true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'model = "x"\nsandbox_mode = "workspace-write"\n[t]\na = 1\n');
  }
});

test('applyFixes returns refused steps as skipped with a fixed reason', () => {
  const p = file('bad.json');
  fs.writeFileSync(p, '{ // jsonc\n}');
  registerFix('test-refuse', {
    describe: () => 'x',
    apply: (ctx, r, { now }) => {
      const out = addJsonArrayEntries(p, ['deny'], ['x'], { now });
      return out.reason ? { path: out.path, skipped: out.reason } : null;
    },
  });
  const plan = planFixes({ checks: [{ results: [{ agent: 'a', status: 'fail', autoFix: 'test-refuse' }] }] }, {});
  const out = applyFixes(plan, {}, { now: NOW });
  assert.deepEqual(out, { changed: [], skipped: [{ path: p, reason: 'not valid strict JSON' }] });
});
