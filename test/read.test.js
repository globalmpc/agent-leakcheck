import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readText, readJson, exists, stat, listDir, isSecretPath, SecretPathError, stripJsonc } from '../src/read.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-read-'));
afterEach(() => mock.restoreAll());

const SECRET = [
  '/h/.env', '/h/.env.local', '/h/proj/.env.production', '/h/.envrc', '/h/.ssh/config',
  '/h/.ssh/known_hosts', '/h/.ssh/sub/anything', '/h/x/id_rsa', '/h/x/id_ed25519.pub',
  '/h/x/a.pem', '/h/x/a.key', '/h/x/a.p12', '/h/x/a.pfx', '/h/.codex/auth.json',
  '/h/.claude/.credentials.json', '/h/.git-credentials', '/h/.netrc', '/h/.npmrc', '/h/.pypirc',
];
SECRET.push('/h/.CLAUDE/.Credentials.json', '/h/.ENV', '/h/x/ID_RSA', '/h/.SSH/config', '/h/.Codex/Auth.json', '/h/x/A.PEM');
const PUBLIC = ['/h/.codex/config.toml', '/h/.environment', '/h/auth.json', '/h/.claude.json', '/h/ssh/config', '/h/.claude/settings.json', '/h/.credentials.json', '/h/x/.credentials.json'];

test('isSecretPath matches every secret pattern and nothing else', () => {
  for (const p of SECRET) assert.equal(isSecretPath(p), true, p);
  for (const p of PUBLIC) assert.equal(isSecretPath(p), false, p);
});

test('readText/readJson throw for secret paths without opening anything', () => {
  const rf = mock.method(fs, 'readFileSync');
  const op = mock.method(fs, 'openSync');
  for (const p of SECRET) {
    assert.throws(() => readText(p), SecretPathError, p);
    assert.throws(() => readJson(p), SecretPathError, p);
  }
  assert.equal(rf.mock.calls.length, 0);
  assert.equal(op.mock.calls.length, 0);
});

test('a symlink to a secret file is refused too', () => {
  const target = path.join(tmp, '.env');
  fs.writeFileSync(target, 'FAKE=1\n');
  const link = path.join(tmp, 'innocent.txt');
  fs.symlinkSync(target, link);
  assert.throws(() => readText(link), SecretPathError);
});

test('stat, exists and listDir work on secret paths', () => {
  const dir = path.join(tmp, 'home', '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'fake', { mode: 0o600 });
  assert.equal(exists(path.join(dir, 'id_rsa')), true);
  const st = stat(path.join(dir, 'id_rsa'));
  assert.equal(st.isFile, true);
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(listDir(dir), ['id_rsa']);
});

test('missing files give null, false and []', () => {
  const p = path.join(tmp, 'nope.json');
  assert.equal(readText(p), null);
  assert.equal(readJson(p), null);
  assert.equal(exists(p), false);
  assert.equal(stat(p), null);
  assert.deepEqual(listDir(p), []);
});

test('readJson: strict by default, jsonc strips comments and trailing commas', () => {
  const p = path.join(tmp, 's.json');
  fs.writeFileSync(p, '{\n // c\n "a": "http://x//y", /* b */ "b": [1, 2,],\n}\n');
  assert.equal(readJson(p), null);
  assert.deepEqual(readJson(p, { jsonc: true }), { a: 'http://x//y', b: [1, 2] });
  fs.writeFileSync(p, '{ not json');
  assert.equal(readJson(p, { jsonc: true }), null);
});

test('stripJsonc keeps comment-like text and commas inside strings', () => {
  assert.equal(stripJsonc('{"a":"/* x */, ]"}'), '{"a":"/* x */, ]"}');
});

test('readText strips a leading UTF-8 BOM so readJson parses', () => {
  const f = path.join(tmp, 'bom.json');
  fs.writeFileSync(f, '\uFEFF{"a":1}');
  assert.equal(readText(f), '{"a":1}');
  assert.deepEqual(readJson(f), { a: 1 });
});
