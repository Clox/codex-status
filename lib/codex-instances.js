'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { acquireOperationLock } = require('./codex-operation-lock');

const VERSION = 1;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const DESKTOP = '/usr/lib/chatgpt/ChatGPT';

function assertTestPath(value) {
  if (!process.env.CODEX_STATUS_TEST_ROOT) return;
  const root = path.resolve(os.tmpdir());
  const candidate = path.resolve(value || '');
  if (!path.isAbsolute(value || '') || candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`TEST_NAMESPACE_REQUIRED:${candidate}`);
  }
  let current = candidate;
  while (!fs.existsSync(current)) current = path.dirname(current);
  if (current !== root && !fs.realpathSync(current).startsWith(`${fs.realpathSync(root)}${path.sep}`)) {
    throw new Error(`TEST_NAMESPACE_REQUIRED:${candidate}`);
  }
}

function locations(env = process.env) {
  if (process.env.CODEX_STATUS_TEST_ROOT && !env.HOME) throw new Error('TEST_HOME_REQUIRED');
  const home = env.HOME || os.homedir();
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const cacheHome = env.XDG_CACHE_HOME || path.join(home, '.cache');
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  for (const value of [home, configHome, cacheHome, dataHome]) assertTestPath(value);
  return {
    home, configHome, cacheHome, dataHome,
    registry: path.join(configHome, 'codex-status', 'instances.json'),
    legacyConfig: path.join(configHome, 'codex-account-switcher', 'accounts.conf'),
  };
}

function legacyCodexHome(loc, env = process.env) {
  try {
    const line = fs.readFileSync(loc.legacyConfig, 'utf8').split('\n')
      .find(value => value.startsWith('CODEX_HOME='));
    // install.sh uses printf %q. A simple absolute assignment covers the
    // existing installation; unusual shell quoting must be supplied via env.
    const value = line?.slice('CODEX_HOME='.length);
    if (value && /^\/[A-Za-z0-9_./-]+$/.test(value)) {
      assertTestPath(value);
      return path.resolve(value);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (env.CODEX_HOME) { assertTestPath(env.CODEX_HOME); return path.resolve(env.CODEX_HOME); }
  return path.join(loc.home, '.codex');
}

function defaultInstance(loc = locations(), env = process.env) {
  let createdAt = new Date(0).toISOString();
  try { createdAt = fs.statSync(loc.legacyConfig).birthtime.toISOString(); } catch {}
  return {
    instanceId: 'default', displayName: 'Spadrig',
    codexHome: legacyCodexHome(loc, env),
    desktopProfile: path.join(loc.configHome, 'Codex'),
    statusConfig: path.join(loc.configHome, 'codex-account-switcher'),
    runtime: path.join(loc.cacheHome, 'codex-account-switcher'),
    createdAt, enabled: true,
  };
}

function derivedInstance(instanceId, displayName, loc = locations(), createdAt = new Date().toISOString()) {
  if (!ID.test(instanceId) || instanceId === 'default') throw new Error('INVALID_INSTANCE_ID');
  const root = path.join(loc.dataHome, 'codex-status', 'instances', instanceId);
  return {
    instanceId, displayName,
    codexHome: path.join(root, 'codex-home'),
    desktopProfile: path.join(root, 'desktop-profile'),
    statusConfig: path.join(loc.configHome, 'codex-status', 'instances', instanceId),
    runtime: path.join(loc.cacheHome, 'codex-status', 'instances', instanceId),
    createdAt, enabled: true,
  };
}

function instanceNamespaces(record) {
  const secondary = record.instanceId !== 'default';
  return {
    statusWindowLock: path.join(record.runtime, 'status-window-v2.lock'),
    state: secondary ? path.join(record.runtime, 'state') : record.runtime,
    journals: secondary ? path.join(record.runtime, 'journals') : record.runtime,
    pendingLaunch: path.join(record.runtime, 'desktop-launch-pending.json'),
  };
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('INVALID_INSTANCE_NAME');
  }
  return name.trim();
}

function validateRecord(record, loc) {
  if (!record || typeof record !== 'object' || !ID.test(record.instanceId) ||
      !record.createdAt || typeof record.createdAt !== 'string' ||
      typeof record.enabled !== 'boolean') throw new Error('INVALID_INSTANCE_REGISTRY');
  validateName(record.displayName);
  if (record.instanceId !== 'default') {
    const expected = derivedInstance(record.instanceId, record.displayName, loc, record.createdAt);
    for (const field of ['codexHome', 'desktopProfile', 'statusConfig', 'runtime']) {
      if (record[field] !== expected[field]) throw new Error('INSTANCE_PATH_MISMATCH');
    }
  }
  for (const field of ['codexHome', 'desktopProfile', 'statusConfig', 'runtime']) {
    if (!path.isAbsolute(record[field])) throw new Error('INVALID_INSTANCE_REGISTRY');
  }
  return record;
}

function readRegistry(loc = locations(), env = process.env) {
  const primary = defaultInstance(loc, env);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(loc.registry, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: VERSION, instances: [primary] };
    throw new Error('INVALID_INSTANCE_REGISTRY');
  }
  if (parsed?.version !== VERSION || !Array.isArray(parsed.instances)) throw new Error('INVALID_INSTANCE_REGISTRY');
  const ids = new Set();
  const records = parsed.instances.map(record => {
    validateRecord(record, loc);
    if (ids.has(record.instanceId)) throw new Error('DUPLICATE_INSTANCE_ID');
    ids.add(record.instanceId);
    return record;
  });
  const savedDefault = records.find(record => record.instanceId === 'default');
  if (savedDefault) {
    // Paths belonging to the existing installation remain authoritative.
    for (const field of ['codexHome', 'desktopProfile', 'statusConfig', 'runtime']) {
      if (savedDefault[field] !== primary[field]) throw new Error('DEFAULT_INSTANCE_PATH_MISMATCH');
    }
    records[records.indexOf(savedDefault)] = { ...primary, displayName: savedDefault.displayName,
      createdAt: savedDefault.createdAt, enabled: savedDefault.enabled };
  } else records.unshift(primary);
  return { version: VERSION, instances: records };
}

