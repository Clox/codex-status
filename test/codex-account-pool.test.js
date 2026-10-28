'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { locations, createInstance, readRegistry: readInstances } = require('../lib/codex-instances');
const { DESKTOP } = require('../lib/codex-instances');
const { poolPaths, readPool, migrateDefault, instanceActive, provisionAccount,
  updateCredential, acquireAccountLock, snapshotPath, digest,
  deleteInstanceWithAccounts, readProvisioned, writeProvisioned, readSwitchState,
  assertCredentialAvailable, activeCredentialState, reprovisionActive } = require('../lib/codex-account-pool');
const { classify } = require('../lib/codex-operation-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-pool-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') };
  const loc = locations(env);
  const home = path.join(root, '.codex');
  fs.mkdirSync(path.dirname(loc.legacyConfig), { recursive: true });
  fs.writeFileSync(loc.legacyConfig, `CODEX_HOME=${home}\n`);
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  const accounts = [
    { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' },
    { account_key: 'key-b', chatgpt_account_id: 'account-b', email: 'b@example.test' },
  ];
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({ active_account_key: 'key-a', accounts }));
  for (const [index, account] of accounts.entries()) {
    const auth = { auth_mode: 'chatgpt', tokens: { account_id: account.chatgpt_account_id,
      access_token: `synthetic-${index}` } };
    fs.writeFileSync(path.join(home, 'accounts', `${index}.auth.json`), JSON.stringify(auth), { mode: 0o600 });
    if (!index) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  }
  return { root, env, loc, home, accounts };
}

function fakeAuthCalls(calls) {
  return (command, args, options) => {
    calls.push({ command, args, home: options.env.CODEX_HOME, xdg: options.env.XDG_CONFIG_HOME });
    const home = options.env.CODEX_HOME;
    const dir = path.join(home, 'accounts');
    fs.mkdirSync(dir, { recursive: true });
    if (args[0] === 'import') {
      const auth = JSON.parse(fs.readFileSync(args[1], 'utf8'));
      const id = auth.tokens.account_id;
      const key = id === 'account-b' ? 'key-b' : 'key-a';
      const existing = fs.readdirSync(dir).filter(name => name.endsWith('.auth.json'))
        .find(name => JSON.parse(fs.readFileSync(path.join(dir, name))).tokens.account_id === id);
      fs.copyFileSync(args[1], path.join(dir, existing || `${id}.auth.json`));
      const prior = fs.existsSync(path.join(dir, 'registry.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'))) : { active_account_key: null, accounts: [] };
      if (!prior.accounts.some(value => value.account_key === key)) prior.accounts.push({
        account_key: key, chatgpt_account_id: id, email: `${id.at(-1)}@example.test` });
      fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(prior));
    } else if (args[0] === 'switch') {
      const registryPath = path.join(dir, 'registry.json');
      const registry = JSON.parse(fs.readFileSync(registryPath));
      const account = registry.accounts.find(value => value.email === args[1]);
      if (!account) throw new Error('FAKE_SELECTOR_MISMATCH');
      registry.active_account_key = account.account_key;
      fs.writeFileSync(registryPath, JSON.stringify(registry));
      const snapshot = fs.readdirSync(dir).filter(name => name.endsWith('.auth.json'))
        .find(name => JSON.parse(fs.readFileSync(path.join(dir, name))).tokens.account_id === account.chatgpt_account_id);
      fs.copyFileSync(path.join(dir, snapshot), path.join(home, 'auth.json'));
    } else throw new Error('UNEXPECTED_AUTH_COMMAND');
    return { status: 0 };
  };
}

test('default migration copies exact snapshots and has no pool-wide active account', t => {
  const f = fixture(t);
  const protectedPaths = ['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json'];
  const before = protectedPaths.map(name => fs.readFileSync(path.join(f.home, name)));
  const pool = migrateDefault(f.loc, f.env);
  assert.equal(pool.accounts.length, 2);
  assert.equal(Object.hasOwn(pool, 'activeAccountKey'), false);
  assert.equal(Object.hasOwn(pool, 'active_account_key'), false);
  assert.deepEqual(protectedPaths.map(name => fs.readFileSync(path.join(f.home, name))), before);
  for (const [index, account] of pool.accounts.entries()) {
    assert.deepEqual(fs.readFileSync(snapshotPath(poolPaths(f.loc), account.accountKey, 1)), before[index + 2]);
    assert.equal(account.generation, 1);
  }
  assert.equal(instanceActive(readInstances(f.loc, f.env).instances[0], pool).accountKey, 'key-a');
  const poolBytes = fs.readFileSync(poolPaths(f.loc).registry);
  const snapshotBytes = pool.accounts.map(account => fs.readFileSync(snapshotPath(poolPaths(f.loc), account.accountKey, 1)));
  assert.deepEqual(migrateDefault(f.loc, f.env), pool);
  assert.deepEqual(fs.readFileSync(poolPaths(f.loc).registry), poolBytes);
  assert.deepEqual(pool.accounts.map(account => fs.readFileSync(snapshotPath(poolPaths(f.loc), account.accountKey, 1))), snapshotBytes);
  assert.deepEqual(protectedPaths.map(name => fs.readFileSync(path.join(f.home, name))), before);
});

