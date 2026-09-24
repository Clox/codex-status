'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appServerExclusivityReport,
  candidateKey,
  currentResumeProblemLines,
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  pendingInterruptedTurns,
  resumeProtocolRequests,
  desktopRestoreLaunchSpec,
  restoreDesktopWithRetry,
  splitJsonLines,
  validateThreadMetadataForResume,
  validateThreadForResume,
} = require('../lib/codex-manual-resume');
const { INTERRUPTION_CLASS, continuationForCandidate } = require('../lib/codex-turn-continuation');

test('status problems omit stale pre-commit failures but retain uncertain post-commit failures', () => {
  assert.deepEqual(currentResumeProblemLines({
    version: 1,
    attempts: {},
    lastError: {
      actionRequired: true,
      errorKind: 'VSCODE_EXTENSION_HOST_UNVERIFIED',
      failedAtMs: 100,
    },
  }), []);
  assert.deepEqual(currentResumeProblemLines({
    version: 1,
    attempts: {
      committed: {
        status: 'MANUAL_REQUIRED_AFTER_COMMIT',
        threadId: 'thread-abcdefgh',
        errorKind: 'APP_SERVER_TIMEOUT',
      },
    },
  }), [
    'MANUAL RESUME / ACTION REQUIRED: …abcdefgh was committed; no automatic retry (APP_SERVER_TIMEOUT).',
  ]);
});

const candidate = {
  threadId: 'thread-a', turnId: 'turn-failed', accountId: 'account-a',
  status: 'failed', errorKind: 'usagelimitexceeded', resumable: true,
  threadIdentityVerified: true, completedAtMs: 100,
  interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
};

function verifiedEventState(value = candidate) {
  return {
    activeTurns: {},
    interruptedTurns: { [candidateKey(value.threadId, value.turnId)]: value },
  };
}

function commitDetails(value = candidate) {
  return { targetAccountId: 'account-b', continuation: continuationForCandidate(value) };
}

function thread(turns = [{
  id: 'turn-failed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, items: [],
}]) {
  return { id: 'thread-a', status: { type: 'idle' }, turns };
}

test('only verified main-thread candidates without a commit are listed', () => {
  const eventState = { interruptedTurns: {
    [candidateKey(candidate.threadId, candidate.turnId)]: candidate,
    child: { ...candidate, threadId: 'child', parentThreadId: 'thread-a' },
  } };
  assert.deepEqual(pendingInterruptedTurns(eventState).map(item => item.threadId), ['thread-a']);
  const committed = markResumeCommitted(emptyResumeState(), candidate, commitDetails(), 200);
  assert.deepEqual(pendingInterruptedTurns(eventState, committed), []);
});

test('resume revalidation requires idle exact thread and latest verified failed turn', () => {
  const eventState = verifiedEventState();
  assert.equal(validateThreadForResume({ candidate, thread: thread(), eventState, resumeState: emptyResumeState() }), true);
  assert.throws(() => validateThreadForResume({
    candidate, thread: thread([...thread().turns, { id: 'later', status: 'completed', items: [] }]),
    eventState, resumeState: emptyResumeState(),
  }), /CANDIDATE_NOT_LATEST_TURN/);
  assert.throws(() => validateThreadForResume({
    candidate, thread: { ...thread(), status: { type: 'active', activeFlags: [] } },
    eventState, resumeState: emptyResumeState(),
  }), /THREAD_NOT_IDLE/);
});

test('metadata validation can safely precede resume without claiming latest-turn verification', () => {
  assert.equal(validateThreadMetadataForResume({
    candidate,
    thread: { id: 'thread-a', status: { type: 'notLoaded' }, turns: [] },
    eventState: verifiedEventState(),
    resumeState: emptyResumeState(),
  }), true);
  assert.throws(() => validateThreadForResume({
    candidate,
    thread: { id: 'thread-a', status: { type: 'notLoaded' }, turns: [] },
    eventState: verifiedEventState(),
    resumeState: emptyResumeState(),
  }), /CANDIDATE_NOT_LATEST_TURN/);
});

