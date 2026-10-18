'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  AUTO_MODE,
  autoContinueLine,
  readStatusPreferences,
  toggleAutoContinue,
} = require('../lib/codex-status-preferences');

const fakeSystemctl = path.join(__dirname, 'fixtures', 'systemctl-test');

test('AUTO-CONTINUE defaults fail closed to OFF and renders the permanent control', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'config', 'status-preferences.json');

  const preferences = readStatusPreferences(statePath);

  assert.equal(preferences.autoContinue, false);
  assert.equal(preferences.autoMode, AUTO_MODE.OFF);
  assert.equal(autoContinueLine(preferences), 'AUTO: OFF [A] mode');
});

test('AUTO-CONTINUE toggle persists across independent reads with private permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'config', 'status-preferences.json');

  const enabled = toggleAutoContinue(statePath);
  assert.equal(enabled.autoMode, AUTO_MODE.HEADLESS);
  assert.equal(readStatusPreferences(statePath).autoMode, AUTO_MODE.HEADLESS);
  assert.equal(autoContinueLine(enabled), 'AUTO: HEADLESS [A] mode');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);

  const disabled = toggleAutoContinue(statePath);
  assert.equal(disabled.autoMode, AUTO_MODE.OFF);
  assert.equal(readStatusPreferences(statePath).autoContinue, false);
  assert.equal(toggleAutoContinue(statePath).autoMode, AUTO_MODE.HEADLESS);
});

test('legacy ON migrates only to HEADLESS and never implicitly enables DESKTOP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'status-preferences.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, autoContinue: true }), { mode: 0o600 });
  const migrated = readStatusPreferences(statePath);
  assert.equal(migrated.autoMode, AUTO_MODE.HEADLESS);
  assert.equal(migrated.autoContinue, true);
  const command = path.join(__dirname, '..', 'bin', 'codex-status-preferences');
  const result = spawnSync(process.execPath, [command, 'migrate'], {
    env: { ...process.env, CODEX_STATUS_PREFERENCES: statePath,
      CODEX_AUTO_CONTINUE_STATE: path.join(root, 'auto.json'),
      CODEX_SYSTEMCTL_BIN: fakeSystemctl }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    version: 2, autoMode: AUTO_MODE.HEADLESS,
  });
});

test('persisted DESKTOP mode migrates to HEADLESS and discards only transient DESKTOP work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-migration-'));
  const preferencesPath = path.join(root, 'preferences.json');
  const autoStatePath = path.join(root, 'auto.json');
  fs.writeFileSync(preferencesPath, JSON.stringify({ version: 2, autoMode: 'DESKTOP' }));
  fs.writeFileSync(autoStatePath, JSON.stringify({ status: 'desktop-preflight',
    phase: 'semantic-readiness', pending: { fingerprint: 'old-desktop-plan' },
    candidateThreadId: 'thread-a', candidateTurnId: 'turn-a', targetAccountId: 'target',
    errorKind: 'CHAT_ACTIONS_COUNT_0', actionRequired: true,
    desktopPreflight: { status: 'waiting' },
    desktopAttemptHistory: [{ outcome: 'fallback-headless', errorKind: 'CHAT_ACTIONS_COUNT_0' }],
  }));
  assert.equal(readStatusPreferences(preferencesPath).autoMode, AUTO_MODE.HEADLESS);
  const result = spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'codex-status-preferences'), 'migrate'], {
      env: { ...process.env, CODEX_STATUS_PREFERENCES: preferencesPath,
        CODEX_AUTO_CONTINUE_STATE: autoStatePath, CODEX_SYSTEMCTL_BIN: fakeSystemctl },
      encoding: 'utf8',
    });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(JSON.parse(fs.readFileSync(preferencesPath)).autoMode, AUTO_MODE.HEADLESS);
  const state = JSON.parse(fs.readFileSync(autoStatePath));
  assert.equal(state.status, 'idle');
  assert.equal(state.pending, null);
  assert.equal(state.candidateThreadId, null);
  assert.equal(state.errorKind, null);
  assert.equal(state.desktopPreflight, undefined);
  assert.equal(state.desktopAttemptHistory.length, 1);
});

