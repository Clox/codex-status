'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  autoContinueLine,
  readStatusPreferences,
  toggleAutoContinue,
} = require('../lib/codex-status-preferences');

test('AUTO-CONTINUE defaults fail closed to OFF and renders the permanent control', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'config', 'status-preferences.json');

  const preferences = readStatusPreferences(statePath);

  assert.equal(preferences.autoContinue, false);
  assert.equal(autoContinueLine(preferences), 'AUTO-CONTINUE: OFF [A] toggle');
});

test('AUTO-CONTINUE toggle persists across independent reads with private permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'config', 'status-preferences.json');

  const enabled = toggleAutoContinue(statePath);
  assert.equal(enabled.autoContinue, true);
  assert.equal(readStatusPreferences(statePath).autoContinue, true);
  assert.equal(autoContinueLine(enabled), 'AUTO-CONTINUE: ON [A] toggle');
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);

  const disabled = toggleAutoContinue(statePath);
  assert.equal(disabled.autoContinue, false);
  assert.equal(readStatusPreferences(statePath).autoContinue, false);
});

test('invalid persistent state never silently enables AUTO-CONTINUE', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-preferences-'));
  const statePath = path.join(root, 'status-preferences.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, autoContinue: 'yes' }));

  assert.throws(() => readStatusPreferences(statePath), /STATUS_PREFERENCES_INVALID/);
  assert.throws(() => toggleAutoContinue(statePath), /STATUS_PREFERENCES_INVALID/);
});
