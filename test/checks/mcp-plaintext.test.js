import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as read from '../../src/read.js';
import check from '../../src/checks/mcp-plaintext.js';

const SECRET = 'sk-PLANTED1234567890abcdef';
const BEARER = 'Bearer PLANTEDTOKENVALUE1234567890';

function setup(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const h = (...s) => path.join(home, ...s);
  const agents = [
    { id: 'claude-code', customConfigDir: null, paths: { userJson: h('.claude.json'), projectMcp: h('proj', '.mcp.json') } },
    { id: 'codex', customConfigDir: null, paths: { config: h('.codex', 'config.toml'), projectConfig: h('proj', '.codex', 'config.toml') } },
    { id: 'cursor', customConfigDir: null, paths: { mcp: h('.cursor', 'mcp.json'), projectMcp: h('proj', '.cursor', 'mcp.json') } },
    { id: 'gemini', customConfigDir: null, paths: { settings: h('.gemini', 'settings.json'), projectSettings: h('proj', '.gemini', 'settings.json'), systemSettings: h('sys', 'etc', 'gemini-cli', 'settings.json') } },
  ];
  const ctx = { home, cwd: h('proj'), platform: 'linux', uid: 1, envNames: [], read, exec: {}, agents };
  return { ctx, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const rowsFor = (rows, id) => rows.filter((r) => r.agent === id);
const status = (rows, id) => rowsFor(rows, id).map((r) => r.status);

test('fail, pass and skip per agent; values never appear', () => {
  const { ctx, done } = setup({
    '.claude.json': {
      mcpServers: { gh: { env: { GITHUB_TOKEN: SECRET, PATH: '/usr/bin' } } },
      projects: { '/x/myproj': { mcpServers: { api: { headers: { 'X-Api': BEARER } } } } },
    },
    'proj/.mcp.json': { mcpServers: { ok: { env: { API_KEY: '${API_KEY}' }, headers: { Authorization: 'Bearer ${T}' } } } },
    '.codex/config.toml': `[mcp_servers.a]\ncommand = "x"\nenv = { MY_SECRET = "${SECRET}" }\n[mcp_servers.a.http_headers]\nAuthorization = "${BEARER}"\n[mcp_servers.a.oauth]\nclient_secret = "${SECRET}"\n`,
    '.cursor/mcp.json': { mcpServers: { github: { headers: { Authorization: BEARER }, env: { TOKEN: '${env:T}' } } } },
    '.gemini/settings.json': '{ // c\n "mcpServers": { "g": { "headers": { "Authorization": "Bearer $GITHUB_TOKEN" }, "env": { "A_KEY": "${A_KEY:-x}" } } },\n}',
  });
  try {
    const rows = check.run(ctx);
    const cc = rowsFor(rows, 'claude-code').filter((r) => r.status === 'fail');
    assert.equal(cc.length, 2);
    assert.match(cc[0].message, /~\/\.claude\.json \(user\): server 'gh' has a plaintext value in env\.GITHUB_TOKEN/);
    assert.match(cc[1].message, /\(project myproj\): server 'api'.*headers\.X-Api/);
    assert.match(cc[0].fix, /\$\{NAME\}/);
    const cx = rowsFor(rows, 'codex').filter((r) => r.status === 'fail').map((r) => r.message);
    assert.equal(cx.length, 3);
    assert.ok(cx.some((m) => m.includes('oauth.client_secret')));
    assert.match(rowsFor(rows, 'codex')[0].fix, /bearer_token_env_var/);
    const cu = rowsFor(rows, 'cursor');
    assert.deepEqual(cu.map((r) => r.status), ['fail']);
    assert.match(cu[0].message, /~\/\.cursor\/mcp\.json: server 'github' has a plaintext value in headers\.Authorization/);
    assert.deepEqual(status(rows, 'gemini'), ['pass']);
    assert.ok(!JSON.stringify(rows).includes('PLANTED'));
  } finally {
    done();
  }
});

test('pass when only references; skip when no config or no servers', () => {
  const { ctx, done } = setup({
    'proj/.mcp.json': { mcpServers: { ok: { env: { API_KEY: '${API_KEY}' } } } },
    '.cursor/mcp.json': { mcpServers: {} },
  });
  try {
    const rows = check.run(ctx);
    assert.deepEqual(status(rows, 'claude-code'), ['pass']);
    assert.deepEqual(status(rows, 'codex'), ['skip']);
    assert.deepEqual(status(rows, 'cursor'), ['skip']);
    assert.deepEqual(status(rows, 'gemini'), ['skip']);
  } finally {
    done();
  }
});

test('token shape without a secret-like key name is flagged; Cursor needs ${env:', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': { mcpServers: { s: { env: { FOO: 'ghp_abcdefgh12345678', BAR: '${NAME}' } } } },
  });
  try {
    const rows = rowsFor(check.run(ctx), 'cursor');
    assert.equal(rows.length, 1);
    assert.match(rows[0].message, /env\.FOO/);
  } finally {
    done();
  }
});

