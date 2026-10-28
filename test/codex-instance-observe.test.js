'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createInstance, instanceNamespaces, locations } = require('../lib/codex-instances');

test('secondary observer binds a new terminal quota error only to its own active account and runtime', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-secondary-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, '.codex'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    USAGE_CACHE: path.join(root, 'cache', 'codex-account-switcher', 'usage.json') };
  const loc = locations(env);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const defaultState = path.join(loc.cacheHome, 'codex-account-switcher', 'turn-events.json');
  fs.mkdirSync(path.dirname(defaultState), { recursive: true });
  fs.writeFileSync(defaultState, 'default-state-sentinel');
  const accountsDir = path.join(b.codexHome, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, 'registry.json'), JSON.stringify({
    active_account_key: 'key-b',
    accounts: [{ account_key: 'key-b', chatgpt_account_id: 'account-b' }],
  }));
  const sessions = path.join(b.codexHome, 'sessions', '2026', '10', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, 'rollout-secondary.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta',
    payload: { id: 'thread-b' } })}\n`);
  const run = () => spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'codex-instance-observe')],
    { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run().status, 0);
  const statePath = path.join(instanceNamespaces(b).state, 'turn-events.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath)).exhaustions, {});
  const now = Date.now();
  fs.appendFileSync(rollout, [
    { type: 'event_msg', timestamp: new Date(now).toISOString(),
      payload: { type: 'task_started', turn_id: 'turn-b', started_at: now } },
    { type: 'event_msg', timestamp: new Date(now + 1).toISOString(),
      payload: { type: 'task_complete', turn_id: 'turn-b', completed_at: now + 1,
        error: { codex_error_info: 'usage_limit_exceeded' } } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(run().status, 0);
  const observed = JSON.parse(fs.readFileSync(statePath));
  assert.equal(observed.exhaustions['account-b'].verified, true);
  assert.equal(observed.exhaustions['account-b'].source, 'rollout-terminal');
  assert.equal(observed.exhaustions['account-b'].threadIdentityVerified, true);
  assert.equal(fs.readFileSync(defaultState, 'utf8'), 'default-state-sentinel');
  fs.writeFileSync(path.join(loc.cacheHome, 'codex-account-switcher', 'usage.json'),
    JSON.stringify({ accounts: { 'account-b': {
      primary: { remainingPercent: 100 }, secondary: { remainingPercent: 50 },
      rateLimitReachedTypeObserved: true, rateLimitReachedType: null,
      refresh: { lastSuccessAt: observed.exhaustions['account-b'].observedAtMs + 1000 },
    } } }));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).exhaustions['account-b'], undefined);
  assert.equal(fs.readFileSync(defaultState, 'utf8'), 'default-state-sentinel');
});
