import { createRedisClient } from './redis.js';
import { AGENT_NAMES, GRADES } from './validate.js';
import { CHECK_IDS } from './scoring.js';

const MAX_KEYS = 200;
const STATUSES = ['pass', 'fail', 'skip'];
/** Days of distinct-sharer counts reported by snapshot(); sketches expire after SHARER_TTL_S. */
export const SHARER_DAYS = 14;
const SHARER_TTL_S = 16 * 86400;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** The SHARER_DAYS UTC days ending at t, oldest first. */
function recentDays(t) {
  const last = Date.parse(`${dayOf(t)}T00:00:00Z`);
  return Array.from({ length: SHARER_DAYS }, (_, i) => dayOf(last - (SHARER_DAYS - 1 - i) * 86400000));
}

function emptyStats() {
  return {
    total: 0,
    byDay: {},
    grade: Object.fromEntries(GRADES.map((g) => [g, 0])),
    os: {},
    toolVersion: {},
    agents: {},
    agentVersions: {},
    checks: {},
    via: {},
    sharersByDay: {},
  };
}

function bump(map, key, cap = Infinity) {
  const k = key in map || Object.keys(map).length < cap ? key : 'other';
  map[k] = (map[k] || 0) + 1;
}

function betterThan(gradeCounts, grade, total) {
  const worse = GRADES.slice(GRADES.indexOf(grade) + 1).reduce((n, g) => n + (gradeCounts[g] || 0), 0);
  return Math.round((100 * worse) / total);
}

/**
 * In-memory aggregate store (tests and local dev). Counters only, never individual scans.
 * Distinct sharers are kept as per-day sets of opaque sharer ids (memory only).
 * @param {{ now?: () => number }} [opts]
 */
export function createMemoryStore({ now = Date.now } = {}) {
  const stats = emptyStats();
  const sharers = new Map();

  return {
    /**
     * Add one validated scan to the counters.
     * @param {object} p validated payload
     * @param {{ sharer?: string }} [opts] opaque per-day sharer id (a keyed hash), if enabled
     * @returns {Promise<{ total: number, betterThan: number }>}
     */
    async record(p, { sharer } = {}) {
      const day = dayOf(now());
      stats.total += 1;
      bump(stats.byDay, day);
      stats.grade[p.grade] += 1;
      bump(stats.os, p.os);
      bump(stats.toolVersion, p.v, MAX_KEYS);
      for (const a of p.agents) {
        bump(stats.agents, a.name);
        const m = (stats.agentVersions[a.name] ||= {});
        bump(m, a.version ?? 'unknown', MAX_KEYS);
      }
      for (const [id, status] of Object.entries(p.checks)) {
        const c = (stats.checks[id] ||= { pass: 0, fail: 0, skip: 0 });
        c[status] += 1;
      }
      bump(stats.via, p.via);
      if (sharer) (sharers.get(day) || sharers.set(day, new Set()).get(day)).add(sharer);
      return { total: stats.total, betterThan: betterThan(stats.grade, p.grade, stats.total) };
    },
    async snapshot() {
      const s = structuredClone(stats);
      for (const d of recentDays(now())) {
        const n = sharers.get(d)?.size || 0;
        if (n) s.sharersByDay[d] = n;
      }
      return s;
    },
  };
}

// Capped hash increment: use the field if it exists or the hash has room, else `other`.
const BUMP_CAPPED = `local f = ARGV[1]
if redis.call('HEXISTS', KEYS[1], f) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[2]) then f = 'other' end
return redis.call('HINCRBY', KEYS[1], f, 1)`;

function hashToObject(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = Number(raw[i + 1]);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
  }
  return out;
}

/**
 * Redis aggregate store over the Upstash REST API.
 * Keys (all under `prefix`): `total` (string counter); hashes `byDay`, `grade`, `os`,
 * `toolVersion`, `agents`, `via`; `agentVersions:<agent>`; `checks:<id>` (fields pass, fail, skip);
 * HyperLogLog `sharers:<YYYY-MM-DD>` of opaque sharer ids, expiring after 16 days.
 * @param {{ url: string, token: string, fetch?: typeof fetch, prefix?: string, now?: () => number }} opts
 */
export function createRedisStore({ url, token, fetch = globalThis.fetch, prefix = 'alc:', now = Date.now }) {
  const redis = createRedisClient({ url, token, fetch });
  const k = (name) => `${prefix}${name}`;

  return {
    async record(p, { sharer } = {}) {
      const day = dayOf(now());
      const cmds = [
        ['INCR', k('total')],
        ['HINCRBY', k('byDay'), day, 1],
        ['HINCRBY', k('grade'), p.grade, 1],
        ['HINCRBY', k('os'), p.os, 1],
        ['EVAL', BUMP_CAPPED, 1, k('toolVersion'), p.v, MAX_KEYS],
      ];
      for (const a of p.agents) {
        cmds.push(['HINCRBY', k('agents'), a.name, 1]);
        cmds.push(['EVAL', BUMP_CAPPED, 1, k(`agentVersions:${a.name}`), a.version ?? 'unknown', MAX_KEYS]);
      }
      for (const [id, status] of Object.entries(p.checks)) {
        cmds.push(['HINCRBY', k(`checks:${id}`), status, 1]);
      }
      cmds.push(['HINCRBY', k('via'), p.via, 1]);
      if (sharer) {
        cmds.push(['PFADD', k(`sharers:${day}`), sharer]);
        cmds.push(['EXPIRE', k(`sharers:${day}`), SHARER_TTL_S]);
      }
      // Read the grade counts inside the same transaction so betterThan matches total.
      cmds.push(['HGETALL', k('grade')]);
      const results = await redis.multi(cmds);
      const total = Number(results[0]);
      const grades = hashToObject(results[results.length - 1]);
      if (!Number.isFinite(total) || total < 1) throw new Error('redis response invalid');
      return { total, betterThan: betterThan(grades, p.grade, total) };
    },

    async snapshot() {
      const cmds = [
        ['GET', k('total')],
        ['HGETALL', k('byDay')],
        ['HGETALL', k('grade')],
        ['HGETALL', k('os')],
        ['HGETALL', k('toolVersion')],
        ['HGETALL', k('agents')],
        ...AGENT_NAMES.map((n) => ['HGETALL', k(`agentVersions:${n}`)]),
        ...CHECK_IDS.map((id) => ['HGETALL', k(`checks:${id}`)]),
        ['HGETALL', k('via')],
      ];
      const days = recentDays(now());
      for (const d of days) cmds.push(['PFCOUNT', k(`sharers:${d}`)]);
      const r = await redis.pipeline(cmds);
      const s = emptyStats();
      s.total = Number(r[0]) || 0;
      s.byDay = hashToObject(r[1]);
      Object.assign(s.grade, hashToObject(r[2]));
      s.os = hashToObject(r[3]);
      s.toolVersion = hashToObject(r[4]);
      s.agents = hashToObject(r[5]);
      AGENT_NAMES.forEach((n, i) => {
        const m = hashToObject(r[6 + i]);
        if (Object.keys(m).length) s.agentVersions[n] = m;
      });
      CHECK_IDS.forEach((id, i) => {
        const m = hashToObject(r[6 + AGENT_NAMES.length + i]);
        if (Object.keys(m).length) {
          s.checks[id] = Object.fromEntries(STATUSES.map((st) => [st, m[st] || 0]));
        }
      });
      const base = r.length - days.length;
      s.via = hashToObject(r[base - 1]);
      days.forEach((d, i) => {
        const n = Number(r[base + i]) || 0;
        if (n) s.sharersByDay[d] = n;
      });
      return s;
    },
  };
}
