// Zero-dependency lint: syntax check + import guards + no-dependencies rule.
//
// Guards apply to bin/, src/, scripts/. Not checked: test/ and server/ (syntax only).
// Exemptions, on purpose:
//   - scripts/ is exempt from the fs, network and child_process rules (this script and the
//     tracking script need them; they are never part of the scan path).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SYNTAX_DIRS = ['bin', 'src', 'scripts', 'test', 'server'];
const GUARD_DIRS = ['bin', 'src', 'scripts'];

const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dns', 'dns/promises', 'dgram', 'undici'];
const FS_MODULES = ['fs', 'fs/promises'];
const EXEC_MODULES = ['child_process'];

const NET_ALLOWED = ['src/share.js'];
const FS_ALLOWED = ['src/read.js', 'src/fix.js'];
const EXEC_ALLOWED = ['src/exec.js'];

const violations = [];
const rel = (f) => relative(ROOT, f).split(sep).join('/');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function specifiers(text) {
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  return [...text.matchAll(re)].map((m) => m[1].replace(/^node:/, ''));
}

function checkSyntax() {
  for (const d of SYNTAX_DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) violations.push(`${rel(f)}: syntax error`);
    }
  }
}

function checkImports() {
  for (const d of GUARD_DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const name = rel(f);
      if (name.startsWith('scripts/')) continue;
      const text = readFileSync(f, 'utf8');
      const specs = specifiers(text);
      const bad = (list, allowed, rule) => {
        if (specs.some((s) => list.includes(s)) && !allowed.includes(name)) violations.push(`${name}: ${rule}`);
      };
      bad(NET_MODULES, NET_ALLOWED, 'network module import outside src/share.js');
      bad(FS_MODULES, FS_ALLOWED, 'fs import outside src/read.js and src/fix.js');
      bad(EXEC_MODULES, EXEC_ALLOWED, 'child_process import outside src/exec.js');
      if (text.includes('fetch(') && !NET_ALLOWED.includes(name)) {
        violations.push(`${name}: fetch( outside src/share.js`);
      }
    }
  }
}

function checkDependencies() {
  for (const p of ['package.json', 'server/package.json']) {
    const file = join(ROOT, p);
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const key of ['dependencies', 'devDependencies']) {
      if (pkg[key] && Object.keys(pkg[key]).length > 0) violations.push(`${p}: non-empty ${key}`);
    }
  }
}

checkSyntax();
checkImports();
checkDependencies();

if (violations.length) {
  for (const v of violations) console.log(v);
  process.exit(1);
}
console.log('lint: ok');
