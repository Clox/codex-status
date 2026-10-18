'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  applyProtocolNotification,
  applyRolloutRecord,
  classifyRolloutTurn,
  clearRecoveredExhaustions,
  emptyEventState,
  observerHealth,
  pruneEventState,
  turnKey,
} = require('../lib/codex-turn-observer');
const { INTERRUPTION_CLASS } = require('../lib/codex-turn-continuation');

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
  assert.equal(terminal.interruptedTurns[turnKey('thread-a', 'turn-a')].resumable, true);
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
  assert.deepEqual(Object.keys(state.activeTurns).sort(), [turnKey('thread-a', 'turn-a'), turnKey('thread-b', 'turn-b')]);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted', error: null } },
  }, { nowMs: NOW + 100 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('thread-b', 'turn-b')]);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-b', turn: { id: 'turn-b', status: 'completed', error: null } },
  }, { nowMs: NOW + 200 });
  assert.deepEqual(state.activeTurns, {});
});

test('turn identity is the thread and turn pair, including repeated events and later turns', () => {
  let state = started(emptyEventState(NOW), 'parent-thread', 'shared-turn');
  state = started(state, 'child-thread', 'shared-turn');
  state = started(state, 'child-thread', 'shared-turn');
  assert.equal(Object.keys(state.activeTurns).length, 2);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'child-thread', turn: { id: 'shared-turn', status: 'completed' } },
  }, { nowMs: NOW + 100 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('parent-thread', 'shared-turn')]);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'child-thread', turn: { id: 'shared-turn', status: 'completed' } },
  }, { nowMs: NOW + 100 });
  assert.equal(state.terminalTurns.length, 1);
  state = started(state, 'child-thread', 'shared-turn');
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('parent-thread', 'shared-turn')]);
  state = started(state, 'child-thread', 'next-turn');
  assert.equal(Object.keys(state.activeTurns).length, 2);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'parent-thread', turn: { id: 'shared-turn', status: 'completed' } },
  }, { nowMs: NOW + 200 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('child-thread', 'next-turn')]);
});

test('rollout turn_aborted removes only the matching turn among multiple turns in one thread', () => {
  let state = started(emptyEventState(NOW), 'thread-a', 'turn-a');
  state = started(state, 'thread-a', 'turn-b');
  state = applyRolloutRecord(state, {
    type: 'event_msg', timestamp: new Date(NOW + 100).toISOString(),
    payload: { type: 'turn_aborted', turn_id: 'turn-a', completed_at: NOW + 100, reason: 'interrupted' },
  }, { threadId: 'thread-a', nowMs: NOW + 100 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('thread-a', 'turn-b')]);
  assert.equal(state.terminalTurns.at(-1).threadId, 'thread-a');
  assert.equal(state.terminalTurns.at(-1).turnId, 'turn-a');
  assert.equal(state.terminalTurns.at(-1).status, 'aborted');
});

test('turn_aborted matches the exact thread-turn pair, clears pending usage errors, and is replay safe', () => {
  let state = started(emptyEventState(NOW), 'thread-a', 'shared-turn');
  state = started(state, 'thread-b', 'shared-turn');
  state = applyProtocolNotification(state, {
    method: 'error',
    params: {
      threadId: 'thread-a', turnId: 'shared-turn', willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded' },
    },
  }, { nowMs: NOW + 10 });
  const abortedRecord = {
    type: 'event_msg', timestamp: new Date(NOW + 20).toISOString(),
    payload: { type: 'turn_aborted', turn_id: 'shared-turn', completed_at: NOW + 20, reason: 'interrupted' },
  };
  state = applyRolloutRecord(state, abortedRecord, { threadId: 'thread-a', nowMs: NOW + 20 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('thread-b', 'shared-turn')]);
  assert.equal(state.pendingErrors[turnKey('thread-a', 'shared-turn')], undefined);
  assert.deepEqual(state.exhaustions, {});
  assert.deepEqual(state.interruptedTurns, {});
  assert.equal(state.terminalTurns.length, 1);
  assert.equal(state.terminalTurns[0].status, 'aborted');

  state.activeTurns[turnKey('thread-a', 'shared-turn')] = {
    threadId: 'thread-a', turnId: 'shared-turn', accountId: 'account-a', state: 'running',
  };
  state.pendingErrors[turnKey('thread-a', 'shared-turn')] = {
    threadId: 'thread-a', turnId: 'shared-turn', usageLimitExceeded: true, willRetry: false,
  };
  state = applyRolloutRecord(state, abortedRecord, { threadId: 'thread-a', nowMs: NOW + 30 });
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey('thread-b', 'shared-turn')]);
  assert.equal(state.pendingErrors[turnKey('thread-a', 'shared-turn')], undefined);
  assert.deepEqual(state.exhaustions, {});
  assert.deepEqual(state.interruptedTurns, {});
  assert.equal(state.terminalTurns.length, 1);
});

