'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  applyProtocolNotification,
  applyRolloutRecord,
  clearRecoveredExhaustions,
  emptyEventState,
  observerHealth,
  pruneEventState,
} = require('../lib/codex-turn-observer');

const NOW = 1_800_000_000_000;
const binding = { accountId: 'account-a', accountKey: 'key-a', title: 'Observed thread', nowMs: NOW };

function started(state, threadId = 'thread-a', turnId = 'turn-a') {
  return applyProtocolNotification(state, {
    method: 'turn/started',
    params: { threadId, turn: { id: turnId, startedAt: NOW / 1000, status: 'inProgress' } },
  }, binding);
}

test('formatted zero usage alone never creates verified exhaustion', () => {
  let state = started(emptyEventState(NOW));
  state = clearRecoveredExhaustions(state, {
    accounts: {
      'account-a': {
        primary: { remainingPercent: 0 },
        secondary: { remainingPercent: 0 },
        refresh: { lastSuccessAt: NOW },
      },
    },
  });
  assert.deepEqual(state.exhaustions, {});
  assert.equal(Object.keys(state.activeTurns).length, 1);
});

test('usageLimitExceeded requires willRetry false and matching failed completion', () => {
  let retrying = started(emptyEventState(NOW));
  retrying = applyProtocolNotification(retrying, {
    method: 'error',
    params: {
      threadId: 'thread-a', turnId: 'turn-a', willRetry: true,
      error: { codexErrorInfo: 'usageLimitExceeded' },
    },
  }, { nowMs: NOW + 10 });
  retrying = applyProtocolNotification(retrying, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-a',
      turn: { id: 'turn-a', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } },
    },
  }, { nowMs: NOW + 20 });
  assert.deepEqual(retrying.exhaustions, {});

  let terminal = started(emptyEventState(NOW));
  terminal = applyProtocolNotification(terminal, {
    method: 'error',
    params: {
      threadId: 'thread-a', turnId: 'turn-a', willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded' },
    },
  }, { nowMs: NOW + 10 });
  terminal = applyProtocolNotification(terminal, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-a',
      turn: { id: 'turn-a', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } },
    },
  }, { nowMs: NOW + 20 });
  assert.equal(terminal.exhaustions['account-a'].verified, true);
  assert.equal(terminal.exhaustions['account-a'].pool, 'account');
  assert.equal(terminal.exhaustions['account-a'].willRetry, false);
});

test('mismatched terminal event cannot verify exhaustion', () => {
  let state = started(emptyEventState(NOW));
  state = applyProtocolNotification(state, {
    method: 'error',
    params: {
      threadId: 'thread-a', turnId: 'turn-a', willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded' },
    },
  }, { nowMs: NOW + 10 });
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: {
      threadId: 'thread-a',
      turn: { id: 'turn-b', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } },
    },
  }, { nowMs: NOW + 20 });
  assert.deepEqual(state.exhaustions, {});
});

test('multiple active turns are independent and every terminal state removes only its turn', () => {
  let state = started(emptyEventState(NOW), 'thread-a', 'turn-a');
  state = started(state, 'thread-b', 'turn-b');
  assert.deepEqual(Object.keys(state.activeTurns).sort(), ['turn-a', 'turn-b']);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted', error: null } },
  }, { nowMs: NOW + 100 });
  assert.deepEqual(Object.keys(state.activeTurns), ['turn-b']);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'completed', error: null } },
  }, { nowMs: NOW + 200 });
  assert.deepEqual(state.activeTurns, {});
});

test('persisted rollout task_complete is a terminal post-retry exhaustion record', () => {
  let state = applyRolloutRecord(emptyEventState(NOW), {
    type: 'event_msg', timestamp: new Date(NOW).toISOString(),
    payload: { type: 'task_started', turn_id: 'turn-a', started_at: NOW },
  }, { ...binding, threadId: 'thread-a', observedAtMs: NOW });
  state = applyRolloutRecord(state, {
    type: 'event_msg', timestamp: new Date(NOW + 1000).toISOString(),
    payload: {
      type: 'task_complete', turn_id: 'turn-a', completed_at: NOW + 1000,
      error: { codex_error_info: 'usage_limit_exceeded' },
    },
  }, { threadId: 'thread-a', nowMs: NOW + 1000 });
  assert.deepEqual(state.activeTurns, {});
  assert.equal(state.exhaustions['account-a'].source, 'rollout-terminal');
});

