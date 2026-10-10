'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appServerExclusivityReport,
  captureDesktopLineage,
  isDesktopRootProcess,
  isDesktopRestoreError,
  appServerDrainDecision,
  candidateKey,
  currentResumeProblemLines,
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  pendingInterruptedTurns,
  pollAppServerExclusivity,
  resumeProtocolRequests,
  desktopDeepLinkLaunchSpec,
  desktopRestoreLaunchSpec,
  desktopThreadLink,
  headlessPostRestoreNavigationPlan,
  runHeadlessPostRestoreNavigation,
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

test('Desktop App Server drain waits boundedly and succeeds immediately when exclusive', () => {
  const desktopBlock = {
    exclusive: false,
    blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }],
  };
  assert.equal(appServerDrainDecision(desktopBlock, 5_001, 15_000), 'wait');
  assert.equal(appServerDrainDecision(desktopBlock, 14_999, 15_000), 'wait');
  assert.equal(appServerDrainDecision(desktopBlock, 15_000, 15_000), 'fail');
  assert.equal(appServerDrainDecision({ exclusive: true, blockers: [] }, 5_100, 15_000), 'exclusive');
});

test('Desktop descendant identity survives root exit and drains boundedly', async () => {
  const root = { pid: 10, ppid: 1, startTicks: 100, state: 'S', args: ['/usr/lib/chatgpt/ChatGPT'] };
  const child = { pid: 20, ppid: 10, startTicks: 200, state: 'S', args: ['/usr/lib/chatgpt/resources/codex', 'app-server'] };
  let lineage = captureDesktopLineage([root, child], [10]);
  assert.deepEqual(lineage, [{ pid: 10, startTicks: 100 }, { pid: 20, startTicks: 200 }]);
  const orphan = { ...child, ppid: 1 };
  lineage = captureDesktopLineage([orphan], [], lineage);
  assert.deepEqual(lineage, [{ pid: 20, startTicks: 200 }]);
  let reads = 0;
  let elapsed = 0;
  const result = await pollAppServerExclusivity({
    readReport: () => appServerExclusivityReport(reads++ < 2 ? [orphan] : [], { desktopLineage: lineage }),
    sleep: async delay => { elapsed += delay; }, now: () => elapsed, pollMs: 100,
  });
  assert.equal(result.outcome, 'exclusive');
  assert.equal(result.elapsedMs, 200);
});

test('foreign and PID-reused App Servers remain strict blockers', () => {
  const lineage = [{ pid: 20, startTicks: 200 }];
  for (const server of [
    { pid: 30, ppid: 1, startTicks: 300, state: 'S', args: ['/opt/codex', 'app-server'] },
    { pid: 20, ppid: 1, startTicks: 201, state: 'S', args: ['/opt/codex', 'app-server'] },
  ]) {
    const report = appServerExclusivityReport([server], { desktopLineage: lineage });
    assert.equal(report.blockers[0].role, 'other-app-server');
    assert.equal(appServerDrainDecision(report, 0), 'fail');
  }
});

test('slow normal Desktop App Server drain self-heals without a fixed remaining wait', async () => {
  let nowMs = 0;
  let reads = 0;
  const desktopBlock = {
    exclusive: false,
    blockers: [{ pid: 20, ppid: 2, state: 'S', role: 'desktop-app-server' }],
  };
  const reports = [desktopBlock, desktopBlock, { exclusive: true, blockers: [] }];
  const result = await pollAppServerExclusivity({
    readReport: () => reports[Math.min(reads++, reports.length - 1)],
    sleep: async delay => { nowMs += delay; },
    now: () => nowMs,
    timeoutMs: 15_000,
    pollMs: 100,
  });
  assert.equal(result.outcome, 'exclusive');
  assert.equal(result.elapsedMs, 200);
  assert.equal(reads, 3);
});

test('strict blocker fails immediately without polling', async () => {
  let sleeps = 0;
  const result = await pollAppServerExclusivity({
    readReport: () => ({
      exclusive: false,
      blockers: [{ pid: 30, ppid: 3, state: 'S', role: 'other-app-server' }],
    }),
    sleep: async () => { sleeps += 1; },
    now: () => 0,
  });
  assert.equal(result.outcome, 'fail');
  assert.equal(sleeps, 0);
});

