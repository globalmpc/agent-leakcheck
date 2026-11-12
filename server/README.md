<h1 align="center">agent-leakcheck server</h1>

<p align="center">
  <b>The share endpoint and the <a href="https://agent-leakcheck.vercel.app">live stats page</a> for <a href="../README.md">agent-leakcheck</a>.</b><br>
  Counters only: no individual scans, no IP addresses.
</p>

When you share a scan from the CLI, it goes here. The server checks the payload, adds it to a few counters and forgets it. Node >= 20, ESM, zero dependencies (Node stdlib and global `fetch` only). It runs as a Vercel Function with Upstash Redis.

## Privacy

- **Aggregates only.** Only counters are stored, never individual scans.
- **Nothing about you is kept.** No IP addresses, user agents, headers or bodies are stored or logged. Logs hold a startup line and generic errors.
- **Rate limit without IPs.** The limit is 20 POSTs per minute per client, as a Redis fixed window. Only a truncated HMAC-SHA256 of the client key is stored, in counters that expire after two minutes. Raw IPs are never stored.
- **Distinct sharers per day** (only with `STATS_SALT`). The id is HMAC-SHA256(`STATS_SALT`, UTC day + client key), truncated to 32 hex chars and added to that day's HyperLogLog, which expires after 16 days. The day in the input makes ids unlinkable across days, and the sketch gives only an estimated count: it cannot list ids or IPs.
- **Bounded maps.** Distinct tool and agent version keys are capped at 200 per map; overflow is counted under `other`.
- **No secrets in output.** Redis errors are answered with a generic `503`. The Redis URL and token never appear in responses or logs.

<details>
<summary>How the client key is derived</summary>

The client key is `X-Real-IP`, else the rightmost `X-Forwarded-For` entry, else the socket address. On Vercel both headers carry the public client IP and are overwritten, not forwarded ([Vercel docs](https://vercel.com/docs/headers/request-headers)). The HMAC is keyed with `STATS_SALT`, else the Redis token, so hashes of the small IPv4 space cannot be matched.

</details>

## API

| Route | What it does |
|---|---|
| `POST /api/scan` | Accepts one shared scan and returns how it compares. |
| `GET /api/stats` (also `HEAD`) | Aggregates as JSON. |
| `GET /` | The stats page: server-rendered, no scripts, no external requests. |
| `GET /healthz` | `ok`. |

### `POST /api/scan`

Send `content-type: application/json`. The body has exactly these keys and nothing else:

```text
{ "v", "os", "grade", "agents": [{ "name", "version" }], "checks": { "<id>": "pass|fail|skip" }, "via" }
```

Success: `200 { "ok": true, "total", "betterThan" }`.

| Status | When |
|---|---|
| `400` | Bad JSON or schema |
| `413` | Body over 2048 bytes |
| `415` | Wrong content type |
| `429` | Rate limit |
| `503` | Storage unavailable |

Errors come back as `{ "ok": false, "error": "<short reason>" }`. The reason never echoes input values.

`checks` must contain exactly the 9 ids, and `grade` must match the grade recomputed from them (weights in `src/scoring.js`, kept in sync with the CLI).

| Field | Allowed values |
|---|---|
| `os` | `macos`, `linux`, `windows`, `other` |
| `grade` | `A` to `F` |
| `via` | `prompt` (answered y to the share prompt) or `flag` (`--share`) |
| `agents[].name` | `claude-code`, `codex`, `cursor`, `gemini` (0 to 4, unique) |
| `checks` ids | `cc-version`, `env-deny`, `risky-mode`, `mcp-plaintext`, `mcp-autoapprove`, `gh-token`, `ssh`, `cred-perms`, `secret-env` |
| `v`, `agents[].version` | `^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]{1,20})?$` (agent version may be `null`) |

### `GET /api/stats` and `GET /`

`/api/stats` returns the aggregates, `failRate` per check (fail / (pass + fail), `null` when 0) and `generatedAt`. With `STATS_SALT` set it also returns `sharersByDay`, the estimated distinct sharers for the last 14 UTC days.

The page shows the total with the prompt / `--share` split, shares per day for the last 14 UTC days (with a people column when `STATS_SALT` is set), grades, fail rate per check and agents.

Both are cached for 60 s in the browser and the Vercel CDN (`public, max-age=60, s-maxage=60`), so page views do not each hit Redis.

## Run locally

```sh
cd server
npm start   # PORT=3000, in-memory storage unless Redis env vars are set
npm test    # node --test, fully offline (Redis is faked)
```

`index.js` is for local development only. Without a Redis URL and token it keeps stats in memory (lost on restart).

## Self-host on Vercel

1. Import the repo as a Vercel project and set its **root directory** to `server`.
2. Add an **Upstash Redis** store from the Vercel Marketplace and connect it to the project. The function reads these env vars (the first name of each pair wins; see `../.env.example`):

   | Variable | Meaning |
   |---|---|
   | `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
   | `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
   | `STATS_SALT` (optional, sensitive) | Secret key, 16+ chars, for distinct sharers per day and for rate-limit keys. Unset: counting is off, `sharersByDay` is omitted, and rate-limit keys are keyed with the Redis token |

3. Point the CLI at it with `AGENT_LEAKCHECK_ENDPOINT=https://<your-deploy>`.

`vercel.json` rewrites every path to the single function `api/index.js`, which serves all four routes. Its build step writes only `public/robots.txt` as the static output, so the source files are never served as static files. `.vercelignore` uploads only `api/`, `src/`, `package.json` and `vercel.json`.

Without the env vars the data routes answer `503` and `/healthz` still answers `200` (there is no in-memory fallback in production).

The handler never reads `req.body`, so Vercel's lazy body helper leaves the request stream alone. If a deploy ever shows empty scans, set `NODEJS_HELPERS=0`.

<details>
<summary>Redis keys</summary>

All keys use the prefix `alc:`.

- `total`
- Hashes `byDay`, `grade`, `os`, `toolVersion`, `agents`, `via`
- `agentVersions:<agent>`
- `checks:<id>` (fields `pass`, `fail`, `skip`)
- HyperLogLog `sharers:<YYYY-MM-DD>` (16-day expiry, only with `STATS_SALT`)
- Short-lived rate limit counters `rl:<hash>:<window>`

</details>

---

An open-source tool from [MPC](https://globalmpc.tech).
