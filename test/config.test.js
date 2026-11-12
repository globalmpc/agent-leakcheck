import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION, endpoint, DEFAULT_ENDPOINT } from '../src/config.js';

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('endpoint() honours the env override', () => {
  const old = process.env.AGENT_LEAKCHECK_ENDPOINT;
  process.env.AGENT_LEAKCHECK_ENDPOINT = 'http://x.test';
  assert.equal(endpoint(), 'http://x.test');
  delete process.env.AGENT_LEAKCHECK_ENDPOINT;
  assert.equal(endpoint(), DEFAULT_ENDPOINT);
  if (old !== undefined) process.env.AGENT_LEAKCHECK_ENDPOINT = old;
});