test('malformed files give a skip row, no crash', () => {
  const { ctx, done } = setup({
    '.claude.json': '{ nope',
    '.codex/config.toml': 'a = = =',
    '.cursor/mcp.json': '[1,2]',
    '.gemini/settings.json': 'x',
  });
  try {
    const rows = check.run(ctx);
    for (const id of ['claude-code', 'codex', 'cursor', 'gemini']) {
      assert.deepEqual(status(rows, id), ['skip']);
      assert.match(rowsFor(rows, id)[0].message, /^could not parse ~\//);
    }
  } finally {
    done();
  }
});

test('customConfigDir adds an info row', () => {
  const { ctx, done } = setup({});
  try {
    ctx.agents[1].customConfigDir = 'CODEX_HOME';
    const rows = rowsFor(check.run(ctx), 'codex');
    assert.equal(rows[0].status, 'info');
    assert.equal(rows[0].message, 'CODEX_HOME is set; only the default config location was checked');
  } finally {
    done();
  }
});

const failKeys = (rows, id) =>
  rowsFor(rows, id).filter((r) => r.status === 'fail').map((r) => r.message.replace(/^.*has a plaintext value in /, ''));

test('name-only matches need a secret-like value; shapes always fail', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': {
      mcpServers: {
        s: {
          env: {
            GOOGLE_APPLICATION_CREDENTIALS: '/home/u/creds.json',
            SSH_KEY_PATH: '/h/k',
            DISABLE_AUTH: 'true',
            API_KEY_FILE: 'plain-name',
            TOKEN_HOME: '~/tok',
            WIN_TOKEN: 'C:\\tok\\a',
            SECRET_URL: 'https://example.com/x',
            RETRY_TOKEN_COUNT: '3',
            REAL_TOKEN: 'abcdef123456',
            DEPLOY_PATH_KEY: 'ghp_abcdefgh12345678',
            SSH_KEY_DIR: 'ghp_abcdefgh12345678',
          },
          headers: { 'X-Author': 'me', Authorization: 'Basic abc123', 'Proxy-Authorization': 'Basic abc123', 'X-Auth': 'abc123' },
        },
      },
    },
  });
  try {
    const keys = failKeys(check.run(ctx), 'cursor');
    assert.deepEqual(keys.sort(), [
      'env.DEPLOY_PATH_KEY', 'env.REAL_TOKEN', 'env.SSH_KEY_DIR',
      'headers.Authorization', 'headers.Proxy-Authorization', 'headers.X-Auth',
    ].sort());
  } finally {
    done();
  }
});

test('references are removed before the checks: defaults and bare $ cannot hide a secret', () => {
  const { ctx, done } = setup({
    '.claude.json': { mcpServers: { s: { env: { A: '${X:-sk-live-abcdefghijklmnopqrstuv}', B_KEY: '${X:-dev}', C_TOKEN: 'pa${X}word123' } } } },
    '.gemini/settings.json': { mcpServers: { g: { env: { D_TOKEN: 'pa$word123', E_TOKEN: '$ENV_TOKEN', F: '${Y:-ghp_abcdefgh12345678}' } } } },
  });
  try {
    const rows = check.run(ctx);
    assert.deepEqual(failKeys(rows, 'claude-code').sort(), ['env.A', 'env.C_TOKEN']);
    assert.deepEqual(failKeys(rows, 'gemini').sort(), ['env.D_TOKEN', 'env.F']);
  } finally {
    done();
  }
});

test('gemini: a plaintext secret in system settings alone fails', () => {
  const { ctx, done } = setup({
    'sys/etc/gemini-cli/settings.json': '{ // system\n "mcpServers": { "s": { "headers": { "Authorization": "' + BEARER + '" } } } }',
  });
  try {
    const rows = check.run(ctx);
    assert.deepEqual(status(rows, 'gemini'), ['fail']);
    assert.ok(!JSON.stringify(rows).includes('PLANTEDTOKENVALUE'));
  } finally {
    done();
  }
});

test('cwd == home: each file is scanned once', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': { mcpServers: { s: { env: { A_TOKEN: SECRET } } } },
    '.claude.json': { mcpServers: { s: { env: { A_TOKEN: SECRET } } } },
  });
  try {
    ctx.cwd = ctx.home;
    for (const a of ctx.agents) {
      if (a.id === 'cursor') a.paths.projectMcp = a.paths.mcp;
      if (a.id === 'claude-code') a.paths.projectMcp = a.paths.userJson;
    }
    const rows = check.run(ctx);
    assert.equal(rowsFor(rows, 'cursor').filter((r) => r.status === 'fail').length, 1);
    assert.equal(rowsFor(rows, 'claude-code').filter((r) => r.status === 'fail').length, 1);
  } finally {
    done();
  }
});

test('Cursor auth.CLIENT_SECRET literal fails, reference passes', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': { mcpServers: { a: { url: 'https://x.test', auth: { CLIENT_ID: 'id', CLIENT_SECRET: 'abcdef123456' } }, b: { auth: { CLIENT_SECRET: '${env:CS}' } } } },
  });
  try {
    assert.deepEqual(failKeys(check.run(ctx), 'cursor'), ['auth.CLIENT_SECRET']);
  } finally {
    done();
  }
});

test('no pass row when another file of the agent could not be parsed', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': { mcpServers: { s: { env: { A_TOKEN: '${env:A}' } } } },
    'proj/.cursor/mcp.json': '{ nope',
  });
  try {
    assert.deepEqual(status(check.run(ctx), 'cursor'), ['skip']);
  } finally {
    done();
  }
});

test('a UTF-8 BOM does not hide a literal secret', () => {
  const { ctx, done } = setup({
    '.cursor/mcp.json': '\uFEFF' + JSON.stringify({ mcpServers: { s: { env: { A_TOKEN: SECRET } } } }),
  });
  try {
    assert.deepEqual(status(check.run(ctx), 'cursor'), ['fail']);
  } finally {
    done();
  }
});