test('same turn ID in two threads cannot cross-bind exhaustion or create duplicate failed candidates', () => {
  let state = started(emptyEventState(NOW), 'parent-thread', 'shared-turn');
  state = started(state, 'child-thread', 'shared-turn');
  state = applyProtocolNotification(state, {
    method: 'error',
    params: {
      threadId: 'child-thread', turnId: 'shared-turn', willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded' },
    },
  }, { nowMs: NOW + 10 });
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'parent-thread', turn: {
      id: 'shared-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' },
    } },
  }, { nowMs: NOW + 20 });
  assert.deepEqual(state.exhaustions, {});
  assert.equal(state.activeTurns[turnKey('child-thread', 'shared-turn')].state, 'running');
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'child-thread', turn: {
      id: 'shared-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' },
    } },
  }, { nowMs: NOW + 30 });
  assert.equal(state.exhaustions['account-a'].threadId, 'child-thread');
  assert.deepEqual(state.terminalTurns.map(turn => turn.threadId), ['parent-thread', 'child-thread']);
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'child-thread', turn: {
      id: 'shared-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' },
    } },
  }, { nowMs: NOW + 40 });
  assert.equal(state.terminalTurns.length, 2);
});

test('legacy state cannot carry parent-session identities into a new failover candidate', () => {
  const legacy = emptyEventState(NOW);
  legacy.version = 1;
  legacy.activeTurns['old-turn'] = { threadId: 'parent-thread', turnId: 'old-turn', accountId: 'account-a' };
  legacy.terminalTurns.push({ threadId: 'parent-thread', turnId: 'old-failed', status: 'failed' });
  legacy.exhaustions['account-a'] = { threadId: 'parent-thread', turnId: 'old-failed', verified: true };
  const migrated = started(legacy, 'new-thread', 'new-turn');
  assert.equal(migrated.activeTurns['old-turn'], undefined);
  assert.equal(migrated.activeTurns[turnKey('new-thread', 'new-turn')].threadId, 'new-thread');
  assert.equal(migrated.terminalTurns[0].threadIdentityVerified, false);
  assert.equal(migrated.exhaustions['account-a'].threadIdentityVerified, false);
});

test('version 2 verified main-thread exhaustion migrates to a persistent interrupted candidate', () => {
  const previous = emptyEventState(NOW);
  previous.version = 2;
  previous.exhaustions['account-a'] = {
    accountId: 'account-a', threadId: 'thread-a', turnId: 'turn-a', verified: true,
    observedAtMs: NOW, source: 'rollout-terminal', threadIdentityVerified: true,
  };
  previous.terminalTurns.push({
    accountId: 'account-a', threadId: 'thread-a', turnId: 'turn-a', status: 'failed',
    errorKind: 'usagelimitexceeded', completedAtMs: NOW, parentThreadId: null,
    threadSource: 'user', threadIdentityVerified: true,
  });
  const migrated = started(previous, 'other-thread', 'other-turn');
  assert.equal(migrated.version, 4);
  assert.equal(migrated.interruptedTurns[turnKey('thread-a', 'turn-a')].resumable, true);
  assert.equal(migrated.interruptedTurns[turnKey('thread-a', 'turn-a')].interruptionClass, INTERRUPTION_CLASS.UNKNOWN);
  assert.equal(migrated.interruptedTurns[turnKey('thread-a', 'turn-a')].classificationVerified, false);
});

