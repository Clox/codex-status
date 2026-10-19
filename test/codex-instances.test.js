'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DESKTOP, locations, defaultInstance, derivedInstance, instanceNamespaces, readRegistry, createInstance,
  renameInstance, deleteInstance, ownedRoots, runningInstances, startInstance, stopInstance,
  focusInstance, openInstance,
  clearStalePending,
  resolveInstanceSelection,
} = require('../lib/codex-instances');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-instances-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share') };
  const loc = locations(env);
  fs.mkdirSync(path.dirname(loc.legacyConfig), { recursive: true });
  fs.writeFileSync(loc.legacyConfig, `CODEX_HOME=${path.join(home, '.codex')}\nACCOUNT_1=private\n`);
  return { home, env, loc };
}

function fakeProcesses(a, b) {
  return [
    { pid: 10, ppid: 1, startTicks: '100', exe: DESKTOP, cmdline: DESKTOP, env: {} },
    { pid: 11, ppid: 10, startTicks: '101', exe: DESKTOP,
      cmdline: `${DESKTOP} --type=renderer --user-data-dir=${a.desktopProfile}`, env: {} },
    { pid: 12, ppid: 10, startTicks: '102', exe: '/usr/lib/chatgpt/resources/codex',
      cmdline: 'codex app-server', env: { CODEX_HOME: a.codexHome } },
    { pid: 20, ppid: 1, startTicks: '200', exe: DESKTOP,
      cmdline: `${DESKTOP} --user-data-dir=${b.desktopProfile}`, env: {} },
    { pid: 21, ppid: 20, startTicks: '201', exe: '/usr/lib/chatgpt/resources/codex',
      cmdline: 'codex app-server', env: { CODEX_HOME: b.codexHome } },
  ];
}

test('unregistered default uses exact legacy paths without writing a registry', t => {
  const { home, env, loc } = fixture(t);
  const primary = defaultInstance(loc, env);
  assert.equal(primary.instanceId, 'default');
  assert.equal(primary.codexHome, path.join(home, '.codex'));
  assert.equal(primary.desktopProfile, path.join(home, '.config', 'Codex'));
  assert.equal(primary.statusConfig, path.join(home, '.config', 'codex-account-switcher'));
  assert.equal(primary.runtime, path.join(home, '.cache', 'codex-account-switcher'));
  assert.equal(instanceNamespaces(primary).statusWindowLock,
    path.join(home, '.cache', 'codex-account-switcher', 'status-window-v2.lock'));
  assert.equal(instanceNamespaces(primary).journals, primary.runtime);
  assert.deepEqual(readRegistry(loc, env).instances.map(value => value.instanceId), ['default']);
  assert.equal(fs.existsSync(loc.registry), false);
  assert.match(fs.readFileSync(loc.legacyConfig, 'utf8'), /ACCOUNT_1=private/);
});

test('test mode refuses missing or live namespace paths', () => {
  assert.ok(process.env.CODEX_STATUS_TEST_ROOT);
  const liveHome = os.userInfo().homedir;
  assert.throws(() => locations({}), /TEST_HOME_REQUIRED/);
  assert.throws(() => locations({ HOME: liveHome, XDG_CONFIG_HOME: path.join(liveHome, '.config') }),
    /TEST_NAMESPACE_REQUIRED/);
  const root = process.env.CODEX_STATUS_TEST_ROOT;
  assert.throws(() => locations({ HOME: root, XDG_DATA_HOME: path.join(liveHome, '.local', 'share') }),
    /TEST_NAMESPACE_REQUIRED/);
  assert.equal(locations({ HOME: root }).home, root);
});

test('new instance has a separate namespace and registry persists default without moving legacy data', t => {
  const { home, env, loc } = fixture(t);
  const legacyState = path.join(home, '.codex', 'state_5.sqlite');
  fs.mkdirSync(path.dirname(legacyState));
  fs.writeFileSync(legacyState, 'untouched');
  const rosetta = createInstance('rosetta', 'Rosetta', loc, env);
  assert.deepEqual(rosetta, derivedInstance('rosetta', 'Rosetta', loc, rosetta.createdAt));
  for (const field of ['codexHome', 'desktopProfile', 'statusConfig', 'runtime']) {
    assert.ok(fs.statSync(rosetta[field]).isDirectory());
    assert.notEqual(rosetta[field], defaultInstance(loc, env)[field]);
  }
  assert.equal(instanceNamespaces(rosetta).statusWindowLock, path.join(rosetta.runtime, 'status-window-v2.lock'));
  assert.equal(instanceNamespaces(rosetta).journals, path.join(rosetta.runtime, 'journals'));
  assert.equal(instanceNamespaces(rosetta).state, path.join(rosetta.runtime, 'state'));
  assert.equal(fs.readFileSync(legacyState, 'utf8'), 'untouched');
  assert.deepEqual(readRegistry(loc, env).instances.map(value => value.instanceId), ['default', 'rosetta']);
  assert.equal(fs.statSync(loc.registry).mode & 0o777, 0o600);
  renameInstance('rosetta', 'Rosetta II', loc, env);
  assert.equal(readRegistry(loc, env).instances[1].displayName, 'Rosetta II');
});