test('B provisions through import then switch in B home; A bytes stay unchanged and duplicate active is blocked', async t => {
  const f = fixture(t);
  const pool = migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  assert.equal(instanceActive(b, pool), null);
  const protectedPaths = ['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json'];
  const before = protectedPaths.map(name => digest(fs.readFileSync(path.join(f.home, name))));
  const calls = [];
  const options = { run: fakeAuthCalls(calls), processSnapshot: [] };
  await assert.rejects(provisionAccount('rosetta', 'key-a', f.loc, f.env, options), /ACCOUNT_IN_USE_BY:Spadrig/);
  assert.equal(readSwitchState(f.loc).errorKind, 'ACCOUNT_IN_USE_BY:Spadrig');
  assert.equal(calls.length, 0);
  const result = await provisionAccount('rosetta', 'key-b', f.loc, f.env, options);
  assert.equal(result.unchanged, false);
  assert.deepEqual(calls.map(value => value.args[0]), ['import', 'switch']);
  assert.ok(calls.every(value => value.home === b.codexHome));
  assert.ok(calls.every(value => value.xdg.startsWith(path.dirname(b.codexHome))));
  assert.equal(instanceActive(b, pool).accountKey, 'key-b');
  assert.equal(instanceActive(readInstances(f.loc, f.env).instances[0], pool).accountKey, 'key-a');
  assert.deepEqual(protectedPaths.map(name => digest(fs.readFileSync(path.join(f.home, name)))), before);
  const again = await provisionAccount('rosetta', 'key-b', f.loc, f.env, options);
  assert.equal(again.unchanged, true);
  assert.equal(calls.length, 2);
});

test('default can select its current pool snapshot despite B stale inactive copy', t => {
  const f = fixture(t);
  const registryPath = path.join(f.home, 'accounts', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath));
  registry.accounts.push({ account_key: 'key-c', chatgpt_account_id: 'account-c',
    email: 'c@example.test' });
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  fs.writeFileSync(path.join(f.home, 'accounts', '2.auth.json'), JSON.stringify({
    tokens: { account_id: 'account-c', access_token: 'synthetic-c' },
  }));
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  fs.mkdirSync(path.join(b.codexHome, 'accounts'), { recursive: true });
  fs.copyFileSync(path.join(f.home, 'accounts', '1.auth.json'),
    path.join(b.codexHome, 'accounts', 'b.auth.json'));
  fs.writeFileSync(path.join(b.codexHome, 'accounts', 'registry.json'), JSON.stringify({
    active_account_key: 'key-c', accounts: [registry.accounts[2], registry.accounts[1]],
  }));
  fs.copyFileSync(path.join(f.home, 'accounts', '2.auth.json'), path.join(b.codexHome, 'auth.json'));
  writeProvisioned(f.loc, { version: 1, instances: { rosetta: {
    'key-b': { generation: 1, stale: false },
  } } });
  const newer = path.join(f.root, 'new-b.auth.json');
  fs.writeFileSync(newer, JSON.stringify({ tokens: { account_id: 'account-b',
    access_token: 'synthetic-b-updated' } }));
  fs.copyFileSync(newer, path.join(f.home, 'accounts', '1.auth.json'));
  updateCredential('key-b', newer, f.loc, { verified: true });
  const pool = readPool(f.loc);
  const instances = readInstances(f.loc, f.env);
  assert.equal(pool.accounts.find(value => value.accountKey === 'key-b').generation, 2);
  assert.equal(instanceActive(instances.instances[0], pool).accountKey, 'key-a');
  assert.equal(instanceActive(b, pool).accountKey, 'key-c');
  assert.equal(assertCredentialAvailable('key-b', 'default', instances, pool, f.loc).accountKey, 'key-b');
  assert.throws(() => assertCredentialAvailable('key-c', 'default', instances, pool, f.loc),
    /ACCOUNT_IN_USE_BY:Rosetta/);
  fs.writeFileSync(path.join(f.home, 'accounts', '1.auth.json'), JSON.stringify({
    tokens: { account_id: 'account-b', access_token: 'synthetic-b-old' },
  }));
  assert.equal(assertCredentialAvailable('key-b', 'default', instances, pool, f.loc).accountKey, 'key-b');
});