test('invalid persistent state never silently enables AUTO-CONTINUE', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'status-preferences.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, autoContinue: 'yes' }));

  assert.throws(() => readStatusPreferences(statePath), /STATUS_PREFERENCES_INVALID/);
  assert.throws(() => toggleAutoContinue(statePath), /STATUS_PREFERENCES_INVALID/);
});

test('status control cancels only pending AUTO and OFF to ON clears suppression', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-control-'));
  const preferencesPath = path.join(root, 'config', 'status-preferences.json');
  const autoStatePath = path.join(root, 'cache', 'auto-continue.json');
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.mkdirSync(path.dirname(autoStatePath), { recursive: true });
  fs.writeFileSync(preferencesPath, JSON.stringify({ version: 1, autoContinue: true }), { mode: 0o600 });
  fs.writeFileSync(autoStatePath, JSON.stringify({
    version: 2,
    status: 'pending',
    pending: {
      fingerprint: 'plan-a', threadId: 'thread-a', failedTurnId: 'turn-a', targetAccountId: 'account-b',
    },
  }), { mode: 0o600 });
  const command = path.join(__dirname, '..', 'bin', 'codex-status-preferences');
  const env = {
    ...process.env,
    CODEX_STATUS_PREFERENCES: preferencesPath,
    CODEX_AUTO_CONTINUE_STATE: autoStatePath,
    CODEX_SYSTEMCTL_BIN: fakeSystemctl,
  };

  const canceled = spawnSync(process.execPath, [command, 'cancel-auto-pending'], { env, encoding: 'utf8' });
  assert.equal(canceled.status, 0, canceled.stderr);
  assert.equal(canceled.stdout.trim(), 'canceled');
  let autoState = JSON.parse(fs.readFileSync(autoStatePath, 'utf8'));
  assert.equal(autoState.pending, null);
  assert.equal(autoState.suppression.fingerprint, 'plan-a');

  assert.equal(spawnSync(process.execPath, [command, 'toggle-auto-continue'], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [command, 'toggle-auto-continue'], { env }).status, 0);
  autoState = JSON.parse(fs.readFileSync(autoStatePath, 'utf8'));
  assert.equal(autoState.suppression, null);
  assert.equal(autoState.status, 'idle');
});

test('toggle refuses HEADLESS when timer stays inactive and keeps the previous mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-timer-'));
  const preferencesPath = path.join(root, 'preferences.json');
  const autoStatePath = path.join(root, 'auto.json');
  fs.writeFileSync(preferencesPath, JSON.stringify({ version: 2, autoMode: 'OFF' }));
  const result = spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'codex-status-preferences'), 'toggle-auto-continue'], {
      env: { ...process.env, CODEX_STATUS_PREFERENCES: preferencesPath,
        CODEX_AUTO_CONTINUE_STATE: autoStatePath,
        CODEX_SYSTEMCTL_BIN: fakeSystemctl, CODEX_TEST_TIMER_ACTIVE: '0' },
      encoding: 'utf8',
    });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUTO_CONTROLLER_TIMER_INACTIVE/);
  assert.equal(readStatusPreferences(preferencesPath).autoMode, 'OFF');
});

test('AUTO mode toggle cannot race an account switch or continuation controller', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-lock-'));
  const preferencesPath = path.join(root, 'preferences.json');
  const autoStatePath = path.join(root, 'auto-state.json');
  const operationLockPath = path.join(root, 'exclusive-codex-operation.lock');
  fs.writeFileSync(preferencesPath, JSON.stringify({ version: 2, autoMode: 'OFF' }));
  fs.mkdirSync(operationLockPath);
  fs.writeFileSync(path.join(operationLockPath, 'owner'), `${process.pid}\n`);
  const command = path.join(__dirname, '..', 'bin', 'codex-status-preferences');
  const result = spawnSync(process.execPath, [command, 'toggle-auto-continue'], {
    env: { ...process.env, CODEX_STATUS_PREFERENCES: preferencesPath,
      CODEX_AUTO_CONTINUE_STATE: autoStatePath, CODEX_OPERATION_LOCK_DIR: operationLockPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUTO_MODE_CHANGE_BUSY/);
  assert.equal(JSON.parse(fs.readFileSync(preferencesPath)).autoMode, 'OFF');
});
