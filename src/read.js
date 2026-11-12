// The ONLY module that reads the filesystem for the scan.
// Secret files (.env*, SSH keys, credential stores) are never opened: reads throw.
import fs from 'node:fs';

const MAX_BYTES = 20 * 1024 * 1024;
const SECRET_BASENAMES = new Set(['.envrc', '.git-credentials', '.netrc', '.npmrc', '.pypirc']);

/** Thrown when a caller tries to read the contents of a secret file. */
export class SecretPathError extends Error {
  constructor() {
    super('refusing to read a secret file');
    this.name = 'SecretPathError';
  }
}

/**
 * True when the path points at a file whose contents must never be read.
 * @param {string} p
 * @returns {boolean}
 */
export function isSecretPath(p) {
  const parts = String(p).toLowerCase().split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] || '';
  if (/^\.env(\..+)?$/.test(base) || SECRET_BASENAMES.has(base)) return true;
  if (parts.slice(0, -1).includes('.ssh')) return true;
  if (/^id_/.test(base) || /\.(pem|key|p12|pfx)$/.test(base)) return true;
  const n = parts.length;
  if (n >= 2 && parts[n - 2] === '.codex' && base === 'auth.json') return true;
  return n >= 2 && parts[n - 2] === '.claude' && base === '.credentials.json';
}

function assertReadable(p) {
  if (isSecretPath(p)) throw new SecretPathError();
  let real = null;
  try {
    real = fs.realpathSync(p);
  } catch {
    return;
  }
  if (isSecretPath(real)) throw new SecretPathError();
}

/**
 * Read a text file. Null when missing, unreadable or larger than 20 MB.
 * @param {string} p
 * @returns {string|null}
 */
export function readText(p) {
  assertReadable(p);
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    // A leading BOM (Windows editors) would make JSON.parse fail.
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/**
 * Remove comments and trailing commas (outside strings) from JSONC text.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return dropTrailingCommas(out);
}

function dropTrailingCommas(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Read and parse a JSON file. Null when missing or invalid.
 * @param {string} p
 * @param {{ jsonc?: boolean }} [opts] jsonc: allow comments and trailing commas
 * @returns {any|null}
 */
export function readJson(p, { jsonc = false } = {}) {
  const text = readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(jsonc ? stripJsonc(text) : text);
  } catch {
    return null;
  }
}

function toStat(st) {
  return {
    mode: st.mode,
    isFile: st.isFile(),
    isDir: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
    size: st.size,
    uid: st.uid,
  };
}

/**
 * Stat a path, following symlinks. Allowed on secret paths.
 * @param {string} p
 * @returns {{mode:number,isFile:boolean,isDir:boolean,isSymlink:boolean,size:number}|null}
 */
export function stat(p) {
  try {
    return toStat(fs.statSync(p));
  } catch {
    return null;
  }
}

/**
 * Stat a path without following symlinks.
 * @param {string} p
 * @returns {{mode:number,isFile:boolean,isDir:boolean,isSymlink:boolean,size:number}|null}
 */
export function lstat(p) {
  try {
    return toStat(fs.lstatSync(p));
  } catch {
    return null;
  }
}

/**
 * Target of a symlink, or null when the path is not a symlink. Allowed on secret paths
 * (only the link text is read, never the target's contents).
 * @param {string} p
 * @returns {string|null}
 */
export function readlink(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * True when the path exists.
 * @param {string} p
 * @returns {boolean}
 */
export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Directory entry names, or [] when missing.
 * @param {string} p
 * @returns {string[]}
 */
export function listDir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