test('B can select a current pool snapshot despite old inactive default metadata', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  const updated = path.join(f.root, 'updated-b.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'account-b', access_token: 'synthetic-b-updated',
  } }));
  const member = updateCredential('key-b', updated, f.loc, { verified: true });
  assert.equal(member.generation, 2);
  const defaultSnapshot = path.join(f.home, 'accounts', '1.auth.json');
  fs.copyFileSync(updated, defaultSnapshot);
  writeProvisioned(f.loc, { version: 1, instances: { default: {
    'key-b': { generation: 1, stale: true },
  } } });
  const beforeA = ['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => digest(fs.readFileSync(path.join(f.home, name))));
  const pool = readPool(f.loc);
  assert.equal(assertCredentialAvailable('key-b', 'rosetta', readInstances(f.loc, f.env), pool, f.loc).accountKey, 'key-b');
  const calls = [];
  await provisionAccount('rosetta', 'key-b', f.loc, f.env, {
    run: fakeAuthCalls(calls), processSnapshot: [],
  });
  assert.deepEqual(calls.map(value => value.args[0]), ['import', 'switch']);
  assert.ok(calls.every(value => value.home === b.codexHome));
  assert.equal(instanceActive(b, readPool(f.loc)).accountKey, 'key-b');
  assert.deepEqual(['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => digest(fs.readFileSync(path.join(f.home, name)))), beforeA);
});

test('B still blocks when the inactive default snapshot differs from pool', t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  createInstance('rosetta', 'Rosetta', f.loc, f.env);
  const updated = path.join(f.root, 'updated-b.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'account-b', access_token: 'synthetic-b-updated',
  } }));
  updateCredential('key-b', updated, f.loc, { verified: true });
  const pool = readPool(f.loc);
  assert.throws(() => assertCredentialAvailable('key-b', 'rosetta', readInstances(f.loc, f.env), pool, f.loc),
    /CREDENTIAL_REPROVISION_NEEDED:Spadrig/);
});

test('switch of a running B targets only B stop and start even when A also runs', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  const a = readInstances(f.loc, f.env).instances[0];
  const entries = [
    { pid: 10, ppid: 1, startTicks: '10', exe: DESKTOP,
      cmdline: `${DESKTOP} --user-data-dir=${a.desktopProfile}`, env: { CODEX_HOME: a.codexHome } },
    { pid: 20, ppid: 1, startTicks: '20', exe: DESKTOP,
      cmdline: `${DESKTOP} --user-data-dir=${b.desktopProfile}`, env: { CODEX_HOME: b.codexHome } },
  ];
  const operations = [];
  const outcome = await provisionAccount('rosetta', 'key-b', f.loc, f.env, {
    run: fakeAuthCalls(operations), processSnapshot: entries,
    stop: async id => { operations.push({ stop: id }); },
    start: id => { operations.push({ start: id }); return { record: b }; },
    wait: async record => { assert.equal(record.instanceId, 'rosetta'); },
  });
  assert.equal(outcome.unchanged, false);
  assert.deepEqual(operations.filter(value => value.stop || value.start),
    [{ stop: 'rosetta' }, { start: 'rosetta' }]);
  assert.equal(instanceActive(a, readPool(f.loc)).accountKey, 'key-a');
});

test('failed B switch restores B auth files and does not touch A', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  const beforeA = digest(fs.readFileSync(path.join(f.home, 'auth.json')));
  const calls = [];
  const fake = fakeAuthCalls(calls);
  await assert.rejects(provisionAccount('rosetta', 'key-b', f.loc, f.env, {
    processSnapshot: [], run: (command, args, options) =>
      args[0] === 'switch' ? { status: 1 } : fake(command, args, options),
  }), /INSTANCE_AUTH_SWITCH_FAILED/);
  assert.equal(fs.existsSync(path.join(b.codexHome, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(b.codexHome, 'accounts', 'registry.json')), false);
  assert.deepEqual(readProvisioned(f.loc).instances, {});
  assert.equal(digest(fs.readFileSync(path.join(f.home, 'auth.json'))), beforeA);
});