test('later verified successful usage clears exhaustion but stale percentages do not', () => {
  let state = started(emptyEventState(NOW));
  state = applyProtocolNotification(state, {
    method: 'error',
    params: { threadId: 'thread-a', turnId: 'turn-a', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } },
  }, { nowMs: NOW + 10 });
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } },
  }, { nowMs: NOW + 20 });
  const stale = clearRecoveredExhaustions(state, {
    accounts: { 'account-a': {
      primary: { remainingPercent: 90 }, secondary: { remainingPercent: 90 },
      rateLimitReachedTypeObserved: true, rateLimitReachedType: null,
      refresh: { lastSuccessAt: NOW - 1 },
    } },
  });
  assert.ok(stale.exhaustions['account-a']);
  const recovered = clearRecoveredExhaustions(state, {
    accounts: { 'account-a': {
      primary: { remainingPercent: 90 }, secondary: { remainingPercent: 90 },
      rateLimitReachedTypeObserved: true, rateLimitReachedType: null,
      refresh: { lastSuccessAt: NOW + 100 },
    } },
  });
  assert.equal(recovered.exhaustions['account-a'], undefined);
});

test('old active records are pruned and stale observer health is fail closed', () => {
  let state = started(emptyEventState(NOW));
  state = pruneEventState(state, NOW + 1000, { activeMaxAgeMs: 500 });
  assert.deepEqual(state.activeTurns, {});
  assert.equal(observerHealth(state, NOW + 20_000).healthy, false);
});

test('observer checkpoints atomically and does not resurrect old active turns after restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '09', '22');
  const registryDirectory = path.join(codexHome, 'accounts');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), JSON.stringify({
    active_account_key: 'key-a',
    accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a' }],
  }));
  const rollout = path.join(sessionDirectory, 'rollout-test.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: 'session_meta', payload: { id: 'thread-old' }, timestamp: new Date().toISOString(),
  })}\n${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-old' }, timestamp: new Date().toISOString(),
  })}\n`);
  const observer = path.join(__dirname, '..', 'bin', 'codex-turn-observer');
  const environment = {
    ...process.env,
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: cache,
  };
  let result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});

  const timestamp = new Date().toISOString();
  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'session_meta', payload: { id: 'thread-new' }, timestamp,
  })}\n${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-new', started_at: Date.now() }, timestamp,
  })}\n`);
  result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.equal(state.activeTurns['turn-new'].accountId, 'account-a');

  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-new' }, timestamp: new Date().toISOString(),
  })}\n`);
  result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(fs.statSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')).mode & 0o777, 0o600);
});

test('observer sees future appends in an existing rollout with a large session_meta record', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-observer-large-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '09', '22');
  const registryDirectory = path.join(codexHome, 'accounts');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), JSON.stringify({
    active_account_key: 'key-a',
    accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a' }],
  }));
  const rollout = path.join(sessionDirectory, 'rollout-existing.jsonl');
  const threadId = '01a0c579-76af-7471-9117-6174d6060974';
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: threadId, session_id: threadId, base_instructions: 'x'.repeat(20_000) },
    timestamp: new Date().toISOString(),
  })}\n${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_started', turn_id: 'historical-turn' },
    timestamp: new Date().toISOString(),
  })}\n`);
  const observer = path.join(__dirname, '..', 'bin', 'codex-turn-observer');
  const environment = {
    ...process.env,
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: cache,
  };

  let result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(Object.values(state.files)[0].sessionId, threadId);

  // Reproduce the checkpoint written by the old fixed-size first-line reader:
  // the EOF offset was correct, but the oversized session_meta could not be parsed.
  Object.values(state.files)[0].sessionId = null;
  fs.writeFileSync(
    path.join(cache, 'codex-account-switcher', 'turn-events.json'),
    `${JSON.stringify(state)}\n`,
  );

  const timestamp = new Date().toISOString();
  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'live-turn', started_at: Date.now() },
    timestamp,
  })}\n`);
  result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.equal(state.activeTurns['live-turn'].threadId, threadId);
  assert.equal(state.activeTurns['live-turn'].accountId, 'account-a');

  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_complete', turn_id: 'live-turn' },
    timestamp: new Date().toISOString(),
  })}\n`);
  result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(state.terminalTurns.at(-1).threadId, threadId);
  assert.equal(state.terminalTurns.at(-1).turnId, 'live-turn');
});