function rolloutRecord(type, payload = {}) {
  return { type, timestamp: new Date(NOW).toISOString(), payload };
}

function usageFailureSequence({ work = false, input = [{ type: 'text', text: 'Do the task' }] } = {}) {
  const records = [
    rolloutRecord('event_msg', { type: 'task_started', turn_id: 'turn-a' }),
    rolloutRecord('turn_context', { turn_id: 'turn-a' }),
    rolloutRecord('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do the task' }] }),
    rolloutRecord('event_msg', { type: 'item_completed', turn_id: 'turn-a', item: { type: 'UserMessage', content: input } }),
  ];
  if (work) {
    records.push(
      rolloutRecord('event_msg', { type: 'item_completed', turn_id: 'turn-a', item: { type: 'Reasoning', content: [] } }),
      rolloutRecord('event_msg', { type: 'token_usage_record', turn_id: 'turn-a' }),
    );
  }
  records.push(
    rolloutRecord('event_msg', { type: 'token_count' }),
    rolloutRecord('event_msg', {
      type: 'task_complete', turn_id: 'turn-a', error: { codex_error_info: 'usage_limit_exceeded' },
    }),
  );
  return records;
}

test('persisted work items classify a terminal usage failure as interrupted after work', () => {
  const result = classifyRolloutTurn(usageFailureSequence({ work: true }), 'turn-a');
  assert.equal(result.verified, true);
  assert.equal(result.interruptionClass, INTERRUPTION_CLASS.AFTER_WORK);
  assert.deepEqual(result.workItemTypes, ['reasoning']);
  assert.equal(result.originalInput, null);
});

test('the strict no-work rollout envelope classifies a quota preflight rejection', () => {
  const result = classifyRolloutTurn(usageFailureSequence(), 'turn-a');
  assert.equal(result.verified, true);
  assert.equal(result.interruptionClass, INTERRUPTION_CLASS.BEFORE_WORK);
  assert.deepEqual(result.originalInput, [{ type: 'text', text: 'Do the task' }]);
  assert.match(result.originalInputHash, /^[0-9a-f]{64}$/);
});

test('an incomplete or novel no-work sequence remains unknown and fail closed', () => {
  const records = usageFailureSequence();
  records.splice(2, 0, rolloutRecord('event_msg', { type: 'novel_preflight_event' }));
  const result = classifyRolloutTurn(records, 'turn-a');
  assert.equal(result.verified, false);
  assert.equal(result.interruptionClass, INTERRUPTION_CLASS.UNKNOWN);
});

test('observer migration reclassifies an existing candidate only from its retained rollout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-classification-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '23');
  const accounts = path.join(codexHome, 'accounts');
  const cache = path.join(root, 'cache', 'codex-account-switcher');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(accounts, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(accounts, 'registry.json'), JSON.stringify({
    active_account_key: 'key-a',
    accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a' }],
  }));
  const rollout = [
    rolloutRecord('session_meta', { id: 'thread-a' }),
    ...usageFailureSequence(),
  ];
  fs.writeFileSync(path.join(sessions, 'rollout-existing.jsonl'), `${rollout.map(JSON.stringify).join('\n')}\n`);
  const statePath = path.join(cache, 'turn-events.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 3,
    worker: { heartbeatAtMs: NOW },
    files: {}, activeTurns: {}, pendingErrors: {},
    exhaustions: { 'account-a': { verified: true, threadIdentityVerified: true } },
    interruptedTurns: {
      [turnKey('thread-a', 'turn-a')]: {
        threadId: 'thread-a', turnId: 'turn-a', accountId: 'account-a',
        resumable: true, threadIdentityVerified: true,
      },
    },
    terminalTurns: [],
  }));
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-turn-observer'), '--once'], {
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: codexHome,
      CODEX_EVENT_STATE: statePath,
      USAGE_CACHE: path.join(cache, 'usage.json'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(fs.readFileSync(statePath));
  const candidate = migrated.interruptedTurns[turnKey('thread-a', 'turn-a')];
  assert.equal(candidate.interruptionClass, INTERRUPTION_CLASS.BEFORE_WORK);
  assert.equal(candidate.classificationVerified, true);
  assert.equal(candidate.classificationSource, 'historical-rollout');
  assert.deepEqual(candidate.originalInput, [{ type: 'text', text: 'Do the task' }]);
});