test('same-account reprovision applies the new generation only to selected stopped B', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  await provisionAccount('rosetta', 'key-b', f.loc, f.env, {
    run: fakeAuthCalls([]), processSnapshot: [],
  });
  const aBefore = ['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => digest(fs.readFileSync(path.join(f.home, name))));
  const bBefore = fs.readFileSync(path.join(b.codexHome, 'auth.json'));
  const updated = path.join(f.root, 'new-b.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'account-b', access_token: 'new-synthetic' } }));
  assert.equal(updateCredential('key-b', updated, f.loc, { verified: true }).generation, 2);
  assert.deepEqual(fs.readFileSync(path.join(b.codexHome, 'auth.json')), bBefore);
  assert.equal(activeCredentialState(b, instanceActive(b, readPool(f.loc)), readPool(f.loc), f.loc).stale, true);
  const calls = [];
  const result = await reprovisionActive('rosetta', f.loc, f.env, {
    run: fakeAuthCalls(calls), processSnapshot: [],
  });
  assert.equal(result.unchanged, false);
  assert.deepEqual(calls.map(value => value.args[0]), ['import', 'switch']);
  assert.ok(calls.every(value => value.home === b.codexHome));
  assert.equal(readProvisioned(f.loc).instances.rosetta['key-b'].generation, 2);
  assert.equal(activeCredentialState(b, instanceActive(b, readPool(f.loc)), readPool(f.loc), f.loc).stale, false);
  assert.deepEqual(['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => digest(fs.readFileSync(path.join(f.home, name)))), aBefore);
});

test('default same-account reprovision uses import and switch without selecting another account', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const oldB = fs.readFileSync(path.join(f.home, 'accounts', '1.auth.json'));
  const updated = path.join(f.root, 'new-a.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'account-a', access_token: 'new-a' } }));
  updateCredential('key-a', updated, f.loc, { verified: true });
  const calls = [];
  const result = await reprovisionActive('default', f.loc, f.env, {
    run: fakeAuthCalls(calls), processSnapshot: [],
  });
  assert.equal(result.unchanged, false);
  assert.deepEqual(calls.map(call => call.args[0]), ['import', 'switch']);
  assert.ok(calls.every(call => call.home === f.home));
  assert.equal(readProvisioned(f.loc).instances.default['key-a'].generation, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'accounts', '1.auth.json')), oldB);
});

test('running reprovision refuses active turns and leaves both instances untouched', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  await provisionAccount('rosetta', 'key-b', f.loc, f.env, { run: fakeAuthCalls([]), processSnapshot: [] });
  const updated = path.join(f.root, 'new-b.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ tokens: { account_id: 'account-b', access_token: 'new' } }));
  updateCredential('key-b', updated, f.loc, { verified: true });
  const beforeA = fs.readFileSync(path.join(f.home, 'auth.json'));
  const beforeB = fs.readFileSync(path.join(b.codexHome, 'auth.json'));
  const entries = [{ pid: 20, ppid: 1, startTicks: '20', exe: DESKTOP,
    cmdline: `${DESKTOP} --user-data-dir=${b.desktopProfile}`, env: { CODEX_HOME: b.codexHome } }];
  fs.mkdirSync(b.runtime, { recursive: true });
  fs.writeFileSync(path.join(b.runtime, 'turn-events.json'), JSON.stringify({
    worker: { heartbeatAtMs: Date.now() }, activeTurns: { turn: { threadId: 'thread-b' } },
  }));
  let stopped = false;
  await assert.rejects(reprovisionActive('rosetta', f.loc, f.env, {
    processSnapshot: entries,
    stop: async () => { stopped = true; }, run: fakeAuthCalls([]),
  }), /INSTANCE_ACTIVE_TURNS:Rosetta/);
  assert.equal(stopped, false);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'auth.json')), beforeA);
  assert.deepEqual(fs.readFileSync(path.join(b.codexHome, 'auth.json')), beforeB);
});