test('manager resolves a displayed instance by number, name or stable ID', t => {
  const { env, loc } = fixture(t);
  createInstance('rosetta', 'Rosetta', loc, env);
  const registry = readRegistry(loc, env);
  for (const selection of ['2', 'Rosetta', 'rosetta', 'ROSETTA']) {
    assert.equal(resolveInstanceSelection(registry, selection).instanceId, 'rosetta');
  }
  assert.throws(() => resolveInstanceSelection(registry, '3'), /INSTANCE_NOT_FOUND/);
});

test('same binary is separated by profile and Codex home; stop can signal only B', async t => {
  const { env, loc } = fixture(t);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const a = readRegistry(loc, env).instances[0];
  const processes = fakeProcesses(a, b);
  assert.deepEqual(ownedRoots(a, processes), [{ pid: 10, startTicks: '100' }]);
  assert.deepEqual(ownedRoots(b, processes), [{ pid: 20, startTicks: '200' }]);
  assert.deepEqual(runningInstances(readRegistry(loc, env), processes).map(value => value.roots[0].pid), [10, 20]);
  const wrongHome = processes.map(value => value.pid === 21
    ? { ...value, env: { CODEX_HOME: a.codexHome } } : value);
  assert.deepEqual(ownedRoots(b, wrongHome), []);
  const similarProfile = processes.map(value => value.pid === 20
    ? { ...value, cmdline: `${DESKTOP} --user-data-dir=${b.desktopProfile}-other` } : value)
    .filter(value => value.pid !== 21);
  assert.deepEqual(ownedRoots(b, similarProfile), []);
  assert.deepEqual(runningInstances(readRegistry(loc, env), similarProfile)[1].roots, []);
  let live = processes;
  const signaled = [];
  const root = await stopInstance('rosetta', loc, env, {
    snapshot: () => live,
    signal: (pid, signal) => {
      signaled.push([pid, signal]);
      live = live.filter(value => value.pid !== pid && value.ppid !== pid);
    },
  });
  assert.equal(root.pid, 20);
  assert.deepEqual(signaled, [[20, 'SIGTERM']]);
  assert.deepEqual(ownedRoots(a, live), [{ pid: 10, startTicks: '100' }]);
});

test('O starts only stopped B and focuses running B without restarting either instance', async t => {
  const { env, loc } = fixture(t);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const a = readRegistry(loc, env).instances[0];
  const calls = [];
  const start = (id, targetLoc) => {
    calls.push(['start', id]);
    assert.equal(targetLoc, loc);
    return { record: b };
  };
  const wait = async record => {
    assert.equal(record, b);
    return { pid: 20, startTicks: '200' };
  };
  const focus = id => {
    calls.push(['focus', id]);
    return { root: { pid: 20, startTicks: '200' }, windowId: '0x02000001' };
  };
  const stopped = await openInstance('rosetta', loc, env, {
    snapshot: () => fakeProcesses(a, b).filter(value => value.pid < 20), start, wait, focus,
  });
  assert.equal(stopped.action, 'started');
  assert.deepEqual(calls, [['start', 'rosetta']]);
  const running = await openInstance('rosetta', loc, env, {
    snapshot: () => fakeProcesses(a, b), start, wait, focus,
  });
  assert.equal(running.action, 'focused');
  assert.deepEqual(calls, [['start', 'rosetta'], ['focus', 'rosetta']]);
  assert.deepEqual(ownedRoots(a, fakeProcesses(a, b)), [{ pid: 10, startTicks: '100' }]);
});