test('commit is crash-safe idempotency boundary and can never be committed twice', () => {
  const committed = markResumeCommitted(emptyResumeState(), candidate, commitDetails(), 200);
  const attempt = committed.attempts[candidateKey('thread-a', 'turn-failed')];
  assert.equal(attempt.status, 'RESUME_COMMITTED');
  assert.equal(attempt.interruptionClass, INTERRUPTION_CLASS.AFTER_WORK);
  assert.match(attempt.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(attempt.continuationKind, 'continue-after-work');
  assert.throws(() => markResumeCommitted(committed, candidate, commitDetails()), /RESUME_ALREADY_COMMITTED/);
  const failed = markResumeFailure(committed, candidate, 'OUTCOME_UNKNOWN', { committed: true }, 300);
  assert.equal(failed.attempts[candidateKey('thread-a', 'turn-failed')].status, 'MANUAL_REQUIRED_AFTER_COMMIT');
  assert.throws(() => validateThreadForResume({ candidate, thread: thread(), eventState: verifiedEventState(), resumeState: failed }), /RESUME_ALREADY_COMMITTED/);
});

test('resume revalidation fails when persisted classification or input hash changes', () => {
  const changed = { ...candidate, interruptionClass: INTERRUPTION_CLASS.UNKNOWN, classificationVerified: false };
  assert.throws(() => validateThreadMetadataForResume({
    candidate,
    thread: { id: 'thread-a', status: { type: 'idle' } },
    eventState: verifiedEventState(changed),
    resumeState: emptyResumeState(),
  }), /CANDIDATE_EVIDENCE_CHANGED/);
});

test('terminal result is recorded against the one committed continuation', () => {
  const committed = markResumeCommitted(emptyResumeState(), candidate, commitDetails(), 200);
  const terminal = markResumeTerminal(committed, candidate, { turnId: 'turn-next', status: 'completed' }, 400);
  const attempt = terminal.attempts[candidateKey('thread-a', 'turn-failed')];
  assert.equal(attempt.continuationTurnId, 'turn-next');
  assert.equal(attempt.status, 'COMPLETED');
});

test('exclusivity allows only quiescent VS Code App Servers and reports concrete blockers', () => {
  const vscodeExecutable = '/home/test/.vscode/extensions/openai.chatgpt-1.2.3-linux-x64/bin/linux-x86_64/codex';
  const report = appServerExclusivityReport([
    { pid: 10, ppid: 1, state: 'T', args: [vscodeExecutable, 'app-server'] },
    { pid: 20, ppid: 2, state: 'S', args: ['/usr/lib/chatgpt/resources/codex', 'app-server'] },
    { pid: 30, ppid: 3, state: 'S', args: [vscodeExecutable, 'app-server'] },
    { pid: 40, ppid: 4, state: 'S', args: ['/opt/other/codex', 'app-server'] },
  ], { desktopPids: [20] });
  assert.equal(report.exclusive, false);
  assert.deepEqual(report.blockers, [
    { pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' },
    { pid: 30, ppid: 3, state: 'S', role: 'vscode-app-server-not-quiescent' },
    { pid: 40, ppid: 4, state: 'S', role: 'other-app-server' },
  ]);
  assert.equal(appServerExclusivityReport([
    { pid: 10, ppid: 1, state: 'T', args: [vscodeExecutable, 'app-server'] },
  ]).exclusive, true);
});

test('pre-commit exclusivity diagnostics do not consume or hide the retry-safe candidate', () => {
  const diagnostics = {
    blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }],
  };
  const failed = markResumeFailure(
    emptyResumeState(), candidate, 'APP_SERVER_EXCLUSIVITY_FAILED', { diagnostics }, 500,
  );
  assert.deepEqual(failed.attempts, {});
  assert.deepEqual(failed.lastError.diagnostics, diagnostics);
  const eventState = { interruptedTurns: { [candidateKey(candidate.threadId, candidate.turnId)]: candidate } };
  assert.deepEqual(pendingInterruptedTurns(eventState, failed).map(item => item.threadId), ['thread-a']);
});

test('resume protocol uses paginated latest-turn validation and excludes full history', () => {
  assert.deepEqual(resumeProtocolRequests('thread-a'), {
    read: { threadId: 'thread-a', includeTurns: false },
    latestTurn: {
      threadId: 'thread-a', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    },
    resume: { threadId: 'thread-a', excludeTurns: true },
  });
});

test('line decoder consumes many complete frames before enforcing the partial-frame limit', () => {
  const decoded = splitJsonLines('', '{"id":1}\n{"id":2}\npartial', 12);
  assert.deepEqual(decoded.lines, ['{"id":1}', '{"id":2}']);
  assert.equal(decoded.remaining, 'partial');
  assert.throws(
    () => splitJsonLines('', 'this-single-frame-is-too-large', 12),
    error => error.message === 'APP_SERVER_PROTOCOL_OVERFLOW' &&
      error.diagnostics.bufferedBytes === 30 && error.diagnostics.terminated === false,
  );
  assert.throws(
    () => splitJsonLines('', 'this-complete-frame-is-too-large\n', 12),
    error => error.message === 'APP_SERVER_PROTOCOL_OVERFLOW' &&
      error.diagnostics.frameBytes === 32 && error.diagnostics.terminated === true,
  );
});

test('Desktop restore retries a startup that crashes after the former three-second check', async () => {
  let pid = null;
  let launches = 0;
  let pollsThisAttempt = 0;
  const sleeps = [];
  const result = await restoreDesktopWithRetry({
    runningPids: () => pid == null ? [] : [pid],
    launch: () => {
      launches += 1;
      pollsThisAttempt = 0;
      pid = 100 + launches;
      return { pid: 200 + launches };
    },
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      if (milliseconds === 500) pollsThisAttempt += 1;
      if (launches === 1 && pollsThisAttempt >= 8) pid = null;
    },
    stableMs: 10_000,
    pollMs: 500,
    retryDelayMs: 1_000,
  });
  assert.equal(result.launched, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.desktopPid, 102);
  assert.equal(result.history[0].result, 'exited-before-ready');
  assert.equal(result.history[1].result, 'ready');
  assert.equal(launches, 2);
});

test('Desktop restore reports failure after bounded retries without touching resume state', async () => {
  let launches = 0;
  let capturedError = null;
  await assert.rejects(() => restoreDesktopWithRetry({
    runningPids: () => [],
    launch: () => { launches += 1; return { pid: 300 + launches }; },
    sleep: async () => {},
    startupTimeoutMs: 500,
    pollMs: 250,
  }), error => {
    capturedError = error;
    return error?.message === 'DESKTOP_RESTORE_FAILED';
  });
  assert.equal(launches, 2);
  assert.equal(capturedError.diagnostics.attempts.length, 2);
  assert.ok(capturedError.diagnostics.attempts.every(attempt => attempt.result === 'startup-timeout'));
});

test('Desktop restore launch uses a transient user service instead of controller ownership', () => {
  const spec = desktopRestoreLaunchSpec({
    systemdRunBin: '/usr/bin/systemd-run',
    desktopLauncher: '/usr/bin/chatgpt',
    controllerPid: 1234,
    attempt: 2,
  });
  assert.equal(spec.command, '/usr/bin/systemd-run');
  assert.deepEqual(spec.args, [
    '--user',
    '--quiet',
    '--collect',
    '--unit=codex-desktop-restore-1234-2',
    '--',
    '/usr/bin/chatgpt',
  ]);
});