test('running same-account reprovision restarts only the verified selected instance', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  await provisionAccount('rosetta', 'key-b', f.loc, f.env, { run: fakeAuthCalls([]), processSnapshot: [] });
  const updated = path.join(f.root, 'new-b.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'account-b', access_token: 'new-synthetic' } }));
  updateCredential('key-b', updated, f.loc, { verified: true });
  fs.mkdirSync(b.runtime, { recursive: true });
  fs.writeFileSync(path.join(b.runtime, 'turn-events.json'), JSON.stringify({
    worker: { heartbeatAtMs: Date.now() }, activeTurns: {},
  }));
  const a = readInstances(f.loc, f.env).instances[0];
  const entries = [a, b].map((record, index) => ({ pid: 10 + index, ppid: 1,
    startTicks: String(10 + index), exe: DESKTOP,
    cmdline: `${DESKTOP} --user-data-dir=${record.desktopProfile}`, env: { CODEX_HOME: record.codexHome } }));
  const operations = [];
  const beforeA = fs.readFileSync(path.join(f.home, 'auth.json'));
  await reprovisionActive('rosetta', f.loc, f.env, {
    processSnapshot: entries, run: fakeAuthCalls(operations),
    stop: async id => { operations.push({ stop: id }); },
    start: id => { operations.push({ start: id }); return { record: b }; },
    wait: async record => { assert.equal(record.instanceId, 'rosetta'); },
  });
  assert.deepEqual(operations.filter(value => value.stop || value.start),
    [{ stop: 'rosetta' }, { start: 'rosetta' }]);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'auth.json')), beforeA);
  assert.equal(readProvisioned(f.loc).instances.rosetta['key-b'].generation, 2);
});

test('per-account operation lock excludes peers, heals stale ownership, and generation advances only after verified update', t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const release = acquireAccountLock(f.loc, 'key-b');
  const paths = poolPaths(f.loc);
  const lock = path.join(paths.accountLocks, `${digest('key-b').slice(0, 32)}.lock`);
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner')));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.identity, /^[0-9a-f-]+:\d+$/);
  assert.match(owner.generation, /^[a-f0-9]{32}$/);
  assert.throws(() => acquireAccountLock(f.loc, 'key-b'), /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/);
  release();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: 999999999,
    identity: 'dead:1', generation: 'a'.repeat(32) }));
  const recovered = acquireAccountLock(f.loc, 'key-b');
  assert.equal(classify(lock), 'live');
  recovered();
  const updated = path.join(f.root, 'updated.auth.json');
  fs.writeFileSync(updated, JSON.stringify({ tokens: { account_id: 'account-b', access_token: 'new-synthetic' } }));
  assert.throws(() => updateCredential('key-b', updated, f.loc), /NOT_VERIFIED/);
  assert.equal(readPool(f.loc).accounts[1].generation, 1);
  assert.throws(() => updateCredential('key-b', path.join(f.home, 'auth.json'), f.loc, { verified: true }), /IDENTITY_MISMATCH/);
  assert.equal(readPool(f.loc).accounts[1].generation, 1);
  const member = updateCredential('key-b', updated, f.loc, { verified: true });
  assert.equal(member.generation, 2);
  assert.equal(readPool(f.loc).accounts[1].snapshotHash, digest(fs.readFileSync(updated)));
  assert.equal(updateCredential('key-b', updated, f.loc, { verified: true }).generation, 2);
});

test('failed instance deletion leaves pool credentials and provisioned state intact', t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
  const state = readProvisioned(f.loc);
  state.instances.rosetta = { 'key-b': { generation: 1, stale: true } };
  writeProvisioned(f.loc, state);
  fs.mkdirSync(b.runtime, { recursive: true });
  fs.writeFileSync(path.join(b.runtime, 'desktop-launch-pending.json'), '{}');
  assert.throws(() => deleteInstanceWithAccounts('rosetta', 'DELETE rosetta', f.loc, f.env), /INSTANCE_LAUNCH_PENDING/);
  assert.equal(readPool(f.loc).accounts.find(value => value.accountKey === 'key-b').needsRepair, undefined);
  assert.deepEqual(readProvisioned(f.loc), state);
});

