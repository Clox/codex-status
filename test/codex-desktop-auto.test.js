'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  committedDesktopAttempts,
  desktopPlan,
  desktopPreflightFallbackRecord,
  desktopPrecommitFailureAction,
  desktopQueueMayContinue,
  markDesktopSendCommitted,
  markDesktopSendInvoked,
  markDesktopPrefillStarted,
  reconcileDesktopSend,
  waitForDesktopReadiness,
} = require('../lib/codex-desktop-auto');
const { candidateKey, pendingInterruptedTurns } = require('../lib/codex-manual-resume');
const { INTERRUPTION_CLASS, inputHash } = require('../lib/codex-turn-continuation');

const NOW = 1_790_300_000_000;
const target = { accountId: 'account-b', accountKey: 'key-b' };
const capability = {
  verified: true,
  desktopIdentity: { processId: 10 },
  rendererIdentity: { processId: 11 },
  atspiIdentity: { object: '/send/1' },
};

test('AT-SPI helper protocol can start and close without touching Desktop', () => {
  const helper = path.join(__dirname, '..', 'bin', 'codex-desktop-atspi');
  const result = spawnSync(helper, [], { input: '{"command":"close"}\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: true });
});

test('AT-SPI helper binds roots to the verified Desktop PID and diagnoses missing renderer trees', () => {
  const helper = path.join(__dirname, '..', 'bin', 'codex-desktop-atspi');
  const source = String.raw`
import importlib.machinery
import importlib.util

loader = importlib.machinery.SourceFileLoader('codex_desktop_atspi', ${JSON.stringify(helper)})
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

class Node:
    def __init__(self, pid=None, role='application', name='', children=None):
        self.pid = pid
        self.role = role
        self.name = name
        self._children = children or []
        self.childCount = len(self._children)
    def get_process_id(self): return self.pid
    def getRoleName(self): return self.role
    def getChildAtIndex(self, index): return self._children[index]

good = Node(41, 'application', 'Codex', [Node(41, 'frame', 'ChatGPT', [Node(42, 'panel', 'content')])])
wrong = Node(99, 'application', 'ChatGPT')
assert module.unique_root(41, [wrong, good]) is good

for pid, apps, expected in [
    (42, [good], 'DESKTOP_ATSPI_PID_ROOT_COUNT_0'),
    (41, [good, Node(41, 'application', 'Codex')], 'DESKTOP_ATSPI_PID_ROOT_COUNT_2'),
]:
    try:
        module.unique_root(pid, apps)
        raise AssertionError('expected failure')
    except module.CapabilityError as error:
        assert str(error) == expected

shell_only = Node(41, 'application', 'Codex', [Node(41, 'frame', 'ChatGPT', [Node(None, 'unknown', '')])])
try:
    module.require_renderer_tree(shell_only)
    raise AssertionError('expected renderer failure')
except module.CapabilityError as error:
    assert str(error) == 'DESKTOP_ATSPI_RENDERER_TREE_MISSING'

module.require_renderer_tree(good)
`;
  const result = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function candidate(overrides = {}) {
  return {
    threadId: 'thread-a', turnId: 'failed-a', accountId: 'account-a',
    resumable: true, threadIdentityVerified: true,
    interruptionClass: INTERRUPTION_CLASS.AFTER_WORK,
    classificationVerified: true,
    completedAtMs: NOW - 1_000,
    ...overrides,
  };
}

function eventState(candidates = [candidate()], turns = []) {
  return {
    worker: { heartbeatAtMs: NOW, errorKind: null },
    activeTurns: Object.fromEntries(turns.filter(turn => turn.status === 'running')
      .map(turn => [candidateKey(turn.threadId, turn.turnId), turn])),
    terminalTurns: turns.filter(turn => turn.status !== 'running'),
    interruptedTurns: Object.fromEntries(candidates.map(item => [candidateKey(item.threadId, item.turnId), item])),
  };
}

function commit(item = candidate(), state = {}) {
  const plan = desktopPlan(item, target);
  return {
    plan,
    state: markDesktopSendCommitted(state, item, plan, capability, eventState([item]), NOW),
  };
}

test('DESKTOP happy path commits before one claimed action and confirms exact observed input', () => {
  const item = candidate();
  const committed = commit(item);
  let state = markDesktopSendInvoked(committed.state, item, NOW + 1);
  assert.throws(() => markDesktopSendInvoked(state, item, NOW + 2), /DESKTOP_SEND_ALREADY_INVOKED/);
  const turn = {
    threadId: item.threadId, turnId: 'continued-a', accountId: target.accountId,
    startedAtMs: NOW + 10, status: 'running', parentThreadId: null,
    originalInputHash: committed.plan.inputHash,
  };
  const result = reconcileDesktopSend(state, item, eventState([item], [turn]), NOW + 20);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.state.attempts[candidateKey(item.threadId, item.turnId)].status, 'SEND_CONFIRMED');
  assert.equal(result.state.attempts[candidateKey(item.threadId, item.turnId)].continuationTurnId, 'continued-a');
});

test('a crash before commit leaves no barrier while a crash after commit is reconciliation-only', () => {
  const item = candidate();
  assert.deepEqual(pendingInterruptedTurns(eventState([item]), {}).map(value => value.turnId), ['failed-a']);
  const committed = commit(item).state;
  assert.deepEqual(pendingInterruptedTurns(eventState([item]), committed), []);
  assert.equal(committedDesktopAttempts(committed).length, 1);
  assert.throws(() => commit(item, committed), /DESKTOP_SEND_ALREADY_COMMITTED/);
});

test('once real prefill begins, crash recovery blocks retry and headless fallback until manual cleanup', () => {
  const item = candidate();
  const plan = desktopPlan(item, target);
  const claimed = markDesktopPrefillStarted({}, item, plan, NOW);
  assert.equal(claimed.attempts[candidateKey(item.threadId, item.turnId)].status, 'PREFILL_STARTED');
  assert.deepEqual(pendingInterruptedTurns(eventState([item]), claimed), []);
  assert.throws(() => markDesktopPrefillStarted(claimed, item, plan, NOW + 1),
    /DESKTOP_PREFILL_ALREADY_CLAIMED/);
  const committed = markDesktopSendCommitted(claimed, item, plan, capability, eventState([item]), NOW + 2);
  assert.equal(committed.attempts[candidateKey(item.threadId, item.turnId)].status, 'SEND_ATTEMPT_COMMITTED');
});

test('committed attempt becomes SEND_UNCONFIRMED without retry after timeout', () => {
  const item = candidate();
  const committed = commit(item).state;
  const pending = reconcileDesktopSend(committed, item, eventState([item]), NOW + 10);
  assert.equal(pending.outcome, 'pending');
  const result = reconcileDesktopSend(committed, item, eventState([item]), NOW + 30_001);
  assert.equal(result.outcome, 'unconfirmed');
  assert.equal(result.state.attempts[candidateKey(item.threadId, item.turnId)].status, 'SEND_UNCONFIRMED');
  assert.equal(committedDesktopAttempts(result.state).length, 0);
});

test('wrong account, input, or multiple new turns becomes SEND_CONFLICT', () => {
  const item = candidate();
  const { state, plan } = commit(item);
  const wrong = {
    threadId: item.threadId, turnId: 'unexpected', accountId: 'account-c',
    startedAtMs: NOW + 1, status: 'running', originalInputHash: plan.inputHash,
  };
  const result = reconcileDesktopSend(state, item, eventState([item], [wrong]), NOW + 2);
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.state.attempts[candidateKey(item.threadId, item.turnId)].status, 'SEND_CONFLICT');
});

test('a later quota interruption with a new turn ID is a distinct eligible plan', () => {
  const first = candidate();
  const firstState = commit(first).state;
  const later = candidate({ turnId: 'failed-later', completedAtMs: NOW + 10_000 });
  const pending = pendingInterruptedTurns(eventState([first, later]), firstState);
  assert.deepEqual(pending.map(item => item.turnId), ['failed-later']);
  assert.notEqual(desktopPlan(first, target).fingerprint, desktopPlan(later, target).fingerprint);
});

test('multiple interrupted threads have independent oldest-first barriers and confirmations', () => {
  const first = candidate({ threadId: 'thread-a', turnId: 'failed-a', completedAtMs: NOW - 2_000 });
  const second = candidate({ threadId: 'thread-b', turnId: 'failed-b', completedAtMs: NOW - 1_000 });
  let state = {};
  const firstCommit = commit(first, state);
  state = firstCommit.state;
  const firstTurn = {
    threadId: first.threadId, turnId: 'continued-a', accountId: target.accountId,
    startedAtMs: NOW + 1, status: 'running', originalInputHash: firstCommit.plan.inputHash,
  };
  state = reconcileDesktopSend(state, first, eventState([first, second], [firstTurn]), NOW + 2).state;
  const secondCommit = commit(second, state);
  state = secondCommit.state;
  const secondTurn = {
    threadId: second.threadId, turnId: 'continued-b', accountId: target.accountId,
    startedAtMs: NOW + 3, status: 'running', originalInputHash: secondCommit.plan.inputHash,
  };
  state = reconcileDesktopSend(state, second, eventState([second], [firstTurn, secondTurn]), NOW + 4).state;
  assert.equal(state.attempts[candidateKey(first.threadId, first.turnId)].status, 'SEND_CONFIRMED');
  assert.equal(state.attempts[candidateKey(second.threadId, second.turnId)].status, 'SEND_CONFIRMED');
});

test('BEFORE_WORK requires exact text-only Desktop reconstruction', () => {
  const text = [{ type: 'text', text: 'original prompt' }];
  const exact = candidate({
    interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK,
    originalInput: text,
    originalInputHash: inputHash(text),
  });
  assert.equal(desktopPlan(exact, target).prompt, 'original prompt');
  const structured = [{ type: 'image', url: 'https://example.test/image.png' }];
  const unsupported = candidate({
    interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK,
    originalInput: structured,
    originalInputHash: inputHash(structured),
  });
  assert.throws(() => desktopPlan(unsupported, target), error =>
    error.message === 'desktop-input-not-lossless' && error.safeHeadlessFallback === true);
});

test('safe HEADLESS fallback ends at prefill and capability failure mid-queue fails closed', () => {
  assert.equal(desktopPrecommitFailureAction({ candidateIndex: 0 }), 'fallback-headless');
  assert.equal(desktopPrecommitFailureAction({ candidateIndex: 0, promptInjected: true }), 'fail-closed');
  assert.equal(desktopPrecommitFailureAction({ candidateIndex: 1, anyCommitted: true }), 'fail-closed');
});

test('semantic Desktop readiness retries read-only snapshots until the view is stable', async () => {
  let clock = NOW;
  let attempts = 0;
  const observations = [];
  const result = await waitForDesktopReadiness({
    attempt: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('CHAT_ACTIONS_COUNT_0');
      if (attempts === 2) throw new Error('COMPOSER_COUNT_0');
      return capability;
    },
    onObservation: value => observations.push(value),
    sleep: async milliseconds => { clock += milliseconds; },
    now: () => clock,
    timeoutMs: 2_000,
    backoffMs: [100],
  });
  assert.equal(result.capability, capability);
  assert.equal(result.diagnostics.status, 'ready');
  assert.equal(result.diagnostics.attempts, 3);
  assert.equal(result.diagnostics.lastErrorKind, 'COMPOSER_COUNT_0');
  assert.deepEqual(observations.map(value => value.status), ['waiting', 'waiting', 'ready']);
});

test('permanent semantic preflight failure times out with exact credential-free diagnostics', async () => {
  let clock = NOW;
  const observations = [];
  await assert.rejects(waitForDesktopReadiness({
    attempt: async () => { throw new Error('SEND_CONTROL_COUNT_0'); },
    onObservation: value => observations.push(value),
    sleep: async milliseconds => { clock += milliseconds; },
    now: () => clock,
    timeoutMs: 250,
    backoffMs: [100],
  }), error => {
    assert.equal(error.message, 'SEND_CONTROL_COUNT_0');
    assert.equal(error.desktopPreflight.status, 'failed');
    assert.equal(error.desktopPreflight.lastErrorKind, 'SEND_CONTROL_COUNT_0');
    assert.equal(error.desktopPreflight.attempts, 4);
    return true;
  });
  assert.equal(observations.at(-1).status, 'failed');
  assert.equal(desktopPrecommitFailureAction({ candidateIndex: 0 }), 'fallback-headless');
});

test('safe fallback persists the representative failure and exact plan identity', () => {
  const error = new Error('CHAT_ACTIONS_COUNT_0');
  error.desktopPreflight = {
    phase: 'semantic-readiness', status: 'failed', startedAtMs: NOW - 500,
    completedAtMs: NOW, attempts: 3, lastErrorKind: 'CHAT_ACTIONS_COUNT_0',
  };
  const record = desktopPreflightFallbackRecord({ observedAtMs: NOW - 250 }, error, {
    threadId: 'thread-a', failedTurnId: 'failed-a', targetAccountId: 'account-b', desktopRootPid: 41,
  }, NOW + 1);
  assert.equal(record.status, 'fallback-headless');
  assert.equal(record.phase, 'semantic-readiness');
  assert.equal(record.lastErrorKind, 'CHAT_ACTIONS_COUNT_0');
  assert.equal(record.attempts, 3);
  assert.equal(record.threadId, 'thread-a');
  assert.equal(record.failedTurnId, 'failed-a');
  assert.equal(record.targetAccountId, 'account-b');
  assert.equal(record.desktopRootPid, 41);
});

test('unexpected preflight exception text is not persisted as credential-bearing diagnostics', async () => {
  let clock = NOW;
  await assert.rejects(waitForDesktopReadiness({
    attempt: async () => { throw new Error('token=do-not-persist'); },
    sleep: async milliseconds => { clock += milliseconds; },
    now: () => clock,
    timeoutMs: 0,
    backoffMs: [1],
  }), error => error.message === 'DESKTOP_PREFLIGHT_FAILED' &&
    error.desktopPreflight.lastErrorKind === 'DESKTOP_PREFLIGHT_FAILED');
});

test('plan-specific unconfirmed may continue only while capability remains reliable', () => {
  assert.equal(desktopQueueMayContinue({ outcome: 'confirmed', capabilityReliable: false }), true);
  assert.equal(desktopQueueMayContinue({ outcome: 'unconfirmed', capabilityReliable: true }), true);
  assert.equal(desktopQueueMayContinue({ outcome: 'unconfirmed', capabilityReliable: false }), false);
  assert.equal(desktopQueueMayContinue({ outcome: 'conflict', capabilityReliable: true }), false);
});