test('foreign, VS Code and ambiguous App Servers fail strict without a drain wait', () => {
  for (const role of ['other-app-server', 'vscode-app-server-not-quiescent', 'unknown-app-server']) {
    assert.equal(appServerDrainDecision({
      exclusive: false,
      blockers: [{ pid: 30, ppid: 3, state: 'S', role }],
    }, 0, 15_000), 'fail');
  }
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
    readRoots: () => pid == null ? [] : [{ pid, startTicks: 1_000 + pid }],
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
    readRoots: () => [],
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

test('restore rediscovers the stable Electron single-instance root after an initial discovery miss', async () => {
  let launches = 0;
  let observed = false;
  const root = { pid: 4901, startTicks: 812345, cgroup: '/user.slice/codex-desktop-restore-900-1.service' };
  const result = await restoreDesktopWithRetry({
    readRoots: () => observed ? [root] : [],
    launch: () => {
      launches += 1;
      if (launches === 2) observed = true; // Electron forwarded to the first instance.
      return { pid: 6000 + launches, unit: `codex-desktop-restore-900-${launches}.service` };
    },
    sleep: async () => {},
    startupTimeoutMs: 2,
    stableMs: 2,
    pollMs: 1,
    retryDelayMs: 1,
  });
  assert.equal(launches, 2);
  assert.equal(result.desktopPid, root.pid);
  assert.equal(result.desktopStartTicks, root.startTicks);
  assert.equal(result.desktopCgroup, root.cgroup);
  assert.equal(result.history[0].result, 'startup-timeout');
  assert.equal(result.history[1].result, 'ready');

  const entries = [
    { ...root, ppid: 1, state: 'S', args: ['/usr/lib/chatgpt/ChatGPT'] },
    { pid: 4902, ppid: 1, startTicks: 812346, cgroup: root.cgroup,
      state: 'S', args: ['/usr/bin/codex', 'app-server'] },
    { pid: 4903, ppid: 1, startTicks: 812347, cgroup: '/user.slice/foreign.service',
      state: 'S', args: ['/usr/bin/codex', 'app-server'] },
  ];
  const lineage = captureDesktopLineage(entries, [root.pid]);
  const report = appServerExclusivityReport(entries, { desktopLineage: lineage });
  assert.equal(report.blockers.find(item => item.pid === 4902).role, 'desktop-app-server');
  assert.equal(report.blockers.find(item => item.pid === 4903).role, 'other-app-server');
});

test('Desktop root discovery uses executable identity and excludes renderer and zombie processes', () => {
  const binary = '/usr/lib/chatgpt/ChatGPT';
  assert.equal(isDesktopRootProcess({ exe: binary, args: ['chatgpt'], state: 'S' }, binary), true);
  assert.equal(isDesktopRootProcess({ exe: binary, args: [binary, '--type=renderer'], state: 'S' }, binary), false);
  assert.equal(isDesktopRootProcess({ exe: binary,
    args: [`${binary} --type=renderer --crashpad-handler-pid=123`], state: 'S' }, binary), false);
  assert.equal(isDesktopRootProcess({ exe: binary,
    args: [`${binary} --type=utility --utility-sub-type=node.mojom.NodeService`], state: 'S' }, binary), false);
  assert.equal(isDesktopRootProcess({ exe: binary,
    args: [`${binary} --force-renderer-accessibility`], state: 'S' }, binary), true);
  assert.equal(isDesktopRootProcess({ exe: binary, args: [], state: 'S' }, binary), false);
  assert.equal(isDesktopRootProcess({ exe: binary, args: [binary], state: 'Z' }, binary), false);
  assert.equal(isDesktopRootProcess({ exe: '/usr/bin/other', args: [binary], state: 'S' }, binary), false);
});

test('restore treats a Chromium root plus same-binary helpers in its unit as one Desktop', async () => {
  const binary = '/usr/lib/chatgpt/ChatGPT';
  const entries = [
    { pid: 1425451, startTicks: 69097853, state: 'S', exe: binary,
      args: [`${binary} --force-renderer-accessibility`], cgroup: '/app.slice/app-org.chromium.Chromium-1425451.scope' },
    ...[1425461, 1425462, 1425464, 1425500, 1425502, 1425514, 1425812, 1425813]
      .map((pid, index) => ({ pid, startTicks: 69097858 + index, state: 'S', exe: binary,
        args: [`${binary} --type=${index % 2 ? 'renderer' : 'utility'} --no-sandbox`],
        cgroup: '/app.slice/codex-desktop-restore-1424921-1.service' })),
  ];
  const roots = entries.filter(entry => isDesktopRootProcess(entry, binary));
  assert.deepEqual(roots.map(entry => entry.pid), [1425451]);
  const result = await restoreDesktopWithRetry({
    readRoots: () => roots, launch: () => { throw new Error('unexpected launch'); },
    sleep: async () => {}, stableMs: 2, pollMs: 1,
  });
  assert.equal(result.desktopPid, 1425451);
  assert.equal(result.launched, false);
});

test('Desktop restore does not accept PID reuse as a stable root', async () => {
  let startTicks = 100;
  await assert.rejects(() => restoreDesktopWithRetry({
    readRoots: () => [{ pid: 42, startTicks }],
    launch: () => ({ pid: 99 }),
    sleep: async () => { startTicks += 1; },
    attempts: 1, stableMs: 2, pollMs: 1, startupTimeoutMs: 1,
  }), /DESKTOP_RESTORE_FAILED/);
});

test('overlapping Desktop roots settle before restore accepts the surviving identity', async () => {
  let ticks = 0;
  let launches = 0;
  const root = { pid: 52, startTicks: 500, cgroup: '/app.slice/new.scope' };
  const restored = await restoreDesktopWithRetry({
    readRoots: () => ticks < 2 ? [{ pid: 51, startTicks: 400 }, root] : [root],
    launch: () => { launches += 1; },
    sleep: async () => { ticks += 1; },
    stableMs: 2, pollMs: 1, ambiguityTimeoutMs: 3,
  });
  assert.equal(restored.desktopPid, 52);
  assert.equal(launches, 0);
});

test('persistent root ambiguity fails closed with process identities and no launch', async () => {
  let launches = 0;
  await assert.rejects(() => restoreDesktopWithRetry({
    readRoots: () => [{ pid: 51, startTicks: 400, cgroup: '/a.scope' },
      { pid: 52, startTicks: 500, cgroup: '/b.scope' }],
    launch: () => { launches += 1; }, sleep: async () => {},
    pollMs: 1, ambiguityTimeoutMs: 2,
  }), error => error?.message === 'DESKTOP_ROOT_AMBIGUOUS' &&
    error.diagnostics.roots.length === 2 && error.diagnostics.roots[0].startTicks === 400);
  assert.equal(launches, 0);
});

test('restore errors from acquisition and finalization are classified for the retry latch', () => {
  for (const kind of ['DESKTOP_ROOT_AMBIGUOUS', 'DESKTOP_RESTORE_FAILED',
    'DESKTOP_ROOT_IDENTITY_UNVERIFIED', 'DESKTOP_ROOT_PID_UNVERIFIED']) {
    assert.equal(isDesktopRestoreError(new Error(kind)), true);
  }
  assert.equal(isDesktopRestoreError(new Error('APP_SERVER_EXCLUSIVITY_FAILED')), false);
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

test('AUTO Desktop restore can force renderer accessibility without changing the default launch', () => {
  const spec = desktopRestoreLaunchSpec({
    systemdRunBin: '/usr/bin/systemd-run',
    desktopLauncher: '/usr/bin/chatgpt',
    controllerPid: 1234,
    attempt: 1,
    desktopArgs: ['--force-renderer-accessibility'],
  });
  assert.deepEqual(spec.args.slice(-2), [
    '/usr/bin/chatgpt',
    '--force-renderer-accessibility',
  ]);
});

test('HEADLESS post-restore navigation targets only the last terminal continuation without a prompt', () => {
  const plan = headlessPostRestoreNavigationPlan({
    desktopRestore: { launched: true, desktopPid: 4321, attempts: 1 },
    lastTerminalThreadId: 'thread-second/value',
  });
  assert.deepEqual(plan, {
    threadId: 'thread-second/value',
    url: 'codex://threads/thread-second%2Fvalue',
    desktopPid: 4321,
  });
  assert.equal(new URL(plan.url).search, '');
  assert.equal(desktopThreadLink('thread-final'), 'codex://threads/thread-final');
});

test('HEADLESS post-restore navigation is skipped unless Desktop was restored and a turn became terminal', () => {
  assert.equal(headlessPostRestoreNavigationPlan({
    desktopRestore: null,
    lastTerminalThreadId: 'thread-a',
  }), null);
  assert.equal(headlessPostRestoreNavigationPlan({
    desktopRestore: { desktopPid: 123 },
    lastTerminalThreadId: 'thread-a',
  }), null);
  assert.equal(headlessPostRestoreNavigationPlan({
    desktopRestore: { launched: true, desktopPid: 123 },
    lastTerminalThreadId: null,
  }), null);
  assert.equal(headlessPostRestoreNavigationPlan({
    desktopRestore: { launched: true, desktopPid: null },
    lastTerminalThreadId: 'thread-a',
  }), null);
});

test('HEADLESS deeplink handoff uses an independent waited transient service', () => {
  const spec = desktopDeepLinkLaunchSpec({
    systemdRunBin: '/usr/bin/systemd-run',
    desktopBinary: '/usr/lib/chatgpt/ChatGPT',
    controllerPid: 1234,
    sequence: 7,
    url: 'codex://threads/thread-a',
  });
  assert.deepEqual(spec, {
    command: '/usr/bin/systemd-run',
    args: [
      '--user', '--quiet', '--collect', '--wait',
      '--unit=codex-desktop-navigation-1234-7',
      '--', '/usr/lib/chatgpt/ChatGPT', 'codex://threads/thread-a',
    ],
  });
});

test('HEADLESS navigation waits for renderer route readiness and confirms the exact thread', async () => {
  const events = [];
  let ready = false;
  const result = await runHeadlessPostRestoreNavigation({
    plan: { threadId: 'thread-final', desktopPid: 4321, url: 'codex://threads/thread-final' },
    waitForRouteReady: async () => { ready = true; return { attempts: 3, status: 'ready' }; },
    dispatch: async url => {
      assert.equal(ready, true);
      assert.equal(url, 'codex://threads/thread-final');
      return { pid: 55, unit: 'navigation-unit' };
    },
    confirm: async () => ({ attempts: 2, threadId: 'thread-final' }),
    onState: state => events.push(state),
    now: (() => { let value = 100; return () => value++; })(),
  });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(events.map(event => event.status), [
    'waiting-readiness', 'dispatched', 'confirmed',
  ]);
  assert.equal(events[1].launcherPid, 55);
  assert.equal(result.threadId, 'thread-final');
});

test('HEADLESS navigation timeout is UX-only and leaves completed continuation state untouched', async () => {
  const continuation = { status: 'COMPLETED', committedAtMs: 10, continuationTurnId: 'turn-next' };
  const events = [];
  const result = await runHeadlessPostRestoreNavigation({
    plan: { threadId: 'thread-final', desktopPid: 4321, url: 'codex://threads/thread-final' },
    waitForRouteReady: async () => { throw new Error('DESKTOP_ROUTE_READINESS_TIMEOUT'); },
    dispatch: async () => { throw new Error('must-not-dispatch'); },
    confirm: async () => { throw new Error('must-not-confirm'); },
    onState: state => events.push(state),
    now: () => 200,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorKind, 'DESKTOP_ROUTE_READINESS_TIMEOUT');
  assert.equal(events.at(-1).status, 'failed');
  assert.deepEqual(continuation, {
    status: 'COMPLETED', committedAtMs: 10, continuationTurnId: 'turn-next',
  });
});