for (const id of ['default', 'rosetta']) {
  test(`${id}: stale running account applies with verified home and leaves peer untouched`, async t => {
    const f = fixture(t);
    migrateDefault(f.loc, f.env);
    const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
    await provisionAccount('rosetta', 'key-b', f.loc, f.env, { run: fakeAuthCalls([]), processSnapshot: [] });
    const registry = readInstances(f.loc, f.env);
    const selected = registry.instances.find(p => p.instanceId === id);
    const peer = registry.instances.find(p => p.instanceId !== id);
    const key = id === 'default' ? 'key-a' : 'key-b';
    const updated = path.join(f.root, 'updated.auth.json');
    fs.writeFileSync(updated, JSON.stringify({ tokens: { account_id: id === 'default' ? 'account-a' : 'account-b', access_token: 'new' } }));
    updateCredential(key, updated, f.loc, { verified: true });
    const before = fs.readFileSync(path.join(peer.codexHome, 'auth.json'));
    const entries = registry.instances.flatMap((p, n) => [
      { pid: 10 + n * 10, ppid: 1, startTicks: '1', exe: DESKTOP,
        cmdline: `${DESKTOP} --user-data-dir=${p.desktopProfile}`, env: {} },
      { pid: 11 + n * 10, ppid: 10 + n * 10, startTicks: '2', exe: '/usr/lib/chatgpt/resources/codex',
        cmdline: 'codex app-server', env: p.instanceId === 'default' ? { HOME: f.root } : { CODEX_HOME: p.codexHome } },
    ]);
    const calls = [];
    const options = { processSnapshot: entries, assertSafe: () => {}, run: fakeAuthCalls(calls),
      stop: async target => { assert.equal(target, id); },
      start: target => { assert.equal(target, id); return { record: selected }; }, wait: async () => {} };
    const server = entries.find(p => p.ppid === (id === 'default' ? 10 : 20));
    const originalEnv = server.env;
    server.env = { CODEX_HOME: peer.codexHome };
    await assert.rejects(reprovisionActive(id, f.loc, f.env, options), /INSTANCE_HOME_UNVERIFIED/);
    assert.equal(calls.length, 0);
    server.env = originalEnv;
    await reprovisionActive(id, f.loc, f.env, options);
    assert.ok(calls.every(p => p.home === selected.codexHome));
    assert.equal(activeCredentialState(selected, instanceActive(selected, readPool(f.loc)), readPool(f.loc), f.loc).stale, false);
    assert.deepEqual(fs.readFileSync(path.join(peer.codexHome, 'auth.json')), before);
  });

  test(`${id}: stale current account can switch directly to a fresh pool account`, async t => {
    const f = fixture(t);
    migrateDefault(f.loc, f.env);
    const b = createInstance('rosetta', 'Rosetta', f.loc, f.env);
    // Leave default signed out for B to own A, so B can later switch to B.
    if (id === 'rosetta') {
      fs.rmSync(path.join(f.home, 'auth.json'));
      fs.rmSync(path.join(f.home, 'accounts', 'registry.json'));
      await provisionAccount(id, 'key-a', f.loc, f.env, { run: fakeAuthCalls([]), processSnapshot: [] });
    }
    const newer = path.join(f.root, 'new-a.auth.json');
    fs.writeFileSync(newer, JSON.stringify({ tokens: { account_id: 'account-a', access_token: 'new' } }));
    updateCredential('key-a', newer, f.loc, { verified: true });
    const selected = readInstances(f.loc, f.env).instances.find(p => p.instanceId === id);
    assert.equal(activeCredentialState(selected, instanceActive(selected, readPool(f.loc)), readPool(f.loc), f.loc).stale, true);
    const calls = [];
    await provisionAccount(id, 'key-b', f.loc, f.env, { run: fakeAuthCalls(calls), processSnapshot: [] });
    assert.deepEqual(calls.map(p => p.args[0]), ['import', 'switch']);
    assert.ok(calls.every(p => p.home === selected.codexHome));
    assert.equal(instanceActive(selected, readPool(f.loc)).accountKey, 'key-b');
  });
}

test('default pool switch rolls back auth and metadata when target generation verification fails', async t => {
  const f = fixture(t);
  migrateDefault(f.loc, f.env);
  const before = ['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => fs.readFileSync(path.join(f.home, name)));
  const provisionedBefore = readProvisioned(f.loc);
  const run = fakeAuthCalls([]);
  await assert.rejects(provisionAccount('default', 'key-b', f.loc, f.env, {
    processSnapshot: [], run: (command, args, options) => {
      const result = run(command, args, options);
      if (args[0] === 'switch') {
        const auth = JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json')));
        auth.tokens.access_token = 'incorrect-generation';
        fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth));
      }
      return result;
    },
  }), /INSTANCE_CREDENTIAL_GENERATION_UNVERIFIED/);
  assert.deepEqual(['auth.json', 'accounts/registry.json', 'accounts/0.auth.json', 'accounts/1.auth.json']
    .map(name => fs.readFileSync(path.join(f.home, name))), before);
  assert.deepEqual(readProvisioned(f.loc), provisionedBefore);
});