function withRegistryLock(loc, action) {
  const release = acquireOperationLock(`${loc.registry}.lock`);
  try { return action(); }
  finally { release(); }
}

function writeRegistry(loc, registry) {
  const temporary = `${loc.registry}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, loc.registry);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function instanceById(registry, instanceId) {
  const record = registry.instances.find(value => value.instanceId === instanceId);
  if (!record) throw new Error('INSTANCE_NOT_FOUND');
  return record;
}

function createInstance(instanceId, displayName, loc = locations(), env = process.env) {
  displayName = validateName(displayName);
  return withRegistryLock(loc, () => {
    const registry = readRegistry(loc, env);
    if (registry.instances.some(value => value.instanceId === instanceId)) throw new Error('INSTANCE_EXISTS');
    const record = derivedInstance(instanceId, displayName, loc);
    const paths = [record.codexHome, record.desktopProfile, record.statusConfig, record.runtime];
    if (paths.some(value => fs.existsSync(value))) throw new Error('INSTANCE_PATH_EXISTS');
    try {
      for (const value of paths) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
      registry.instances.push(record);
      writeRegistry(loc, registry);
      return record;
    } catch (error) {
      for (const value of paths.reverse()) fs.rmSync(value, { recursive: true, force: true });
      throw error;
    }
  });
}

function renameInstance(instanceId, displayName, loc = locations(), env = process.env) {
  displayName = validateName(displayName);
  return withRegistryLock(loc, () => {
    const registry = readRegistry(loc, env);
    const record = instanceById(registry, instanceId);
    record.displayName = displayName;
    writeRegistry(loc, registry);
    return record;
  });
}

function setInstanceEnabled(instanceId, enabled, loc = locations(), env = process.env) {
  if (typeof enabled !== 'boolean') throw new Error('INVALID_INSTANCE_ENABLED');
  return withRegistryLock(loc, () => {
    const registry = readRegistry(loc, env);
    const record = instanceById(registry, instanceId);
    if (instanceId === 'default' && !enabled) throw new Error('DEFAULT_INSTANCE_CANNOT_BE_DISABLED');
    record.enabled = enabled;
    writeRegistry(loc, registry);
    return record;
  });
}

function processEntries(proc = '/proc') {
  const entries = [];
  for (const name of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const base = path.join(proc, name);
    try {
      const exe = fs.readlinkSync(path.join(base, 'exe'));
      if (exe !== DESKTOP && !exe.endsWith('/chatgpt/resources/codex')) continue;
      const cmdline = fs.readFileSync(path.join(base, 'cmdline')).toString().split('\0').filter(Boolean).join(' ');
      if (!cmdline) continue;
      const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const env = Object.fromEntries(fs.readFileSync(path.join(base, 'environ'))
        .toString().split('\0').filter(value => value.includes('='))
        .map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
      entries.push({ pid: Number(name), ppid: Number(fields[1]), startTicks: fields[19],
        exe, cmdline, env });
    } catch {} // Exited or inaccessible processes cannot establish ownership.
  }
  return entries;
}

function rootFamilies(entries, binary = DESKTOP) {
  const byParent = new Map();
  for (const entry of entries) {
    const children = byParent.get(entry.ppid) || [];
    children.push(entry);
    byParent.set(entry.ppid, children);
  }
  return entries.filter(entry => entry.exe === binary && !/(?:^|\s)--type=/.test(entry.cmdline))
    .map(root => {
      const family = [root];
      const seen = new Set([root.pid]);
      for (let i = 0; i < family.length; i++) {
        for (const child of byParent.get(family[i].pid) || []) {
          if (!seen.has(child.pid)) { seen.add(child.pid); family.push(child); }
        }
      }
      return { root, family };
    });
}

function hasProfile(entry, instance) {
  if (entry.env.CODEX_ELECTRON_USER_DATA_PATH === instance.desktopProfile) return true;
  const flag = `--user-data-dir=${instance.desktopProfile}`;
  const index = entry.cmdline.indexOf(flag);
  return index >= 0 && (index === 0 || entry.cmdline[index - 1] === ' ') &&
    (index + flag.length === entry.cmdline.length || entry.cmdline[index + flag.length] === ' ');
}

function instanceProcessEntries(instance, entries) {
  return entries.filter(entry => hasProfile(entry, instance) || entry.env.CODEX_HOME === instance.codexHome);
}

function profileRoots(instance, entries, binary = DESKTOP) {
  return rootFamilies(entries, binary).filter(({ family }) =>
    family.some(value => hasProfile(value, instance)))
    .map(({ root }) => ({ pid: root.pid, startTicks: root.startTicks }));
}

function ownedRoots(instance, entries, binary = DESKTOP) {
  return rootFamilies(entries, binary)
    .filter(({ family }) => {
      const profile = family.some(value => hasProfile(value, instance));
      const home = family.some(value => value.env.CODEX_HOME === instance.codexHome);
      return profile && home;
    }).map(({ root }) => ({ pid: root.pid, startTicks: root.startTicks }));
}

function runningInstances(registry, entries = processEntries(), binary = DESKTOP) {
  return registry.instances.map(record => ({ ...record,
    roots: profileRoots(record, entries, binary),
    verifiedRoots: ownedRoots(record, entries, binary),
  }));
}

function safeOwnedDirectory(value) {
  try { return fs.lstatSync(value).isDirectory() && !fs.lstatSync(value).isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function pendingPath(record) { return instanceNamespaces(record).pendingLaunch; }

function clearPending(record) {
  try { fs.unlinkSync(pendingPath(record)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function deleteInstance(instanceId, confirmation, loc = locations(), env = process.env,
  entries = null, beforeRemove = null) {
  if (instanceId === 'default') throw new Error('DEFAULT_INSTANCE_CANNOT_BE_DELETED');
  if (confirmation !== `DELETE ${instanceId}`) throw new Error('INSTANCE_DELETE_CONFIRMATION_REQUIRED');
  return withRegistryLock(loc, () => {
    const registry = readRegistry(loc, env);
    const record = instanceById(registry, instanceId);
    if (fs.existsSync(pendingPath(record))) throw new Error('INSTANCE_LAUNCH_PENDING');
    if (instanceProcessEntries(record, entries || processEntries()).length) throw new Error('INSTANCE_RUNNING');
    const expected = derivedInstance(instanceId, record.displayName, loc, record.createdAt);
    const paths = [path.dirname(expected.codexHome), expected.statusConfig, expected.runtime];
    for (const value of paths) {
      if (fs.existsSync(value) && (!safeOwnedDirectory(value) || fs.realpathSync(value) !== path.resolve(value))) {
        throw new Error('INSTANCE_PATH_UNSAFE');
      }
    }
    if (beforeRemove) beforeRemove(record);
    // Registry is updated only after all owned directories are removed.
    for (const value of paths) fs.rmSync(value, { recursive: true, force: true });
    registry.instances = registry.instances.filter(value => value.instanceId !== instanceId);
    writeRegistry(loc, registry);
    return record;
  });
}

function startInstance(instanceId, loc = locations(), env = process.env,
  { binary = DESKTOP, systemdRun = 'systemd-run', entries = null, run = spawnSync } = {}) {
  return withRegistryLock(loc, () => {
    const registry = readRegistry(loc, env);
    const record = instanceById(registry, instanceId);
    if (!record.enabled) throw new Error('INSTANCE_DISABLED');
    if (fs.existsSync(pendingPath(record))) throw new Error('INSTANCE_LAUNCH_PENDING');
    if (instanceProcessEntries(record, entries || processEntries()).length) throw new Error('INSTANCE_RUNNING');
    if (!fs.existsSync(record.codexHome) || !fs.existsSync(record.desktopProfile)) throw new Error('INSTANCE_PATH_MISSING');
    const unit = `codex-desktop-instance-${instanceId}-${process.pid}-${Date.now()}`;
    const args = ['--user', '--quiet', '--collect', `--unit=${unit}`,
      `--setenv=CODEX_HOME=${record.codexHome}`,
      `--setenv=CODEX_ELECTRON_USER_DATA_PATH=${record.desktopProfile}`];
    if (instanceId !== 'default') {
      const otherPaths = registry.instances.filter(value => value.instanceId !== instanceId)
        .flatMap(value => [value.codexHome, value.desktopProfile, value.statusConfig, value.runtime])
        .filter(value => fs.existsSync(value));
      const legacyDesktopCache = path.join(loc.cacheHome, 'Codex');
      if (fs.existsSync(legacyDesktopCache)) otherPaths.push(legacyDesktopCache);
      if (otherPaths.length) args.push(`--property=ReadOnlyPaths=${otherPaths.join(' ')}`);
      args.push(
        `--setenv=XDG_CONFIG_HOME=${path.join(record.statusConfig, 'xdg')}`,
        `--setenv=XDG_CACHE_HOME=${path.join(record.runtime, 'xdg')}`,
        `--setenv=XDG_DATA_HOME=${path.join(path.dirname(record.codexHome), 'xdg-data')}`,
      );
    }
    args.push('--', binary, `--user-data-dir=${record.desktopProfile}`);
    fs.mkdirSync(record.runtime, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pendingPath(record), `${JSON.stringify({ unit, createdAt: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600 });
    const result = run(systemdRun, args, { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) {
      clearPending(record);
      throw new Error('INSTANCE_START_FAILED');
    }
    return { unit, record };
  });
}

