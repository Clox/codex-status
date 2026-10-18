'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAutoContinueState } = require('../lib/codex-auto-continue');
const { desktopPrecommitFailureAction } = require('../lib/codex-desktop-auto');
const { HISTORY_LIMIT, beginDesktopAttemptHistory, updateDesktopAttemptHistory,
  finishHeadlessFallbackHistory } = require('../lib/codex-desktop-attempt-history');

const candidate = { threadId: 'thread-a', turnId: 'failed-turn', accountId: 'source' };
const details = { threadId: candidate.threadId, failedTurnId: candidate.turnId,
  sourceAccountId: 'source', targetAccountId: 'target', desktopPackageVersion: '26.917.71314',
  desktopRootPid: 41, desktopRootStartTicks: 123456 };

test('preflight failure persists across successful HEADLESS fallback and transient reset', () => {
  let state = beginDesktopAttemptHistory({ desktopPreflight: { status: 'waiting' } }, details, 100);
  const id = state.desktopAttemptHistory[0].attemptId;
  state = updateDesktopAttemptHistory(state, id, { phase: 'semantic-readiness',
    errorKind: 'SEND_CONTROL_COUNT_0', outcome: 'fallback-headless',
    rendererPids: [51, 52] }, 200);
  assert.equal(desktopPrecommitFailureAction({ promptInjected: false, anyCommitted: false }),
    'fallback-headless');
  state = normalizeAutoContinueState({ ...state, desktopPreflight: null, status: 'running' });
  state = finishHeadlessFallbackHistory(state, candidate,
    { turnId: 'continued-turn', status: 'completed' });
  assert.deepEqual(state.desktopAttemptHistory[0], {
    attemptId: id, startedAtMs: 100, threadId: 'thread-a', failedTurnId: 'failed-turn',
    sourceAccountId: 'source', targetAccountId: 'target',
    desktopPackage: 'chatgpt', desktopPackageVersion: '26.917.71314', desktopRootPid: 41,
    desktopRootStartTicks: 123456, rendererPids: [51, 52],
    phase: 'semantic-readiness', errorKind: 'SEND_CONTROL_COUNT_0',
    prefillStarted: false, promptInjected: false, sendAttemptCommitted: false,
    outcome: 'fallback-headless', finishedAtMs: 200,
    headlessContinuationTurnId: 'continued-turn', headlessTerminalStatus: 'completed',
  });
});

test('prefill and SEND commit failures remain fail-closed and classified', () => {
  for (const committed of [false, true]) {
    let state = beginDesktopAttemptHistory({}, details, 100);
    const id = state.desktopAttemptHistory[0].attemptId;
    state = updateDesktopAttemptHistory(state, id, { phase: committed ? 'send-commit' : 'prefill',
      prefillStarted: true, promptInjected: true, sendAttemptCommitted: committed });
    assert.equal(desktopPrecommitFailureAction({ promptInjected: true, anyCommitted: committed }),
      'fail-closed');
    state = updateDesktopAttemptHistory(state, id, { errorKind: 'DESKTOP_SEND_CONFLICT',
      outcome: committed ? 'send-conflict' : 'blocked/failed' });
    state = finishHeadlessFallbackHistory(state, candidate,
      { turnId: 'must-not-attach', status: 'completed' });
    assert.equal(state.desktopAttemptHistory[0].outcome,
      committed ? 'send-conflict' : 'blocked/failed');
    assert.equal(state.desktopAttemptHistory[0].prefillStarted, true);
    assert.equal(state.desktopAttemptHistory[0].promptInjected, true);
    assert.equal(state.desktopAttemptHistory[0].sendAttemptCommitted, committed);
    assert.equal(state.desktopAttemptHistory[0].headlessContinuationTurnId, null);
  }
});

test('later Desktop attempt appends a distinct entry and history stays bounded', () => {
  let state = beginDesktopAttemptHistory({}, details, 1);
  const firstId = state.desktopAttemptHistory[0].attemptId;
  state = updateDesktopAttemptHistory(state, firstId, {
    errorKind: 'DESKTOP_PREFLIGHT_FAILED', outcome: 'fallback-headless' });
  state = beginDesktopAttemptHistory(state, details, 2);
  assert.equal(state.desktopAttemptHistory.length, 2);
  assert.notEqual(state.desktopAttemptHistory[1].attemptId, firstId);
  assert.equal(state.desktopAttemptHistory[0].errorKind, 'DESKTOP_PREFLIGHT_FAILED');
  for (let i = 0; i < HISTORY_LIMIT + 2; i += 1) {
    state = beginDesktopAttemptHistory(state, { ...details, threadId: `thread-${i}` }, i + 3);
  }
  assert.equal(state.desktopAttemptHistory.length, HISTORY_LIMIT);
  assert.equal(state.desktopAttemptHistory.at(-1).threadId, `thread-${HISTORY_LIMIT + 1}`);
});

test('history accepts only credential-free fields and never serializes prompts or raw diagnostics', () => {
  const secret = 'SUPER_SECRET_PROMPT_AND_TOKEN';
  let state = beginDesktopAttemptHistory({}, { ...details, prompt: secret,
    credentials: secret, desktopPackageVersion: secret });
  const id = state.desktopAttemptHistory[0].attemptId;
  state = updateDesktopAttemptHistory(state, id, { phase: secret, errorKind: secret,
    prompt: secret, diagnostics: { auth: secret }, rendererPids: [55, secret] });
  assert.doesNotMatch(JSON.stringify(state.desktopAttemptHistory), /SUPER_SECRET/);
  assert.equal(state.desktopAttemptHistory[0].errorKind, null);
  assert.deepEqual(state.desktopAttemptHistory[0].rendererPids, [55]);
});
