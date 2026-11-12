// Minimal TOML reader for agent config files (Codex config.toml). Supports what those files
// use: comments, [table] / [a."b c"] headers, [[array.tables]], bare/quoted/dotted keys,
// basic and literal strings (incl. multi-line), numbers, booleans, dates (kept as strings),
// arrays (multi-line too) and inline tables. Never throws: bad input returns null.

class TomlError extends Error {}

function isBare(ch) {
  return /[A-Za-z0-9_-]/.test(ch);
}

/**
 * Parse TOML text into a plain object (prototype-less objects for tables).
 * @param {string} text
 * @returns {object|null}
 */
export function parseToml(text) {
  try {
    return new Parser(String(text)).parse();
  } catch {
    return null;
  }
}

function table() {
  return Object.create(null);
}

class Parser {
  constructor(src) {
    this.s = src.replace(/\r\n/g, '\n');
    this.i = 0;
  }

  peek(n = 0) {
    return this.s[this.i + n];
  }

  startsWith(str) {
    return this.s.startsWith(str, this.i);
  }

  skipWs() {
    while (this.peek() === ' ' || this.peek() === '\t') this.i++;
  }

  // Whitespace, newlines and comments (inside arrays).
  skipAll() {
    for (;;) {
      this.skipWs();
      if (this.peek() === '#') this.skipComment();
      else if (this.peek() === '\n') this.i++;
      else return;
    }
  }

  skipComment() {
    while (this.i < this.s.length && this.peek() !== '\n') this.i++;
  }

  endOfLine() {
    this.skipWs();
    if (this.peek() === '#') this.skipComment();
    if (this.i < this.s.length && this.peek() !== '\n') throw new TomlError('trailing data');
  }

  parse() {
    const root = table();
    let current = root;
    while (this.i < this.s.length) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '\n') {
        this.i++;
      } else if (ch === '#') {
        this.skipComment();
      } else if (ch === '[') {
        const isArray = this.peek(1) === '[';
        this.i += isArray ? 2 : 1;
        this.skipWs();
        const keys = this.key();
        this.skipWs();
        if (!this.startsWith(isArray ? ']]' : ']')) throw new TomlError('bad header');
        this.i += isArray ? 2 : 1;
        this.endOfLine();
        current = isArray ? this.arrayTable(root, keys) : this.descend(root, keys);
      } else if (ch === undefined) {
        break;
      } else {
        this.keyValue(current);
        this.endOfLine();
      }
    }
    return root;
  }

  descend(base, keys) {
    let t = base;
    for (const k of keys) {
      let next = t[k];
      if (next === undefined) next = t[k] = table();
      else if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        throw new TomlError('not a table');
      }
      t = next;
    }
    return t;
  }

  arrayTable(root, keys) {
    const parent = this.descend(root, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    if (parent[last] === undefined) parent[last] = [];
    if (!Array.isArray(parent[last])) throw new TomlError('not an array');
    const t = table();
    parent[last].push(t);
    return t;
  }

  keyValue(target) {
    const keys = this.key();
    this.skipWs();
    if (this.peek() !== '=') throw new TomlError('expected =');
    this.i++;
    this.skipWs();
    const value = this.value();
    const parent = this.descend(target, keys.slice(0, -1));
    parent[keys[keys.length - 1]] = value;
  }

  key() {
    const parts = [];
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '"') parts.push(this.basicString());
      else if (ch === "'") parts.push(this.literalString());
      else {
        const start = this.i;
        while (this.i < this.s.length && isBare(this.peek())) this.i++;
        if (this.i === start) throw new TomlError('empty key');
        parts.push(this.s.slice(start, this.i));
      }
      this.skipWs();
      if (this.peek() !== '.') return parts;
      this.i++;
    }
  }

  value() {
    const ch = this.peek();
    if (this.startsWith('"""')) return this.multiBasic();
    if (this.startsWith("'''")) return this.multiLiteral();
    if (ch === '"') return this.basicString();
    if (ch === "'") return this.literalString();
    if (ch === '[') return this.array();
    if (ch === '{') return this.inlineTable();
    if (this.startsWith('true')) {
      this.i += 4;
      return true;
    }
    if (this.startsWith('false')) {
      this.i += 5;
      return false;
    }
    const m = /^[0-9A-Za-z_+\-.:]+/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) throw new TomlError('bad value');
    this.i += m[0].length;
    const raw = m[0].replace(/_/g, '');
    const num = Number(raw);
    return /^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|inf|nan)$/.test(raw) && !Number.isNaN(num)
      ? num
      : m[0];
  }

  escape() {
    const c = this.peek();
    this.i++;
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = this.s.slice(this.i, this.i + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new TomlError('bad escape');
      this.i += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    throw new TomlError('bad escape');
  }

  basicString() {
    this.i++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '\n') throw new TomlError('unterminated string');
      this.i++;
      if (c === '"') return out;
      out += c === '\\' ? this.escape() : c;
    }
  }

  literalString() {
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf('\n', this.i);
    if (end === -1 || (nl !== -1 && nl < end)) throw new TomlError('unterminated string');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }

  multiBasic() {
    this.i += 3;
    if (this.peek() === '\n') this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) throw new TomlError('unterminated string');
      if (this.startsWith('"""')) {
        this.i += 3;
        return out;
      }
      const c = this.peek();
      this.i++;
      if (c !== '\\') {
        out += c;
      } else if (/^[ \t]*\n/.test(this.s.slice(this.i))) {
        while (/[ \t\n]/.test(this.peek() || '')) this.i++;
      } else {
        out += this.escape();
      }
    }
  }

  multiLiteral() {
    this.i += 3;
    if (this.peek() === '\n') this.i++;
    const end = this.s.indexOf("'''", this.i);
    if (end === -1) throw new TomlError('unterminated string');
    const out = this.s.slice(this.i, end);
    this.i = end + 3;
    return out;
  }

  array() {
    this.i++;
    const out = [];
    for (;;) {
      this.skipAll();
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.skipAll();
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== ']') throw new TomlError('bad array');
    }
  }

  inlineTable() {
    this.i++;
    const t = table();
    this.skipWs();
    if (this.peek() === '}') {
      this.i++;
      return t;
    }
    for (;;) {
      this.keyValue(t);
      this.skipWs();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === '}') {
        this.i++;
        return t;
      }
      throw new TomlError('bad inline table');
    }
  }
}
