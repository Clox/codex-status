'use strict';

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
  assert.equal(enabled.autoMode, AUTO_MODE.DESKTOP);
  assert.equal(readStatusPreferences(statePath).autoMode, AUTO_MODE.DESKTOP);
  assert.equal(autoContinueLine(enabled), 'AUTO: DESKTOP [A] mode');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);

  const headless = toggleAutoContinue(statePath);
  assert.equal(headless.autoMode, AUTO_MODE.HEADLESS);
  const disabled = toggleAutoContinue(statePath);
  assert.equal(disabled.autoMode, AUTO_MODE.OFF);
  assert.equal(readStatusPreferences(statePath).autoContinue, false);
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
    env: { ...process.env, CODEX_STATUS_PREFERENCES: statePath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    version: 2, autoMode: AUTO_MODE.HEADLESS,
  });
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
  };

  const canceled = spawnSync(process.execPath, [command, 'cancel-auto-pending'], { env, encoding: 'utf8' });
  assert.equal(canceled.status, 0, canceled.stderr);
  assert.equal(canceled.stdout.trim(), 'canceled');
  let autoState = JSON.parse(fs.readFileSync(autoStatePath, 'utf8'));
  assert.equal(autoState.pending, null);
  assert.equal(autoState.suppression.fingerprint, 'plan-a');

  assert.equal(spawnSync(process.execPath, [command, 'toggle-auto-continue'], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [command, 'toggle-auto-continue'], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [command, 'toggle-auto-continue'], { env }).status, 0);
  autoState = JSON.parse(fs.readFileSync(autoStatePath, 'utf8'));
  assert.equal(autoState.suppression, null);
  assert.equal(autoState.status, 'idle');
});
