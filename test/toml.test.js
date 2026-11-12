import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '../src/toml.js';

const plain = (o) => JSON.parse(JSON.stringify(o));

test('top-level keys, comments and types', () => {
  const t = parseToml(
    [
      '# comment',
      'model = "gpt-5" # trailing',
      "sandbox_mode = 'danger-full-access'",
      'n = 1_000',
      'f = 0.5',
      'on = true',
      'off = false',
      'when = 1979-05-27T07:32:00Z',
      '',
    ].join('\n'),
  );
  assert.deepEqual(plain(t), {
    model: 'gpt-5',
    sandbox_mode: 'danger-full-access',
    n: 1000,
    f: 0.5,
    on: true,
    off: false,
    when: '1979-05-27T07:32:00Z',
  });
});

test('tables, quoted and dotted keys, inline tables', () => {
  const t = parseToml(
    [
      'default_permissions = "dev"',
      '[permissions.dev.filesystem]',
      '"**/*.env" = "deny"',
      '[permissions.dev.filesystem.":workspace_roots"]',
      '"**/.env" = "deny"',
      '[mcp_servers.gh]',
      'command = "npx"',
      'env = { GITHUB_TOKEN = "x", "QUOTED KEY" = "y" }',
      'http_headers.Authorization = "Bearer z"',
      '[mcp_servers.gh.env2]',
      'A = "1"',
    ].join('\n'),
  );
  assert.equal(t.default_permissions, 'dev');
  assert.equal(t.permissions.dev.filesystem['**/*.env'], 'deny');
  assert.equal(t.permissions.dev.filesystem[':workspace_roots']['**/.env'], 'deny');
  assert.deepEqual(plain(t.mcp_servers.gh.env), { GITHUB_TOKEN: 'x', 'QUOTED KEY': 'y' });
  assert.equal(t.mcp_servers.gh.http_headers.Authorization, 'Bearer z');
  assert.equal(t.mcp_servers.gh.env2.A, '1');
});

test('multi-line arrays, strings and array tables', () => {
  const t = parseToml(
    [
      'args = [',
      '  "-y", # comment',
      '  "pkg",',
      ']',
      'doc = """',
      'line1',
      'line2"""',
      "raw = '''a\\b'''",
      'esc = "tab\\there \\u00e9"',
      '[[profiles_list]]',
      'name = "a"',
      '[[profiles_list]]',
      'name = "b"',
      '[profiles_list.sub]',
      'x = 1',
    ].join('\n'),
  );
  assert.deepEqual(t.args, ['-y', 'pkg']);
  assert.equal(t.doc, 'line1\nline2');
  assert.equal(t.raw, 'a\\b');
  assert.equal(t.esc, 'tab\there é');
  assert.equal(t.profiles_list.length, 2);
  assert.equal(t.profiles_list[1].name, 'b');
  assert.equal(t.profiles_list[1].sub.x, 1);
});

test('bad input returns null, never throws', () => {
  for (const bad of ['a = ', 'a = "open', '[unclosed', 'a = 1 b', 'x = 1\n[x]', '= 1', 'a = {b = 1']) {
    assert.equal(parseToml(bad), null, bad);
  }
  assert.equal(parseToml(undefined) !== undefined, true);
});

test('__proto__ keys do not pollute', () => {
  const t = parseToml('[__proto__]\npolluted = true\n[a]\n__proto__ = 1');
  assert.equal({}.polluted, undefined);
  assert.equal(t.__proto__.polluted, true);
  assert.equal(Object.getPrototypeOf(t), null);
});
