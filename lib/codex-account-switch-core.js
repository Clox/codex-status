'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveActiveAccount, resolveExpectedAccount, upstreamSelector,
  verifyActiveAccountState } = require('./codex-account-state');

function defaultSwitchStatePath() {
  return process.env.CODEX_ACCOUNT_SWITCH_STATE || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'codex-account-switcher', 'account-switch.json');
}

function writeSwitchState(filename, state) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readSwitchState(filename = defaultSwitchStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch { return null; }
}

function displaySwitchState(state, nowMs = Date.now()) {
  if (!state || !['preparing', 'switching', 'verifying', 'completed', 'failed'].includes(state.phase)) return null;
  const age = nowMs - Number(state.updatedAtMs);
  const lifetime = ['completed', 'failed'].includes(state.phase) ? 10_000 : 90_000;
  return Number.isFinite(age) && age >= -5_000 && age <= lifetime ? state : null;
}

function runAccountSwitch({ codexHome, targetAccountKey, authBin = 'codex-auth',
  statePath = defaultSwitchStatePath(), source = 'manual',
  run = (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 60_000 }),
  now = Date.now,
}) {
  const registryPath = path.join(codexHome, 'accounts', 'registry.json');
  const authPath = path.join(codexHome, 'auth.json');
  const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
  let state = { version: 1, source, phase: 'preparing', pid: process.pid,
    sourceAccountId: null, targetAccountId: null, targetAccountKey,
    startedAtMs: now(), updatedAtMs: now() };
  const publish = phase => {
    state = { ...state, phase, updatedAtMs: now() };
    writeSwitchState(statePath, state);
  };
  publish('preparing');
  try {
    const registry = read(registryPath);
    const before = resolveActiveAccount(registry, read(authPath));
    const target = resolveExpectedAccount(registry, targetAccountKey);
    if (target.accountKey !== targetAccountKey) throw new Error('ACCOUNT_TARGET_KEY_MISMATCH');
    const selector = upstreamSelector(registry, targetAccountKey);
    state = { ...state, sourceAccountId: before.accountId, sourceAccountKey: before.accountKey,
      targetAccountId: target.accountId };
    publish('preparing');
    if (before.accountId !== target.accountId || before.accountKey !== target.accountKey) {
      publish('switching');
      const result = run(authBin, ['switch', selector]);
      if (result?.error || result?.status !== 0) throw new Error('ACCOUNT_SWITCH_FAILED');
    }
    publish('verifying');
    const afterRegistry = read(registryPath);
    const verification = verifyActiveAccountState({ registry: afterRegistry,
      globalAuth: read(authPath), expectedAccountId: target.accountId,
      expectedAccountKey: target.accountKey });
    if (!verification.ok) throw new Error('ACCOUNT_SWITCH_POSTCONDITION_FAILED');
    publish('completed');
    return { source: before, target, switched: before.accountId !== target.accountId };
  } catch (error) {
    state = { ...state, errorKind: error?.message || 'ACCOUNT_SWITCH_FAILED' };
    publish('failed');
    throw error;
  }
}

module.exports = { defaultSwitchStatePath, displaySwitchState, readSwitchState,
  runAccountSwitch, writeSwitchState };