test('focus raises only a window owned by the verified instance and fails closed on PID changes', t => {
  const { env, loc } = fixture(t);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const a = readRegistry(loc, env).instances[0];
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return args[0] === '-lp'
      ? { status: 0, stdout: '0x01000001 0 10 host ChatGPT A\n0x02000001 0 20 host ChatGPT B\n' }
      : { status: 0 };
  };
  const result = focusInstance('rosetta', loc, env, {
    snapshot: () => fakeProcesses(a, b), run, sessionType: 'x11',
  });
  assert.equal(result.windowId, '0x02000001');
  assert.deepEqual(calls, [['wmctrl', '-lp'], ['wmctrl', '-i', '-a', '0x02000001']]);
  let reads = 0;
  assert.throws(() => focusInstance('rosetta', loc, env, {
    snapshot: () => (++reads === 1 ? fakeProcesses(a, b)
      : fakeProcesses(a, b).map(value => value.pid === 20 ? { ...value, startTicks: '999' } : value)),
    run, sessionType: 'x11',
  }), /INSTANCE_ROOT_CHANGED/);
  assert.equal(calls.length, 3); // Only the read-only window listing was repeated.
  assert.throws(() => focusInstance('rosetta', loc, env, {
    snapshot: () => fakeProcesses(a, b),
    run: () => ({ status: 0, stdout: '0x01000001 0 10 host ChatGPT A\n' }),
    sessionType: 'x11',
  }), /INSTANCE_WINDOW_NOT_FOUND/);
});

test('start uses explicit B paths, separate unit, and no global ChatGPT process name', t => {
  const { env, loc } = fixture(t);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const a = readRegistry(loc, env).instances[0];
  fs.mkdirSync(a.codexHome, { recursive: true });
  fs.mkdirSync(a.desktopProfile, { recursive: true });
  const calls = [];
  const run = (command, args) => { calls.push({ command, args }); return { status: 0 }; };
  startInstance('rosetta', loc, env, { entries: fakeProcesses(a, b).filter(value => value.pid < 20), run });
  assert.equal(calls[0].command, 'systemd-run');
  assert.ok(calls[0].args.includes(`--setenv=CODEX_HOME=${b.codexHome}`));
  assert.ok(calls[0].args.includes(`--setenv=CODEX_ELECTRON_USER_DATA_PATH=${b.desktopProfile}`));
  assert.ok(calls[0].args.includes(`--user-data-dir=${b.desktopProfile}`));
  assert.ok(calls[0].args.some(value => value.startsWith('--property=ReadOnlyPaths=') &&
    value.includes(a.codexHome) && value.includes(a.desktopProfile)));
  assert.match(calls[0].args.find(value => value.startsWith('--unit=')), /codex-desktop-instance-rosetta-/);
  assert.ok(!calls[0].args.join(' ').includes('pkill'));
  assert.throws(() => deleteInstance('rosetta', 'DELETE rosetta', loc, env, []), /INSTANCE_LAUNCH_PENDING/);
  assert.equal(clearStalePending('rosetta', loc, env, { entries: [],
    run: () => ({ status: 3 }) }), true);
  assert.equal(fs.existsSync(path.join(b.runtime, 'desktop-launch-pending.json')), false);
});

test('delete rejects default and running B, requires exact confirmation, and removes only B paths', t => {
  const { home, env, loc } = fixture(t);
  const b = createInstance('rosetta', 'Rosetta', loc, env);
  const a = readRegistry(loc, env).instances[0];
  const shared = path.join(home, 'shared.txt');
  fs.writeFileSync(shared, 'shared');
  const legacy = path.join(home, '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(legacy, 'legacy');
  assert.throws(() => deleteInstance('default', 'DELETE default', loc, env, []), /DEFAULT_INSTANCE/);
  assert.throws(() => deleteInstance('rosetta', 'yes', loc, env, []), /CONFIRMATION/);
  assert.throws(() => deleteInstance('rosetta', 'DELETE rosetta', loc, env,
    fakeProcesses(a, b)), /INSTANCE_RUNNING/);
  assert.throws(() => deleteInstance('rosetta', 'DELETE rosetta', loc, env,
    fakeProcesses(a, b).filter(value => value.pid === 21)), /INSTANCE_RUNNING/);
  deleteInstance('rosetta', 'DELETE rosetta', loc, env, fakeProcesses(a, b).filter(value => value.pid < 20));
  for (const field of ['codexHome', 'desktopProfile', 'statusConfig', 'runtime']) {
    assert.equal(fs.existsSync(b[field]), false);
  }
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy');
  assert.deepEqual(readRegistry(loc, env).instances.map(value => value.instanceId), ['default']);
});
