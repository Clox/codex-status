'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { lockPathForAccount } = require('../lib/codex-activation-lock');
const { locations, createInstance } = require('../lib/codex-instances');
const { readPool, activeCredentialState, instanceActive, poolPaths, snapshotPath } = require('../lib/codex-account-pool');
const {
  repairableAccounts,
  validateStagedIdentity,
} = require('../lib/codex-auth-repair');

function account(key, id, email) {
  return { account_key: key, chatgpt_account_id: id, email, alias: '' };
}

const accountC = account('user-c::account-c', 'account-c', 'account-c@example.com');
const accountB = account('user-b::account-b', 'account-b', 'account-b@example.com');

function registry(active = accountB.account_key, accounts = [accountC, accountB]) {
  return { active_account_key: active, accounts };
}

test('only explicit authentication failures are offered for repair', () => {
  const cache = { accounts: {
    'account-c': { refresh: { errorKind: 'auth-401' } },
    'account-b': { refresh: { errorKind: 'network' } },
  } };
  assert.deepEqual(repairableAccounts(registry(), cache), [accountC]);
});

test('staged login must match exact stable account key and account id', () => {
  assert.deepEqual(validateStagedIdentity({
    target: accountC,
    stagedRegistry: registry(accountC.account_key, [accountC]),
    stagedAuth: { tokens: { account_id: accountC.chatgpt_account_id } },
  }), { ok: true, errors: [] });

  const wrong = validateStagedIdentity({
    target: accountC,
    stagedRegistry: registry(accountB.account_key, [accountB]),
    stagedAuth: { tokens: { account_id: accountB.chatgpt_account_id } },
  });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.includes('account-key-mismatch'));
  assert.ok(wrong.errors.includes('auth-account-id-mismatch'));
});

