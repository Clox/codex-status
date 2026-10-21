'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireOperationLock } = require('./codex-operation-lock');
const { locations, readRegistry: readInstances, instanceById, stopInstance,
  startInstance, waitForRoot, runningInstances, deleteInstance } = require('./codex-instances');
const { verifyActiveAccountState, upstreamSelector } = require('./codex-account-state');

function poolPaths(loc = locations()) {
  const config = path.join(loc.configHome, 'codex-status', 'account-pool');
  const data = path.join(loc.dataHome, 'codex-status', 'account-pool');
  return { registry: path.join(config, 'registry.json'), snapshots: path.join(data, 'snapshots'),
    assignmentLock: path.join(config, 'assignment.lock'),
    accountLocks: path.join(config, 'account-locks'),
    provisioned: path.join(config, 'provisioned.json'),
    switchState: path.join(config, 'switch-state.json') };
}

function digest(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function snapshotPath(paths, key, generation = 1) {
  return path.join(paths.snapshots, `${digest(key).slice(0, 32)}-g${generation}.auth.json`);
}
function accountId(account) { return account.chatgpt_account_id || account.accountId; }
function accounts(registry) { return Array.isArray(registry.accounts) ? registry.accounts : Object.values(registry.accounts || {}); }
function readJson(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function atomicJson(filename, value) { atomicWrite(filename, `${JSON.stringify(value, null, 2)}\n`); }

function findSnapshot(codexHome, wantedId) {
  const directory = path.join(codexHome, 'accounts');
  const matches = fs.readdirSync(directory).filter(name => name.endsWith('.auth.json')).map(name => path.join(directory, name))
    .filter(filename => {
      try { return readJson(filename)?.tokens?.account_id === wantedId; } catch { return false; }
    });
  if (matches.length !== 1) throw new Error('POOL_SOURCE_SNAPSHOT_AMBIGUOUS');
  return matches[0];
}

function readPool(loc = locations()) {
  const paths = poolPaths(loc);
  if (!fs.existsSync(paths.registry)) return null;
  try {
    const registry = readJson(paths.registry);
    if (registry.version !== 1 || !Array.isArray(registry.accounts) ||
        Object.hasOwn(registry, 'activeAccountKey') || Object.hasOwn(registry, 'active_account_key')) {
      throw new Error('INVALID_ACCOUNT_POOL');
    }
    const keys = new Set();
    for (const account of registry.accounts) {
      if (!account.accountKey || !account.accountId || !Number.isSafeInteger(account.generation) ||
          account.generation < 1 || !account.credentialUpdatedAt || keys.has(account.accountKey) ||
          account.snapshotHash !== digest(fs.readFileSync(snapshotPath(paths, account.accountKey, account.generation)))) {
        throw new Error('INVALID_ACCOUNT_POOL');
      }
      keys.add(account.accountKey);
    }
    return registry;
  } catch (error) { throw new Error(`INVALID_ACCOUNT_POOL:${error.message}`); }
}

function migrateDefault(loc = locations(), env = process.env) {
  const paths = poolPaths(loc);
  const release = acquireOperationLock(paths.assignmentLock);
  try {
    const existing = readPool(loc);
    if (existing) return existing;
    const primary = instanceById(readInstances(loc, env), 'default');
    const source = readJson(path.join(primary.codexHome, 'accounts', 'registry.json'));
    const auth = readJson(path.join(primary.codexHome, 'auth.json'));
    const active = accounts(source).find(value => value.account_key === source.active_account_key);
    if (!active || auth?.tokens?.account_id !== accountId(active)) throw new Error('DEFAULT_ACTIVE_ACCOUNT_UNVERIFIED');
    const records = [];
    const pending = [];
    for (const account of accounts(source)) {
      if (!account.account_key || !accountId(account)) throw new Error('POOL_ACCOUNT_IDENTITY_INCOMPLETE');
      const sourceFile = findSnapshot(primary.codexHome, accountId(account));
      const bytes = fs.readFileSync(sourceFile);
      const target = snapshotPath(paths, account.account_key, 1);
      if (fs.existsSync(target)) {
        if (digest(fs.readFileSync(target)) !== digest(bytes)) throw new Error('POOL_MIGRATION_SNAPSHOT_CONFLICT');
      } else pending.push({ target, bytes });
      records.push({ accountKey: account.account_key, accountId: accountId(account),
        email: account.email || null, displayName: account.account_name || account.alias || account.email || account.account_key,
        alias: account.alias || null, generation: 1, credentialUpdatedAt: new Date().toISOString(),
        snapshotHash: digest(bytes) });
    }
    fs.mkdirSync(paths.snapshots, { recursive: true, mode: 0o700 });
    for (const item of pending) atomicWrite(item.target, item.bytes);
    const pool = { version: 1, accounts: records };
    atomicJson(paths.registry, pool);
    return pool;
  } finally { release(); }
}

function addPoolAccount(accountKey, loc = locations(), env = process.env) {
  const paths = poolPaths(loc);
  const releaseAssignment = acquireOperationLock(paths.assignmentLock);
  let releaseAccount;
  try {
    releaseAccount = acquireAccountLock(loc, accountKey);
    const pool = readPool(loc);
    if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
    if (pool.accounts.some(value => value.accountKey === accountKey)) return pool;
    const primary = instanceById(readInstances(loc, env), 'default');
    const source = readJson(path.join(primary.codexHome, 'accounts', 'registry.json'));
    const account = accounts(source).find(value => value.account_key === accountKey);
    if (!account || !accountId(account)) throw new Error('POOL_ACCOUNT_IDENTITY_INCOMPLETE');
    const bytes = fs.readFileSync(findSnapshot(primary.codexHome, accountId(account)));
    atomicWrite(snapshotPath(paths, accountKey, 1), bytes);
    pool.accounts.push({ accountKey, accountId: accountId(account), email: account.email || null,
      displayName: account.account_name || account.alias || account.email || accountKey,
      alias: account.alias || null, generation: 1, credentialUpdatedAt: new Date().toISOString(),
      snapshotHash: digest(bytes) });
    atomicJson(paths.registry, pool);
    return pool;
  } finally { if (releaseAccount) releaseAccount(); releaseAssignment(); }
}

function assertAccountRemovable(accountKey, loc = locations(), env = process.env) {
  const pool = readPool(loc);
  if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
  const holder = accountHolder(assignments(readInstances(loc, env), pool), accountKey, null);
  if (holder) throw new Error(`ACCOUNT_IN_USE_BY:${holder.displayName}`);
  if (!pool.accounts.some(value => value.accountKey === accountKey)) throw new Error('POOL_ACCOUNT_NOT_FOUND');
  return pool;
}

function removePoolAccountLocked(accountKey, loc = locations()) {
  const paths = poolPaths(loc);
  const pool = readPool(loc);
  if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
  const member = pool.accounts.find(value => value.accountKey === accountKey);
  if (!member) throw new Error('POOL_ACCOUNT_NOT_FOUND');
  pool.accounts = pool.accounts.filter(value => value.accountKey !== accountKey);
  atomicJson(paths.registry, pool);
  for (let generation = 1; generation <= member.generation; generation++) {
    try { fs.unlinkSync(snapshotPath(paths, accountKey, generation)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function deleteInstanceWithAccounts(instanceId, confirmation, loc = locations(), env = process.env) {
  const release = acquireOperationLock(poolPaths(loc).assignmentLock);
  try {
    if (instanceId === 'default') throw new Error('DEFAULT_INSTANCE_CANNOT_BE_DELETED');
    if (confirmation !== `DELETE ${instanceId}`) throw new Error('INSTANCE_DELETE_CONFIRMATION_REQUIRED');
    const pool = readPool(loc);
    const state = readProvisioned(loc);
    const deleted = deleteInstance(instanceId, confirmation, loc, env, null, instance => {
      if (!pool) return;
      const active = instanceActive(instance, pool);
      let changed = false;
      for (const [key, provision] of Object.entries(state.instances[instanceId] || {})) {
        const member = pool.accounts.find(value => value.accountKey === key);
        if (!member) continue;
        let stale = provision.stale === true || provision.generation !== member.generation;
        try { stale ||= digest(fs.readFileSync(findSnapshot(instance.codexHome, member.accountId))) !== member.snapshotHash; }
        catch { stale = true; }
        if (active?.accountKey === key) {
          try { stale ||= digest(fs.readFileSync(path.join(instance.codexHome, 'auth.json'))) !== member.snapshotHash; }
          catch { stale = true; }
        }
        if (stale && !member.needsRepair) { member.needsRepair = true; changed = true; }
      }
      if (changed) atomicJson(poolPaths(loc).registry, pool);
    });
    delete state.instances[instanceId];
    writeProvisioned(loc, state);
    return deleted;
  } finally { release(); }
}

function instanceActive(instance, pool = null) {
  const authPath = path.join(instance.codexHome, 'auth.json');
  const registryPath = path.join(instance.codexHome, 'accounts', 'registry.json');
  if (!fs.existsSync(authPath) && !fs.existsSync(registryPath)) return null;
  if (!fs.existsSync(authPath) && fs.existsSync(registryPath) && readJson(registryPath).active_account_key == null) return null;
  if (!fs.existsSync(authPath) || !fs.existsSync(registryPath)) throw new Error(`INSTANCE_AUTH_INCOMPLETE:${instance.instanceId}`);
  const registry = readJson(registryPath);
  const auth = readJson(authPath);
  const key = registry.active_account_key;
  const entry = accounts(registry).find(value => value.account_key === key);
  if (!entry || !accountId(entry)) throw new Error(`INSTANCE_ACTIVE_ACCOUNT_UNVERIFIED:${instance.instanceId}`);
  const result = verifyActiveAccountState({ registry, globalAuth: auth,
    expectedAccountId: accountId(entry), expectedAccountKey: key });
  if (!result.ok) throw new Error(`INSTANCE_ACTIVE_ACCOUNT_UNVERIFIED:${instance.instanceId}`);
  if (pool) {
    const member = pool.accounts.find(value => value.accountKey === key && value.accountId === accountId(entry));
    if (!member) throw new Error(`INSTANCE_ACCOUNT_NOT_IN_POOL:${instance.instanceId}`);
  }
  return { accountKey: key, accountId: accountId(entry) };
}

function assignments(instances, pool) {
  return instances.instances.map(instance => ({ instance, active: instanceActive(instance, pool) }));
}

function accountHolder(items, key, exceptId) {
  return items.find(item => item.instance.instanceId !== exceptId && item.active?.accountKey === key)?.instance || null;
}

function assertCredentialAvailable(accountKey, instanceId, registry, pool, loc = locations()) {
  const target = pool.accounts.find(value => value.accountKey === accountKey);
  if (!target) throw new Error('POOL_ACCOUNT_NOT_FOUND');
  if (target.needsRepair) throw new Error('POOL_CREDENTIAL_REPAIR_REQUIRED');
  const holder = accountHolder(assignments(registry, pool), accountKey, instanceId);
  if (holder) throw new Error(`ACCOUNT_IN_USE_BY:${holder.displayName}`);
  if (instanceId === 'default') {
    // The primary switch uses its own codex-auth snapshot. An inactive
    // secondary's older copy cannot make this verified primary copy stale.
    const primary = instanceById(registry, instanceId);
    let source;
    try { source = findSnapshot(primary.codexHome, target.accountId); }
    catch { throw new Error(`CREDENTIAL_REPROVISION_NEEDED:${primary.displayName}`); }
    if (digest(fs.readFileSync(source)) !== target.snapshotHash) {
      throw new Error(`CREDENTIAL_REPROVISION_NEEDED:${primary.displayName}`);
    }
    return target;
  }
  const provisioned = readProvisioned(loc);
  for (const other of registry.instances.filter(value => value.instanceId !== instanceId)) {
    const otherSnapshot = (() => { try { return findSnapshot(other.codexHome, target.accountId); } catch { return null; } })();
    if (!otherSnapshot) continue;
    const ownership = provisioned.instances[other.instanceId]?.[accountKey];
    if ((other.instanceId === 'default' || ownership) &&
        (ownership?.stale || (ownership && ownership.generation !== target.generation) ||
         digest(fs.readFileSync(otherSnapshot)) !== target.snapshotHash)) {
      throw new Error(`CREDENTIAL_REPROVISION_NEEDED:${other.displayName}`);
    }
  }
  return target;
}

function readProvisioned(loc = locations()) {
  try { const value = readJson(poolPaths(loc).provisioned); return value.version === 1 ? value : { version: 1, instances: {} }; }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, instances: {} }; throw error; }
}
function writeProvisioned(loc, value) { atomicJson(poolPaths(loc).provisioned, value); }

function recordRelease(instanceId, loc = locations(), env = process.env) {
  const pool = readPool(loc);
  if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
  const instance = instanceById(readInstances(loc, env), instanceId);
  const active = instanceActive(instance, pool);
  if (!active) return null;
  const member = pool.accounts.find(value => value.accountKey === active.accountKey);
  const source = findSnapshot(instance.codexHome, active.accountId);
  const state = readProvisioned(loc);
  state.instances[instanceId] ||= {};
  const old = state.instances[instanceId][active.accountKey];
  state.instances[instanceId][active.accountKey] = { generation: old?.generation || member.generation,
    stale: digest(fs.readFileSync(source)) !== member.snapshotHash ||
      digest(fs.readFileSync(path.join(instance.codexHome, 'auth.json'))) !== member.snapshotHash,
    at: new Date().toISOString() };
  writeProvisioned(loc, state);
  return state.instances[instanceId][active.accountKey];
}

function acquireAccountLock(loc, accountKey) {
  const paths = poolPaths(loc);
  return acquireOperationLock(accountLockPath(loc, accountKey));
}

function accountLockPath(loc, accountKey) {
  return path.join(poolPaths(loc).accountLocks, `${digest(accountKey).slice(0, 32)}.lock`);
}

function updateCredentialLocked(accountKey, sourceFile, loc = locations(), { verified = false } = {}) {
  if (verified !== true) throw new Error('POOL_CREDENTIAL_UPDATE_NOT_VERIFIED');
  const paths = poolPaths(loc);
  const pool = readPool(loc);
  if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
  const member = pool.accounts.find(value => value.accountKey === accountKey);
  if (!member) throw new Error('POOL_ACCOUNT_NOT_FOUND');
  const bytes = fs.readFileSync(sourceFile);
  if (JSON.parse(bytes)?.tokens?.account_id !== member.accountId) throw new Error('POOL_CREDENTIAL_IDENTITY_MISMATCH');
  const hash = digest(bytes);
  if (hash === member.snapshotHash) {
    if (member.needsRepair) { delete member.needsRepair; atomicJson(paths.registry, pool); }
    return member;
  }
  const next = member.generation + 1;
  atomicWrite(snapshotPath(paths, accountKey, next), bytes);
  member.generation = next;
  member.snapshotHash = hash;
  member.credentialUpdatedAt = new Date().toISOString();
  delete member.needsRepair;
  atomicJson(paths.registry, pool);
  return member;
}

function updateCredential(accountKey, sourceFile, loc = locations(), options = {}) {
  const releaseAssignment = acquireOperationLock(poolPaths(loc).assignmentLock);
  let releaseAccount;
  try {
    releaseAccount = acquireAccountLock(loc, accountKey);
    return updateCredentialLocked(accountKey, sourceFile, loc, options);
  } finally { if (releaseAccount) releaseAccount(); releaseAssignment(); }
}

function runAuth(command, args, home, loc, run = spawnSync) {
  const root = path.dirname(home);
  const secondary = home !== instanceById(readInstances(loc), 'default').codexHome;
  const isolation = secondary ? { HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'auth-xdg-config'), XDG_CACHE_HOME: path.join(root, 'auth-xdg-cache'),
    XDG_DATA_HOME: path.join(root, 'auth-xdg-data') } : {};
  const result = run(command, args, { env: { ...process.env, ...isolation, CODEX_HOME: home,
    CODEX_AUTH_SKIP_SERVICE_RECONCILE: '1',
    CODEX_AUTH_DISABLE_BACKGROUND_ACCOUNT_NAME_REFRESH: '1' }, stdio: 'ignore', timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`INSTANCE_AUTH_${args[0].toUpperCase()}_FAILED`);
}

function authFiles(home) {
  const directory = path.join(home, 'accounts');
  return [path.join(home, 'auth.json'), path.join(directory, 'registry.json'),
    ...(fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.auth.json'))
      .map(name => path.join(directory, name)) : [])];
}

function captureAuth(home) {
  return new Map(authFiles(home).filter(filename => fs.existsSync(filename))
    .map(filename => [filename, fs.readFileSync(filename)]));
}

function restoreAuth(home, before) {
  for (const filename of authFiles(home)) {
    if (!before.has(filename)) fs.rmSync(filename, { force: true });
  }
  for (const [filename, bytes] of before) atomicWrite(filename, bytes);
}

async function provisionAccount(instanceId, accountKey, loc = locations(), env = process.env,
  { authBin = 'codex-auth', run = spawnSync, stop = stopInstance,
    start = startInstance, wait = waitForRoot, processSnapshot = null } = {}) {
  const paths = poolPaths(loc);
  let releaseAssignment;
  let releaseAccount;
  let authBefore = null;
  let restoreHome = null;
  let wasRunning = false;
  let stopped = false;
  let launchAttempted = false;
  let provisionedBefore = null;
  const publish = (phase, extra = {}) => atomicJson(paths.switchState, {
    version: 1, instanceId, phase, accountKey, updatedAtMs: Date.now(), ...extra,
  });
  try {
    releaseAssignment = acquireOperationLock(paths.assignmentLock);
    const pool = readPool(loc);
    if (!pool) throw new Error('ACCOUNT_POOL_NOT_MIGRATED');
    if (instanceId === 'default') throw new Error('DEFAULT_SWITCH_REQUIRES_LEGACY_FLOW');
    releaseAccount = acquireAccountLock(loc, accountKey);
    const registry = readInstances(loc, env);
    const instance = instanceById(registry, instanceId);
    if (!instance.enabled) throw new Error('INSTANCE_DISABLED');
    const current = assignments(registry, pool);
    const target = assertCredentialAvailable(accountKey, instanceId, registry, pool, loc);
    if (current.find(value => value.instance.instanceId === instanceId).active?.accountKey === accountKey) {
      return { unchanged: true, instance, account: target };
    }
    const prior = current.find(value => value.instance.instanceId === instanceId).active;
    const running = runningInstances(registry, processSnapshot || undefined).find(value => value.instanceId === instanceId);
    wasRunning = running.roots.length > 0;
    publish('preparing', { instanceName: instance.displayName, sourceAccountKey: prior?.accountKey || null,
      targetAccountId: target.accountId });
    if (wasRunning) { await stop(instanceId, loc, env); stopped = true; }
    provisionedBefore = readProvisioned(loc);
    if (prior) recordRelease(instanceId, loc, env);
    const provisioned = readProvisioned(loc);
    const snap = snapshotPath(paths, accountKey, target.generation);
    const bytes = fs.readFileSync(snap);
    if (digest(bytes) !== target.snapshotHash || readJson(snap)?.tokens?.account_id !== target.accountId) {
      throw new Error('POOL_SNAPSHOT_UNVERIFIED');
    }
    const localRegistryPath = path.join(instance.codexHome, 'accounts', 'registry.json');
    restoreHome = instance.codexHome;
    authBefore = captureAuth(restoreHome);
    publish('switching', { instanceName: instance.displayName, sourceAccountKey: prior?.accountKey || null,
      targetAccountId: target.accountId });
    runAuth(authBin, ['import', snap], instance.codexHome, loc, run);
    const imported = readJson(localRegistryPath);
    const importedTarget = accounts(imported).find(value => value.account_key === accountKey && accountId(value) === target.accountId);
    if (!importedTarget) throw new Error('INSTANCE_IMPORT_POSTCONDITION_FAILED');
    const selector = upstreamSelector(imported, accountKey);
    runAuth(authBin, ['switch', selector], instance.codexHome, loc, run);
    publish('verifying', { instanceName: instance.displayName, sourceAccountKey: prior?.accountKey || null,
      targetAccountId: target.accountId });
    const verified = instanceActive(instance, pool);
    if (verified?.accountKey !== accountKey || verified.accountId !== target.accountId) throw new Error('INSTANCE_SWITCH_POSTCONDITION_FAILED');
    provisioned.instances[instanceId] ||= {};
    provisioned.instances[instanceId][accountKey] = { generation: target.generation, stale: false,
      at: new Date().toISOString() };
    writeProvisioned(loc, provisioned);
    if (wasRunning) { launchAttempted = true; const launch = start(instanceId, loc, env); await wait(launch.record); }
    publish('completed', { instanceName: instance.displayName, targetAccountId: target.accountId });
    return { unchanged: false, instance, account: target, prior };
  } catch (error) {
    if (authBefore && !launchAttempted) {
      try { restoreAuth(restoreHome, authBefore); }
      catch (rollbackError) { error = new AggregateError([error, rollbackError], 'INSTANCE_AUTH_ROLLBACK_FAILED'); }
    }
    if (provisionedBefore && !launchAttempted) {
      try { writeProvisioned(loc, provisionedBefore); }
      catch (rollbackError) { error = new AggregateError([error, rollbackError], 'INSTANCE_PROVISIONED_ROLLBACK_FAILED'); }
    }
    if (wasRunning && stopped && !launchAttempted) {
      try { const launch = start(instanceId, loc, env); await wait(launch.record); }
      catch (restartError) { error = new AggregateError([error, restartError], 'INSTANCE_RESTART_AFTER_FAILURE_FAILED'); }
    }
    if (releaseAssignment) publish('failed', { errorKind: error.message });
    throw error;
  } finally { if (releaseAccount) releaseAccount(); if (releaseAssignment) releaseAssignment(); }
}

function readSwitchState(loc = locations()) {
  try { const state = readJson(poolPaths(loc).switchState);
    return Date.now() - Number(state.updatedAtMs) < (['completed', 'failed'].includes(state.phase) ? 10000 : 90000)
      ? state : null;
  } catch { return null; }
}

module.exports = { poolPaths, snapshotPath, readPool, migrateDefault, instanceActive, assignments,
  accountHolder, assertCredentialAvailable, accountLockPath, acquireAccountLock, readProvisioned, writeProvisioned, provisionAccount,
  addPoolAccount, assertAccountRemovable, removePoolAccountLocked, deleteInstanceWithAccounts, recordRelease,
  updateCredential, updateCredentialLocked, readSwitchState, findSnapshot, digest, atomicWrite, atomicJson };