async function waitForRoot(instance, binary = DESKTOP, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  do {
    const roots = ownedRoots(instance, processEntries(), binary);
    if (roots.length === 1) { clearPending(instance); return roots[0]; }
    if (roots.length > 1) throw new Error('INSTANCE_ROOT_AMBIGUOUS');
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < until);
  throw new Error('INSTANCE_ROOT_NOT_VERIFIED');
}

async function stopInstance(instanceId, loc = locations(), env = process.env,
  { binary = DESKTOP, signal = process.kill, snapshot = processEntries, timeoutMs = 15000 } = {}) {
  const record = instanceById(readRegistry(loc, env), instanceId);
  const first = snapshot();
  const roots = ownedRoots(record, first, binary);
  if (!roots.length && instanceProcessEntries(record, first).length) throw new Error('INSTANCE_HOME_UNVERIFIED');
  if (roots.length !== 1) throw new Error(roots.length ? 'INSTANCE_ROOT_AMBIGUOUS' : 'INSTANCE_NOT_RUNNING');
  const root = roots[0];
  const current = snapshot().find(entry => entry.pid === root.pid);
  if (!current || current.startTicks !== root.startTicks ||
      !ownedRoots(record, snapshot(), binary).some(value => value.pid === root.pid && value.startTicks === root.startTicks)) {
    throw new Error('INSTANCE_ROOT_CHANGED');
  }
  signal(root.pid, 'SIGTERM');
  const until = Date.now() + timeoutMs;
  do {
    if (!instanceProcessEntries(record, snapshot()).length) {
      clearPending(record);
      return root;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < until);
  throw new Error('INSTANCE_STOP_TIMEOUT');
}

function clearStalePending(instanceId, loc = locations(), env = process.env,
  { entries = processEntries(), run = spawnSync } = {}) {
  return withRegistryLock(loc, () => {
    const record = instanceById(readRegistry(loc, env), instanceId);
    if (!fs.existsSync(pendingPath(record))) return false;
    if (instanceProcessEntries(record, entries).length) throw new Error('INSTANCE_RUNNING');
    const pending = JSON.parse(fs.readFileSync(pendingPath(record), 'utf8'));
    if (!/^codex-desktop-instance-[a-z0-9-]+-\d+-\d+$/.test(pending.unit)) {
      throw new Error('INSTANCE_PENDING_STATE_INVALID');
    }
    const result = run('systemctl', ['--user', 'is-active', `${pending.unit}.service`],
      { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status === 0 || ![3, 4].includes(result.status)) {
      throw new Error('INSTANCE_LAUNCH_STATE_UNVERIFIED');
    }
    clearPending(record);
    return true;
  });
}

module.exports = { VERSION, DESKTOP, locations, legacyCodexHome, defaultInstance, derivedInstance,
  instanceNamespaces,
  readRegistry, createInstance, renameInstance, setInstanceEnabled, deleteInstance, instanceById,
  processEntries, profileRoots, ownedRoots, runningInstances, startInstance, waitForRoot, stopInstance,
  clearStalePending };
