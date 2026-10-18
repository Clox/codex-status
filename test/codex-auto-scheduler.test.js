'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  autoSchedulerHealth,
  ensureAutoTimerRunning,
  readAutoTimerState,
  MAX_HEARTBEAT_AGE_MS,
} = require('../lib/codex-auto-scheduler');

const NOW = 1_800_000_000_000;
const on = { autoMode: 'HEADLESS' };
const timer = { loadState: 'loaded', activeState: 'active' };

test('HEADLESS with an inactive timer is a current problem regardless of a fresh heartbeat', () => {
  assert.deepEqual(autoSchedulerHealth(on, { heartbeatAtMs: NOW },
    { ...timer, activeState: 'inactive' }, NOW), {
    healthy: false, reason: 'AUTO CONTROLLER/TIMER INACTIVE',
  });
  assert.equal(autoSchedulerHealth({ autoMode: 'OFF' }, {}, null, NOW).healthy, true);
});

test('missing or stale controller heartbeat becomes a problem after the startup grace', () => {
  assert.equal(autoSchedulerHealth(on, {}, timer, NOW).reason, 'AUTO CONTROLLER HEARTBEAT STALE');
  assert.equal(autoSchedulerHealth(on, { heartbeatAtMs: NOW - MAX_HEARTBEAT_AGE_MS - 1 },
    timer, NOW).reason, 'AUTO CONTROLLER HEARTBEAT STALE');
  assert.equal(autoSchedulerHealth(on, { modeEnabledAtMs: NOW - 30_000 }, timer, NOW).healthy, true);
  assert.equal(autoSchedulerHealth(on, { modeEnabledAtMs: NOW - MAX_HEARTBEAT_AGE_MS - 1 },
    timer, NOW).reason, 'AUTO CONTROLLER HEARTBEAT STALE');
});

test('timer dying after an earlier healthy controller run is detected', () => {
  const autoState = { heartbeatAtMs: NOW - 15_000 };
  assert.equal(autoSchedulerHealth(on, autoState, timer, NOW).healthy, true);
  assert.equal(autoSchedulerHealth(on, autoState,
    { ...timer, activeState: 'inactive' }, NOW + 1).reason,
  'AUTO CONTROLLER/TIMER INACTIVE');
});

test('normal disabled and inactive oneshot service has no bearing on scheduler health', () => {
  assert.equal(autoSchedulerHealth({ autoMode: 'HEADLESS' }, { heartbeatAtMs: NOW },
    { ...timer, serviceActiveState: 'inactive', serviceUnitFileState: 'disabled' }, NOW).healthy, true);
});

test('mode activation starts and verifies timer before AUTO can be persisted', () => {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args[1]);
    return args[1] === 'show' ? 'LoadState=loaded\nActiveState=active\n' : '';
  };
  ensureAutoTimerRunning(run);
  assert.deepEqual(calls, ['start', 'show']);
  assert.deepEqual(readAutoTimerState(run), timer);
  assert.throws(() => ensureAutoTimerRunning((_command, args) =>
    args[1] === 'show' ? 'LoadState=loaded\nActiveState=inactive\n' : ''),
  /AUTO_CONTROLLER_TIMER_INACTIVE/);
});

test('status UI renders active-turn waiting and a timer that subsequently stops', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-scheduler-render-'));
  try {
    const codexHome = path.join(root, 'codex');
    const registryDir = path.join(codexHome, 'accounts');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      accounts: [{ account_key: 'account-key', chatgpt_account_id: 'account-a',
        email: 'test@example.com' }],
    }));
    const preferences = path.join(root, 'preferences.json');
    const autoState = path.join(root, 'auto.json');
    const events = path.join(root, 'events.json');
    fs.writeFileSync(preferences, JSON.stringify({ version: 2, autoMode: 'HEADLESS' }));
    fs.writeFileSync(autoState, JSON.stringify({ status: 'waiting', waitingReason: 'active-turns',
      heartbeatAtMs: NOW }));
    fs.writeFileSync(events, JSON.stringify({ version: 4,
      worker: { heartbeatAtMs: NOW, errorKind: null }, activeTurns: {},
      interruptedTurns: {}, terminalTurns: [], files: {}, pendingErrors: {}, exhaustions: {},
    }));
    const env = { ...process.env, CODEX_HOME: codexHome,
      CODEX_STATUS_PREFERENCES: preferences, CODEX_AUTO_CONTINUE_STATE: autoState,
      CODEX_EVENT_STATE: events, CODEX_STATUS_NOW_MS: String(NOW),
      CODEX_SYSTEMCTL_BIN: path.join(__dirname, 'fixtures', 'systemctl-test') };
    const input = '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY\n'
      + '  01 test@example.com Plus  -             -               Now\n';
    const render = override => spawnSync(process.execPath,
      [path.join(__dirname, '..', 'bin', 'codex-usage-annotate')], {
        env: { ...env, ...override }, input, encoding: 'utf8',
        timeout: 5_000,
      });
    const running = render();
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /AUTO: HEADLESS · WAIT: active-turns/);
    assert.doesNotMatch(running.stdout, /AUTO CONTROLLER\/TIMER INACTIVE/);
    const stopped = render({ CODEX_TEST_TIMER_ACTIVE: '0' });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /AUTO CONTROLLER\/TIMER INACTIVE/);
    fs.writeFileSync(autoState, JSON.stringify({ status: 'waiting', waitingReason: 'active-turns',
      heartbeatAtMs: NOW - MAX_HEARTBEAT_AGE_MS - 1 }));
    const stale = render();
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /AUTO CONTROLLER HEARTBEAT STALE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
