'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  accountStateError,
  discoverVsCodeCodexChain,
  extensionHostRestartBudget,
  findVsCodeRootAncestor,
  mergeExtensionHostCrashEvents,
  parseExtensionHostCrashEvents,
  processSignalPlan,
  isVsCodeRootProcess,
} = require('../lib/codex-vscode-normalize');

test('maps account-state failures to distinct fail-closed error kinds', () => {
  assert.equal(accountStateError({ ok: false, errors: ['global-auth-account-id-mismatch'] }), 'GLOBAL_AUTH_ACCOUNT_ID_MISMATCH');
  assert.equal(accountStateError({ ok: false, errors: ['registry-active-key-mismatch'] }), 'REGISTRY_ACTIVE_KEY_MISMATCH');
  assert.equal(accountStateError({ ok: false, errors: ['registry-target-account-missing'] }), 'REGISTRY_ACCOUNT_MISSING');
  assert.equal(accountStateError({ ok: false, errors: ['registry-active-account-id-mismatch'] }), 'REGISTRY_ACCOUNT_ID_MISMATCH');
  assert.equal(accountStateError({ ok: true, errors: [] }), null);
});

test('discovers exactly one extension host and its Codex App Server', () => {
  const entries = [
    { pid: 10, ppid: 1, args: ['/proc/self/exe', '--utility-sub-type=node.mojom.NodeService'] },
    { pid: 11, ppid: 10, args: ['/home/me/.vscode/extensions/openai.chatgpt-1/bin/linux-x86_64/codex', 'app-server'] },
    { pid: 12, ppid: 10, args: ['helper'] },
  ];
  assert.deepEqual(discoverVsCodeCodexChain(entries), {
    host: entries[0], server: entries[1], tree: [10, 11, 12],
  });
});

test('fails closed for ambiguous App Server ownership', () => {
  const server = pid => ({ pid, ppid: pid - 1, args: [`/home/me/.vscode/extensions/openai.chatgpt-${pid}/bin/linux-x86_64/codex`, 'app-server'] });
  assert.throws(() => discoverVsCodeCodexChain([server(11), server(21)]), /VSCODE_APP_SERVER_NOT_UNIQUE/);
});

test('distinguishes the VS Code root from an orphaned stopped Pylance child', () => {
  assert.equal(isVsCodeRootProcess({
    pid: 100,
    ppid: 1,
    state: 'S',
    args: ['/usr/share/code/code', '--crash-reporter-id', 'test-id'],
  }), true);
  assert.equal(isVsCodeRootProcess({
    pid: 101,
    ppid: 1,
    state: 'T',
    args: [
      '/usr/share/code/code',
      '/home/me/.vscode/extensions/ms-python.vscode-pylance-1/dist/server.bundle.js',
      '--node-ipc',
      '--clientProcessId=99',
    ],
  }), false);
});

test('parent traversal stops at the strict VS Code root instead of reaching systemd', () => {
  const entries = [
    { pid: 1107, ppid: 1, args: ['/usr/lib/systemd/systemd', '--user'] },
    { pid: 2000, ppid: 1107, args: ['/usr/share/code/code', '--crash-reporter-id', 'test-id'] },
    { pid: 2001, ppid: 2000, args: ['/usr/share/code/code', '--type=utility', '--utility-sub-type=node.mojom.NodeService'] },
    { pid: 2002, ppid: 2001, args: ['/home/me/.vscode/extensions/openai.chatgpt-1/bin/linux-x86_64/codex', 'app-server'] },
  ];
  assert.equal(findVsCodeRootAncestor(entries, 2002).pid, 2000);
});

test('parent traversal rejects an orphaned child chain without a strict VS Code root', () => {
  const entries = [
    { pid: 1, ppid: 0, args: ['/usr/lib/systemd/systemd'] },
    { pid: 3000, ppid: 1, state: 'T', args: ['/usr/share/code/code', '/home/me/server.bundle.js', '--node-ipc'] },
  ];
  assert.throws(() => findVsCodeRootAncestor(entries, 3000), /VSCODE_ROOT_UNVERIFIED/);
});

test('drain plan resumes every stopped descendant and terminates children before host', () => {
  assert.deepEqual(processSignalPlan([10, 11, 12]), {
    stop: [10, 11, 12],
    terminate: [12, 11, 10],
    continue: [12, 11, 10],
    forceKill: [12, 11, 10],
  });
});

test('parses unique local extension-host crash timestamps without treating starts as crashes', () => {
  const events = parseExtensionHostCrashEvents([
    '2026-09-23 10:44:47.821 [error] Extension host (LocalProcess pid: 10) terminated unexpectedly.',
    '2026-09-23 10:44:47.821 [error] Extension host (LocalProcess pid: 10) terminated unexpectedly.',
    '2026-09-23 10:44:48.451 [info] Extension host with pid 11 started',
    'not a timestamp Extension host (LocalProcess pid: 12) terminated unexpectedly.',
  ].join('\n'));
  assert.deepEqual(events, [new Date('2026-09-23T10:44:47.821').getTime()]);
});

test('allows at most the second VS Code crash inside the five-minute auto-restart window', () => {
  const nowMs = new Date('2026-09-23T10:45:03.000').getTime();
  const first = new Date('2026-09-23T10:44:47.000').getTime();
  const second = new Date('2026-09-23T10:44:55.000').getTime();
  assert.deepEqual(extensionHostRestartBudget([first], nowMs), {
    safe: true,
    recentCrashCount: 1,
    safeAtMs: nowMs,
  });
  assert.deepEqual(extensionHostRestartBudget([first, second], nowMs), {
    safe: false,
    recentCrashCount: 2,
    safeAtMs: first + 5 * 60 * 1000 + 1_000,
  });
});

test('merges renderer and extension-host crash records without double counting', () => {
  const timestamp = '2026-09-23 11:29:46.192';
  const line = `${timestamp} [error] Extension host (LocalProcess pid: 10) terminated unexpectedly.`;
  assert.deepEqual(mergeExtensionHostCrashEvents([
    `${line}\n2026-09-23 11:29:46.835 [info] Extension host with pid 11 started`,
    line,
  ]), [new Date('2026-09-23T11:29:46.192').getTime()]);
});

test('re-arms crash restart only after enough old crashes leave the rolling window', () => {
  const first = new Date('2026-09-23T10:40:00.000').getTime();
  const second = new Date('2026-09-23T10:44:00.000').getTime();
  const nowMs = new Date('2026-09-23T10:45:01.001').getTime();
  assert.deepEqual(extensionHostRestartBudget([first, second], nowMs), {
    safe: true,
    recentCrashCount: 1,
    safeAtMs: nowMs,
  });
});