test('a later turn on the same thread resolves its interrupted candidate only', () => {
  let state = started(emptyEventState(NOW), 'thread-a', 'failed-turn');
  state = applyProtocolNotification(state, {
    method: 'error',
    params: { threadId: 'thread-a', turnId: 'failed-turn', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded' } },
  }, { nowMs: NOW + 1 });
  state = applyProtocolNotification(state, {
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'failed-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } },
  }, { nowMs: NOW + 2 });
  assert.ok(state.interruptedTurns[turnKey('thread-a', 'failed-turn')]);
  state = started(state, 'thread-a', 'continuation-turn');
  assert.equal(state.interruptedTurns[turnKey('thread-a', 'failed-turn')], undefined);
  assert.ok(state.activeTurns[turnKey('thread-a', 'continuation-turn')]);
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
    CODEX_EVENT_STATE: path.join(cache, 'codex-account-switcher', 'turn-events.json'),
    USAGE_CACHE: path.join(cache, 'codex-account-switcher', 'usage.json'),
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
  assert.equal(state.activeTurns[turnKey('thread-new', 'turn-new')].accountId, 'account-a');

  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-new' }, timestamp: new Date().toISOString(),
  })}\n`);
  result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(fs.statSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')).mode & 0o777, 0o600);
});

test('observer checkpoints turn_aborted terminal state across restart without replaying it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-observer-aborted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '09', '23');
  const registryDirectory = path.join(codexHome, 'accounts');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), JSON.stringify({
    active_account_key: 'key-a',
    accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a' }],
  }));
  const rollout = path.join(sessionDirectory, 'rollout-aborted.jsonl');
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: 'session_meta', payload: { id: 'thread-aborted' }, timestamp: new Date().toISOString(),
  })}\n`);
  const observer = path.join(__dirname, '..', 'bin', 'codex-turn-observer');
  const statePath = path.join(cache, 'codex-account-switcher', 'turn-events.json');
  const environment = {
    ...process.env,
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: cache,
    CODEX_EVENT_STATE: statePath,
    USAGE_CACHE: path.join(cache, 'codex-account-switcher', 'usage.json'),
  };
  const run = () => spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(run().status, 0);

  const startedAt = Date.now();
  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg', timestamp: new Date(startedAt).toISOString(),
    payload: { type: 'task_started', turn_id: 'turn-aborted', started_at: startedAt },
  })}\n`);
  assert.equal(run().status, 0);
  let state = JSON.parse(fs.readFileSync(statePath));
  assert.ok(state.activeTurns[turnKey('thread-aborted', 'turn-aborted')]);

  const completedAt = startedAt + 100;
  fs.appendFileSync(rollout, `${JSON.stringify({
    type: 'event_msg', timestamp: new Date(completedAt).toISOString(),
    payload: {
      type: 'turn_aborted', turn_id: 'turn-aborted', completed_at: completedAt,
      duration_ms: 100, reason: 'interrupted',
    },
  })}\n`);
  assert.equal(run().status, 0);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(state.activeTurns, {});
  assert.deepEqual(state.pendingErrors, {});
  assert.deepEqual(state.exhaustions, {});
  assert.deepEqual(state.interruptedTurns, {});
  assert.equal(state.terminalTurns.length, 1);
  assert.equal(state.terminalTurns[0].status, 'aborted');
  assert.equal(state.terminalTurns[0].completedAtMs, completedAt);
  const checkpointOffset = Object.values(state.files)[0].offset;

  assert.equal(run().status, 0);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(state.terminalTurns.length, 1);
  assert.equal(Object.values(state.files)[0].offset, checkpointOffset);
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
    CODEX_EVENT_STATE: path.join(cache, 'codex-account-switcher', 'turn-events.json'),
    USAGE_CACHE: path.join(cache, 'codex-account-switcher', 'usage.json'),
  };

  let result = spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let state = JSON.parse(fs.readFileSync(path.join(cache, 'codex-account-switcher', 'turn-events.json')));
  assert.deepEqual(state.activeTurns, {});
  assert.equal(Object.values(state.files)[0].threadId, threadId);

  // Reproduce the checkpoint written by the old fixed-size first-line reader:
  // the EOF offset was correct, but the oversized session_meta could not be parsed.
  Object.values(state.files)[0].threadId = null;
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
  assert.equal(state.activeTurns[turnKey(threadId, 'live-turn')].threadId, threadId);
  assert.equal(state.activeTurns[turnKey(threadId, 'live-turn')].accountId, 'account-a');

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

test('observer keeps parent and guardian child rollout identities distinct', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-turn-observer-subagent-'));
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
  const parentId = 'parent-thread';
  const childId = 'guardian-thread';
  const parent = path.join(sessionDirectory, 'rollout-parent.jsonl');
  const child = path.join(sessionDirectory, 'rollout-child.jsonl');
  fs.writeFileSync(parent, `${JSON.stringify({
    type: 'session_meta', payload: { id: parentId, session_id: parentId, thread_source: 'user' },
  })}\n`);
  fs.writeFileSync(child, `${JSON.stringify({
    type: 'session_meta', payload: {
      id: childId, session_id: parentId, parent_thread_id: parentId,
      thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } },
    },
  })}\n`);
  const observer = path.join(__dirname, '..', 'bin', 'codex-turn-observer');
  const environment = {
    ...process.env,
    HOME: root,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: cache,
    CODEX_EVENT_STATE: path.join(cache, 'codex-account-switcher', 'turn-events.json'),
    USAGE_CACHE: path.join(cache, 'codex-account-switcher', 'usage.json'),
  };
  const run = () => spawnSync(process.execPath, [observer, '--once'], { env: environment, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const timestamp = new Date().toISOString();
  const startedRecord = turnId => `${JSON.stringify({
    type: 'event_msg', timestamp,
    payload: { type: 'task_started', turn_id: turnId, started_at: Date.now() },
  })}\n`;
  fs.appendFileSync(parent, startedRecord('parent-turn'));
  fs.appendFileSync(child, startedRecord('guardian-turn'));
  assert.equal(run().status, 0);
  const statePath = path.join(cache, 'codex-account-switcher', 'turn-events.json');
  let state = JSON.parse(fs.readFileSync(statePath));
  assert.equal(state.files[path.relative(codexHome, child)].threadId, childId);
  assert.equal(state.files[path.relative(codexHome, child)].parentThreadId, parentId);
  assert.deepEqual(new Set(Object.values(state.activeTurns).map(turn => turn.threadId)), new Set([parentId, childId]));
  assert.equal(state.activeTurns[turnKey(childId, 'guardian-turn')].accountId, 'account-a');
  assert.equal(state.activeTurns[turnKey(childId, 'guardian-turn')].threadSource, 'guardian_review');

  fs.appendFileSync(child, `${JSON.stringify({
    type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'task_complete', turn_id: 'guardian-turn' },
  })}\n`);
  assert.equal(run().status, 0);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(Object.keys(state.activeTurns), [turnKey(parentId, 'parent-turn')]);
  assert.equal(state.terminalTurns.at(-1).threadId, childId);
  assert.equal(state.terminalTurns.at(-1).parentThreadId, parentId);
  assert.equal(state.terminalTurns.at(-1).threadIdentityVerified, true);
});