test('pool repair leaves every instance credential untouched and publishes only after verification', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-repair-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  const accounts = path.join(home, 'accounts');
  fs.mkdirSync(accounts, { recursive: true });
  const accountCSnapshot = path.join(accounts, 'account-c.auth.json');
  const accountBSnapshot = path.join(accounts, 'account-b.auth.json');
  const globalAuth = { auth_mode: 'chatgpt', tokens: { account_id: 'account-b', access_token: 'old-account-b-secret' } };
  const brokenAccountC = { auth_mode: 'chatgpt', tokens: { account_id: 'account-c', access_token: 'old-account-c-secret' } };
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(globalAuth));
  fs.writeFileSync(accountCSnapshot, JSON.stringify(brokenAccountC));
  fs.writeFileSync(accountBSnapshot, JSON.stringify(globalAuth));
  fs.writeFileSync(path.join(accounts, 'registry.json'), JSON.stringify(registry()));
  const poolLoc = locations({ HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') });
  const rosetta = createInstance('rosetta', 'Rosetta', poolLoc,
    { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
      CODEX_HOME: home });
  fs.mkdirSync(path.join(rosetta.codexHome, 'accounts'), { recursive: true });
  fs.copyFileSync(accountCSnapshot, path.join(rosetta.codexHome, 'auth.json'));
  fs.copyFileSync(accountCSnapshot, path.join(rosetta.codexHome, 'accounts', 'account-c.auth.json'));
  fs.writeFileSync(path.join(rosetta.codexHome, 'accounts', 'registry.json'),
    JSON.stringify(registry(accountC.account_key, [accountC])));

  const usageCache = path.join(root, 'usage.json');
  fs.writeFileSync(usageCache, JSON.stringify({ accounts: {
    'account-c': { refresh: { errorKind: 'auth-401', httpStatus: 401 } },
    'account-b': { refresh: { errorKind: null, httpStatus: 200, lastSuccessAt: Date.now() } },
  } }));

  const fakeCodexAuth = path.join(root, 'fake-codex-auth');
  fs.writeFileSync(fakeCodexAuth, `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const home=process.env.CODEX_HOME,cmd=process.argv[2];
const account={account_key:'user-c::account-c',chatgpt_account_id:'account-c',email:'account-c@example.com',alias:''};
const auth={auth_mode:'chatgpt',tokens:{account_id:'account-c',access_token:'new-account-c-secret'}};
if(cmd==='login'){
  if(process.env.EXPECTED_ACCOUNT_LOCK && !fs.existsSync(process.env.EXPECTED_ACCOUNT_LOCK)) process.exit(8);
  fs.mkdirSync(path.join(home,'accounts'),{recursive:true});
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify(auth));
  fs.writeFileSync(path.join(home,'accounts','account-c.auth.json'),JSON.stringify(auth));
  fs.writeFileSync(path.join(home,'accounts','registry.json'),JSON.stringify({active_account_key:account.account_key,accounts:[account]}));
  process.exit(0);
}
if(cmd==='import'){
  const imported=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
  fs.writeFileSync(path.join(home,'accounts','account-c.auth.json'),JSON.stringify(imported));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });

  const fakeRefresher = path.join(root, 'fake-usage-refresh');
  fs.writeFileSync(fakeRefresher, `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
if(process.env.FAIL_STAGED_REFRESH==='1' && process.env.CODEX_HOME!==process.env.REAL_CODEX_HOME) process.exit(9);
const dir=path.join(process.env.CODEX_HOME,'accounts');
const entries={};
for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.auth.json'))){
  const auth=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  const id=auth.tokens.account_id;
  entries[id]={primary:{remainingPercent:50},secondary:{remainingPercent:50},refresh:{lastSuccessAt:Date.now(),lastAttemptAt:Date.now(),lastErrorAt:null,errorKind:null,httpStatus:200,consecutiveFailures:0}};
}
fs.writeFileSync(process.env.USAGE_CACHE,JSON.stringify({accounts:entries}));
`, { mode: 0o700 });

  const repairBin = path.join(__dirname, '..', 'bin', 'codex-auth-repair');
  const expectedAccountLock = lockPathForAccount(path.join(root, 'activation-locks'), 'account-c');
  const beforeAuth = fs.readFileSync(path.join(home, 'auth.json'));
  const beforeRegistry = fs.readFileSync(path.join(accounts, 'registry.json'));
  const beforeSnapshot = fs.readFileSync(accountCSnapshot);
  const beforeRosetta = fs.readFileSync(path.join(rosetta.codexHome, 'auth.json'));
  const result = spawnSync(process.execPath, [repairBin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
      CODEX_HOME: home,
      CODEX_AUTH_BIN: fakeCodexAuth,
      USAGE_REFRESHER: fakeRefresher,
      USAGE_CACHE: usageCache,
      CODEX_LOGIN_BIN: '/bin/true',
      EXPECTED_ACCOUNT_LOCK: expectedAccountLock,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), beforeAuth);
  assert.deepEqual(fs.readFileSync(path.join(accounts, 'registry.json')), beforeRegistry);
  assert.deepEqual(JSON.parse(fs.readFileSync(accountBSnapshot, 'utf8')), globalAuth);
  assert.deepEqual(fs.readFileSync(accountCSnapshot), beforeSnapshot);
  assert.deepEqual(fs.readFileSync(path.join(rosetta.codexHome, 'auth.json')), beforeRosetta);
  assert.equal(readPool(poolLoc).accounts.find(value => value.accountKey === accountC.account_key).generation, 2);
  assert.equal(activeCredentialState(rosetta, instanceActive(rosetta, readPool(poolLoc)), readPool(poolLoc), poolLoc).stale, true);
  const poolMember = readPool(poolLoc).accounts.find(value => value.accountKey === accountC.account_key);
  assert.equal(JSON.parse(fs.readFileSync(snapshotPath(
    poolPaths(poolLoc), poolMember.accountKey, 2))).tokens.access_token,
  'new-account-c-secret');
  assert.equal(Object.hasOwn(readPool(poolLoc), 'active_account_key'), false);
  assert.equal(readRegistry(home).active_account_key, accountB.account_key);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /old-.*-secret|new-account-c-secret/);

  const oldUsage = { accounts: {
    'account-c': { refresh: { errorKind: 'auth-401', httpStatus: 401 } },
    'account-b': { refresh: { errorKind: null, httpStatus: 200, lastSuccessAt: Date.now() } },
  } };
  fs.writeFileSync(usageCache, JSON.stringify(oldUsage));
  const failed = spawnSync(process.execPath, [repairBin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
      CODEX_HOME: home,
      CODEX_AUTH_BIN: fakeCodexAuth,
      USAGE_REFRESHER: fakeRefresher,
      USAGE_CACHE: usageCache,
      CODEX_LOGIN_BIN: '/bin/true',
      EXPECTED_ACCOUNT_LOCK: expectedAccountLock,
      FAIL_STAGED_REFRESH: '1',
      REAL_CODEX_HOME: home,
    },
  });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(fs.readFileSync(path.join(home, 'auth.json')), beforeAuth);
  assert.deepEqual(fs.readFileSync(accountCSnapshot), beforeSnapshot);
  assert.deepEqual(fs.readFileSync(path.join(accounts, 'registry.json')), beforeRegistry);
  assert.deepEqual(fs.readFileSync(path.join(rosetta.codexHome, 'auth.json')), beforeRosetta);
  assert.deepEqual(JSON.parse(fs.readFileSync(usageCache, 'utf8')), oldUsage);
  assert.equal(readPool(poolLoc).accounts.find(value => value.accountKey === accountC.account_key).generation, 2);
  assert.doesNotMatch(`${failed.stdout}${failed.stderr}`, /old-.*-secret|new-account-c-secret/);
});

function readRegistry(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'accounts', 'registry.json'), 'utf8'));
}
