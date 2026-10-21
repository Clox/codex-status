'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { locations } = require('../lib/codex-instances');
const { migrateDefault, updateCredential } = require('../lib/codex-account-pool');

test('usage status reads repaired pool credential while instance copy remains stale', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-pool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '.codex');
  const account = { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' };
  const oldAuth = { auth_mode: 'chatgpt', tokens: { account_id: 'account-a', access_token: 'old' } };
  const newAuth = { auth_mode: 'chatgpt', tokens: { account_id: 'account-a', access_token: 'new' } };
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(oldAuth));
  fs.writeFileSync(path.join(home, 'accounts', 'a.auth.json'), JSON.stringify(oldAuth));
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({
    active_account_key: account.account_key, accounts: [account],
  }));
  const env = { ...process.env, HOME: root, CODEX_HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), USAGE_REFRESH_INTERVAL_MS: '-1' };
  const loc = locations(env);
  migrateDefault(loc, env);
  const newFile = path.join(root, 'new.auth.json');
  fs.writeFileSync(newFile, JSON.stringify(newAuth));
  updateCredential(account.account_key, newFile, loc, { verified: true });
  const preload = path.join(root, 'fetch.js');
  fs.writeFileSync(preload, `global.fetch = async (_url, options) => new Response(JSON.stringify({
    plan_type: 'plus', rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 100 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_after_seconds: 1000 },
    },
  }), { status: options.headers.Authorization === 'Bearer new' ? 200 : 401,
    headers: { date: new Date().toUTCString() } });\n`);
  const refresh = path.join(__dirname, '..', 'bin', 'codex-usage-refresh');
  const run = (source, cache) => spawnSync(process.execPath, ['--require', preload, refresh], {
    env: { ...env, CODEX_USAGE_CREDENTIAL_SOURCE: source, USAGE_CACHE: cache },
    encoding: 'utf8', timeout: 5000,
  });
  const poolCache = path.join(root, 'pool-usage.json');
  const poolResult = run('pool', poolCache);
  assert.equal(poolResult.status, 0, poolResult.stderr);
  assert.equal(JSON.parse(fs.readFileSync(poolCache)).accounts['account-a'].refresh.httpStatus, 200);
  const localCache = path.join(root, 'local-usage.json');
  const localResult = run('local', localCache);
  assert.equal(localResult.status, 0, localResult.stderr);
  assert.equal(JSON.parse(fs.readFileSync(localCache)).accounts['account-a'].refresh.httpStatus, 401);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'))), oldAuth);
});
