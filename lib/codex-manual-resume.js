'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  HEADLESS_CONTINUATION_PROMPT,
  INTERRUPTION_CLASS,
  continuationForCandidate,
} = require('./codex-turn-continuation');

const RESUME_STATE_VERSION = 2;
const CONTINUATION_PROMPT = HEADLESS_CONTINUATION_PROMPT;
const DESKTOP_APP_SERVER_DRAIN_TIMEOUT_MS = 15_000;
const DESKTOP_RESTORE_ERRORS = new Set([
  'DESKTOP_ROOT_AMBIGUOUS', 'DESKTOP_ROOT_IDENTITY_UNVERIFIED',
  'DESKTOP_ROOT_PID_UNVERIFIED', 'DESKTOP_RESTORE_FAILED',
]);

function isDesktopRestoreError(error) {
  return DESKTOP_RESTORE_ERRORS.has(error?.message);
}

function appServerDrainDecision(report, elapsedMs, timeoutMs = DESKTOP_APP_SERVER_DRAIN_TIMEOUT_MS) {
  if (report?.exclusive === true) return 'exclusive';
  const blockers = Array.isArray(report?.blockers) ? report.blockers : [];
  if (blockers.length === 0) return 'fail';
  if (blockers.some(blocker => blocker?.role !== 'desktop-app-server')) return 'fail';
  return elapsedMs < timeoutMs ? 'wait' : 'fail';
}

async function pollAppServerExclusivity({
  readReport,
  sleep,
  now = Date.now,
  timeoutMs = DESKTOP_APP_SERVER_DRAIN_TIMEOUT_MS,
  pollMs = 100,
}) {
  const startedAtMs = now();
  let report = readReport();
  let outcome = appServerDrainDecision(report, now() - startedAtMs, timeoutMs);
  while (outcome === 'wait') {
    await sleep(pollMs);
    report = readReport();
    outcome = appServerDrainDecision(report, now() - startedAtMs, timeoutMs);
  }
  return { outcome, report, elapsedMs: Math.max(0, now() - startedAtMs) };
}

async function restoreDesktopWithRetry({
  readRoots,
  launch,
  sleep,
  now = Date.now,
  attempts = 2,
  startupTimeoutMs = 10_000,
  stableMs = 10_000,
  pollMs = 250,
  retryDelayMs = 1_000,
  ambiguityTimeoutMs = 3_000,
}) {
  function uniqueRoot() {
    const roots = [...readRoots()];
    if (roots.length > 1) {
      const error = new Error('DESKTOP_ROOT_AMBIGUOUS');
      error.diagnostics = { roots: roots.map(root => ({
        pid: root.pid, startTicks: root.startTicks, cgroup: root.cgroup || null,
      })) };
      throw error;
    }
    const root = roots[0];
    if (root && (!Number.isInteger(root.pid) || root.pid <= 0 ||
        !Number.isFinite(root.startTicks) || root.startTicks <= 0)) {
      throw new Error('DESKTOP_ROOT_IDENTITY_UNVERIFIED');
    }
    return root || null;
  }
  async function settledRoot() {
    let waited = 0;
    while (true) {
      try { return uniqueRoot(); } catch (error) {
        if (error?.message !== 'DESKTOP_ROOT_AMBIGUOUS' || waited >= ambiguityTimeoutMs) throw error;
      }
      const delay = Math.min(pollMs, ambiguityTimeoutMs - waited);
      await sleep(delay);
      waited += delay;
    }
  }
  async function stableRoot(root) {
    let elapsed = 0;
    while (elapsed < stableMs) {
      const delay = Math.min(pollMs, stableMs - elapsed);
      await sleep(delay);
      elapsed += delay;
      const current = await settledRoot();
      if (!current || current.pid !== root.pid || current.startTicks !== root.startTicks) return false;
    }
    return true;
  }
  const existing = await settledRoot();
  if (existing && await stableRoot(existing)) return { launched: false, attempts: 0, desktopPid: existing.pid,
    desktopStartTicks: existing.startTicks, desktopCgroup: existing.cgroup || null, history: [] };
  const history = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A preceding transient unit may have started the single Electron root
    // just after its discovery deadline. Recheck before launching another.
    const lateRoot = await settledRoot();
    if (lateRoot && await stableRoot(lateRoot)) return { launched: attempt > 1, attempts: attempt - 1, desktopPid: lateRoot.pid,
      desktopStartTicks: lateRoot.startTicks, desktopCgroup: lateRoot.cgroup || null, history };
    const launched = launch(attempt) || {};
    const record = {
      attempt,
      requestedAtMs: now(),
      launcherPid: launched.pid || null,
      unit: launched.unit || null,
      desktopPid: null,
      result: 'startup-timeout',
    };
    history.push(record);

    let startupWaitedMs = 0;
    while (startupWaitedMs <= startupTimeoutMs) {
      const detected = await settledRoot();
      if (detected) {
        record.desktopPid = detected.pid;
        record.desktopStartTicks = detected.startTicks;
        record.desktopCgroup = detected.cgroup || null;
        record.detectedAtMs = now();
        record.result = 'stabilizing';
        break;
      }
      if (startupWaitedMs === startupTimeoutMs) break;
      const delay = Math.min(pollMs, startupTimeoutMs - startupWaitedMs);
      await sleep(delay);
      startupWaitedMs += delay;
    }

    if (record.desktopPid) {
      let stableForMs = 0;
      while (stableForMs < stableMs) {
        const delay = Math.min(pollMs, stableMs - stableForMs);
        await sleep(delay);
        stableForMs += delay;
        const current = await settledRoot();
        if (!current || current.pid !== record.desktopPid || current.startTicks !== record.desktopStartTicks) {
          record.result = 'exited-before-ready';
          record.exitedAtMs = now();
          break;
        }
      }
      if (record.result === 'stabilizing') {
        record.result = 'ready';
        record.readyAtMs = now();
        return {
          launched: true,
          attempts: attempt,
          desktopPid: record.desktopPid,
          desktopStartTicks: record.desktopStartTicks,
          desktopCgroup: record.desktopCgroup,
          history,
        };
      }
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  const error = new Error('DESKTOP_RESTORE_FAILED');
  error.diagnostics = { attempts: history };
  throw error;
}

function desktopRestoreLaunchSpec({
  systemdRunBin,
  desktopLauncher,
  controllerPid,
  attempt,
  desktopArgs = [],
}) {
  if (!systemdRunBin || !desktopLauncher || !Number.isInteger(controllerPid) || !Number.isInteger(attempt) ||
      !Array.isArray(desktopArgs) || desktopArgs.some(argument => typeof argument !== 'string')) {
    throw new Error('DESKTOP_RESTORE_LAUNCH_SPEC_INVALID');
  }
  return {
    command: systemdRunBin,
    args: [
      '--user',
      '--quiet',
      '--collect',
      `--unit=codex-desktop-restore-${controllerPid}-${attempt}`,
      '--',
      desktopLauncher,
      ...desktopArgs,
    ],
  };
}

function desktopDeepLinkLaunchSpec({ systemdRunBin, desktopBinary, controllerPid, sequence, url }) {
  if (!systemdRunBin || !desktopBinary || !Number.isInteger(controllerPid) ||
      !Number.isInteger(sequence) || typeof url !== 'string' || !url.startsWith('codex://threads/')) {
    throw new Error('DESKTOP_DEEPLINK_LAUNCH_SPEC_INVALID');
  }
  return {
    command: systemdRunBin,
    args: [
      '--user', '--quiet', '--collect', '--wait',
      `--unit=codex-desktop-navigation-${controllerPid}-${sequence}`,
      '--', desktopBinary, url,
    ],
  };
}

async function runHeadlessPostRestoreNavigation({
  plan,
  waitForRouteReady,
  dispatch,
  confirm,
  onState = () => {},
  now = Date.now,
}) {
  if (!plan || typeof waitForRouteReady !== 'function' || typeof dispatch !== 'function' ||
      typeof confirm !== 'function' || typeof onState !== 'function') {
    throw new Error('DESKTOP_NAVIGATION_CONFIGURATION_INVALID');
  }
  const base = { threadId: plan.threadId, desktopPid: plan.desktopPid };
  let progress = { ...base };
  try {
    progress = { ...progress, status: 'waiting-readiness', startedAtMs: now(), errorKind: null };
    onState(progress);
    const readiness = await waitForRouteReady();
    const dispatched = await dispatch(plan.url);
    progress = {
      ...progress, status: 'dispatched', dispatchedAtMs: now(), launcherPid: dispatched?.pid || null,
      unit: dispatched?.unit || null, readiness: readiness || null, errorKind: null,
    };
    onState(progress);
    const confirmation = await confirm();
    const completed = {
      ...progress, status: 'confirmed', confirmedAtMs: now(),
      confirmation: confirmation || null, errorKind: null,
    };
    onState(completed);
    return completed;
  } catch (error) {
    const failed = {
      ...progress, status: 'failed', failedAtMs: now(),
      errorKind: error?.message || 'DESKTOP_NAVIGATION_FAILED',
      diagnostics: error?.diagnostics || error?.desktopPreflight || null,
    };
    onState(failed);
    return failed;
  }
}

function desktopThreadLink(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim()) {
    throw new Error('DESKTOP_THREAD_ID_INVALID');
  }
  return new URL(`codex://threads/${encodeURIComponent(threadId)}`).toString();
}

function headlessPostRestoreNavigationPlan({ desktopRestore, lastTerminalThreadId }) {
  if (!desktopRestore || desktopRestore.launched !== true) return null;
  if (!Number.isInteger(desktopRestore.desktopPid) || desktopRestore.desktopPid <= 0) return null;
  if (typeof lastTerminalThreadId !== 'string' || !lastTerminalThreadId) return null;
  return {
    threadId: lastTerminalThreadId,
    url: desktopThreadLink(lastTerminalThreadId),
    desktopPid: desktopRestore.desktopPid,
  };
}

function resumeProtocolRequests(threadId) {
  return {
    read: { threadId, includeTurns: false },
    latestTurn: { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' },
    resume: { threadId, excludeTurns: true },
  };
}

function splitJsonLines(buffer, chunk, maxFrameBytes) {
  let remaining = `${buffer || ''}${chunk || ''}`;
  const lines = [];
  let newline;
  while ((newline = remaining.indexOf('\n')) >= 0) {
    const line = remaining.slice(0, newline);
    remaining = remaining.slice(newline + 1);
    const frameBytes = Buffer.byteLength(line);
    if (frameBytes > maxFrameBytes) {
      const error = new Error('APP_SERVER_PROTOCOL_OVERFLOW');
      error.diagnostics = { limitBytes: maxFrameBytes, frameBytes, terminated: true };
      throw error;
    }
    if (line.trim()) lines.push(line);
  }
  const bufferedBytes = Buffer.byteLength(remaining);
  if (bufferedBytes > maxFrameBytes) {
    const error = new Error('APP_SERVER_PROTOCOL_OVERFLOW');
    error.diagnostics = { limitBytes: maxFrameBytes, bufferedBytes, terminated: false };
    throw error;
  }
  return { lines, remaining };
}

function candidateKey(threadId, turnId) {
  return JSON.stringify([threadId, turnId]);
}

function emptyResumeState() {
  return { version: RESUME_STATE_VERSION, attempts: {}, retiredCandidates: {},
    retirementHistory: [], lastError: null };
}

function normalizeResumeState(value) {
  return {
    ...emptyResumeState(),
    ...(value && typeof value === 'object' ? value : {}),
    version: RESUME_STATE_VERSION,
    attempts: value?.attempts && typeof value.attempts === 'object' ? value.attempts : {},
    retiredCandidates: value?.retiredCandidates && typeof value.retiredCandidates === 'object' &&
      !Array.isArray(value.retiredCandidates) ? value.retiredCandidates : {},
    retirementHistory: Array.isArray(value?.retirementHistory) ? value.retirementHistory.slice(-64) : [],
  };
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filename), 0o700);
  const temporary = `${filename}.tmp-${process.pid}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
  const directoryDescriptor = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
}

function pendingInterruptedTurns(eventState, resumeState = emptyResumeState()) {
  const normalized = normalizeResumeState(resumeState);
  const attempts = normalized.attempts;
  return Object.values(eventState?.interruptedTurns || {})
    .filter(candidate => candidate?.resumable === true && candidate?.threadIdentityVerified === true)
    .filter(candidate => !candidate.parentThreadId && candidate.threadSource !== 'guardian_review')
    .filter(candidate => !normalized.retiredCandidates[candidateKey(candidate.threadId, candidate.turnId)])
    .filter(candidate => {
      const attempt = attempts[candidateKey(candidate.threadId, candidate.turnId)];
      return !attempt?.committedAtMs && attempt?.status !== 'PREFILL_STARTED';
    })
    .sort((left, right) => Number(left.completedAtMs) - Number(right.completedAtMs));
}

function currentResumeProblemLines(resumeState = emptyResumeState()) {
  return Object.values(normalizeResumeState(resumeState).attempts)
    .filter(attempt => ['MANUAL_REQUIRED_AFTER_COMMIT', 'PREFILL_STARTED', 'SEND_UNCONFIRMED', 'SEND_CONFLICT'].includes(attempt.status))
    .map(attempt => attempt.strategy === 'DESKTOP'
      ? attempt.status === 'PREFILL_STARTED'
        ? `AUTO DESKTOP / ACTION REQUIRED: …${String(attempt.threadId || '').slice(-8)} may contain a continuation draft; no automatic fallback or retry (${attempt.errorKind || attempt.status}).`
        : `AUTO DESKTOP / ACTION REQUIRED: …${String(attempt.threadId || '').slice(-8)} Send was committed and will not be retried (${attempt.errorKind || attempt.status}).`
      : `MANUAL RESUME / ACTION REQUIRED: …${String(attempt.threadId || '').slice(-8)} was committed; no automatic retry (${attempt.errorKind || 'unknown error'}).`);
}

function interruptedCandidateProblemLines(eventState, resumeState = emptyResumeState(), { autoContinue = false } = {}) {
  const lines = [];
  for (const candidate of pendingInterruptedTurns(eventState, resumeState)) {
    const shortId = `…${String(candidate.threadId || '').slice(-8)}`;
    const headless = continuationForCandidate(candidate);
    if (candidate.interruptionClass === INTERRUPTION_CLASS.UNKNOWN || candidate.classificationVerified !== true) {
      lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} could not be classified safely.`);
      continue;
    }
    if (candidate.interruptionClass === INTERRUPTION_CLASS.BEFORE_WORK) {
      if (!headless.ok) {
        lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} original input cannot be reconstructed exactly.`);
        continue;
      }
      const desktop = continuationForCandidate(candidate, { desktop: true });
      if (!autoContinue && !desktop.ok) {
        lines.push(`QUOTA CONTINUATION / MANUAL REQUIRED: ${shortId} was rejected before work; resend its structured input manually.`);
      }
    }
  }
  return lines;
}

function codexErrorKind(error) {
  const value = error?.codexErrorInfo ?? error?.codex_error_info ?? null;
  return typeof value === 'string' ? value.replaceAll('_', '').toLowerCase() : null;
}

function isAppServerProcess(entry) {
  return Array.isArray(entry?.args) && entry.args.includes('app-server');
}

function isVsCodeCodexAppServerProcess(entry) {
  return isAppServerProcess(entry) &&
    /\/\.vscode\/extensions\/openai\.chatgpt-[^/]+\/bin\/[^/]+\/codex$/.test(entry.args[0] || '');
}

function captureDesktopLineage(entries, rootPids, previous = []) {
  const byPid = new Map((entries || []).map(entry => [entry.pid, entry]));
  const known = new Map();
  const trustedCgroups = new Set();
  function remember(entry) {
    known.set(entry.pid, { pid: entry.pid, startTicks: entry.startTicks });
    // Trust only the dedicated restore unit, never a shared user/app slice.
    if (/\/codex-desktop-restore-\d+-\d+\.service$/.test(entry.cgroup || '')) {
      trustedCgroups.add(entry.cgroup);
    }
  }
  for (const identity of previous) {
    const live = byPid.get(identity.pid);
    if (live && Number.isFinite(live.startTicks) && live.startTicks === identity.startTicks) {
      remember(live);
    }
  }
  for (const pid of rootPids || []) {
    const root = byPid.get(pid);
    if (root && Number.isFinite(root.startTicks)) remember(root);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries || []) {
      if (known.has(entry.pid) || !Number.isFinite(entry.startTicks) ||
          (!known.has(entry.ppid) && !trustedCgroups.has(entry.cgroup))) continue;
      remember(entry);
      changed = true;
    }
  }
  return [...known.values()];
}

function isDesktopRootProcess(entry, desktopBinary) {
  const args = entry?.args;
  if (!Array.isArray(args) || args.length === 0) return false;
  // Electron can rewrite /proc/<pid>/cmdline into one space-separated argv[0].
  // Its helpers use the same executable as the main process.
  const commandLine = args.join(' ');
  return entry.state !== 'Z' && (entry.exe === desktopBinary ||
    (!entry.exe && args[0] === desktopBinary)) &&
    !/(?:^|\s)--type(?:=|\s)/.test(commandLine);
}

function automaticClientBlocker(entries) {
  const servers = (entries || []).filter(isVsCodeCodexAppServerProcess);
  if (servers.length === 0) return null;
  const hosts = [...new Set(servers.map(server => server.ppid))];
  const classified = hosts.every(hostPid => {
    const host = entries.find(entry => entry.pid === hostPid);
    return host?.args?.includes('--utility-sub-type=node.mojom.NodeService');
  });
  return {
    errorKind: classified
      ? 'AUTO_BLOCKED_VSCODE_CODEX_ACTIVE'
      : 'VSCODE_EXTENSION_HOST_UNVERIFIED',
    hosts,
    servers: servers.map(server => server.pid),
  };
}

function appServerExclusivityReport(entries, { desktopPids = [], desktopLineage = [], ignoredPids = [] } = {}) {
  const desktop = new Set(desktopPids);
  const stableDesktop = new Map(desktopLineage.map(identity => [identity.pid, identity.startTicks]));
  const ignored = new Set(ignoredPids);
  const blockers = [];
  for (const entry of entries || []) {
    if (!isAppServerProcess(entry) || ignored.has(entry.pid)) continue;
    const vscode = isVsCodeCodexAppServerProcess(entry);
    if (vscode && ['T', 't'].includes(entry.state)) continue;
    blockers.push({
      pid: entry.pid,
      ppid: entry.ppid,
      state: entry.state || '?',
      ...(Number.isFinite(Number(entry.startTicks)) ? { startTicks: Number(entry.startTicks) } : {}),
      role: vscode ? 'vscode-app-server-not-quiescent'
        : (Number.isFinite(entry.startTicks) && stableDesktop.get(entry.pid) === entry.startTicks) ||
          (desktopLineage.length === 0 && desktop.has(entry.pid))
          ? 'desktop-app-server' : 'other-app-server',
    });
  }
  return { exclusive: blockers.length === 0, blockers };
}

function validateThreadMetadataForResume({ candidate, thread, eventState, resumeState }) {
  if (!candidate?.threadId || !candidate?.turnId || candidate.threadIdentityVerified !== true) {
    throw new Error('CANDIDATE_IDENTITY_UNVERIFIED');
  }
  if (candidate.parentThreadId || candidate.threadSource === 'guardian_review') {
    throw new Error('CANDIDATE_NOT_MAIN_THREAD');
  }
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const continuation = continuationForCandidate(candidate);
  if (candidate.classificationVerified !== true || !continuation.ok) {
    throw new Error(continuation.reason || 'CANDIDATE_CLASSIFICATION_UNVERIFIED');
  }
  const persisted = eventState?.interruptedTurns?.[key];
  const persistedContinuation = continuationForCandidate(persisted);
  if (
    !persisted ||
    persisted.classificationVerified !== true ||
    !persistedContinuation.ok ||
    persisted.interruptionClass !== candidate.interruptionClass ||
    persistedContinuation.inputHash !== continuation.inputHash
  ) throw new Error('CANDIDATE_EVIDENCE_CHANGED');
  if (normalizeResumeState(resumeState).attempts[key]?.committedAtMs) {
    throw new Error('RESUME_ALREADY_COMMITTED');
  }
  if (Object.values(eventState?.activeTurns || {}).some(turn => turn.threadId === candidate.threadId)) {
    throw new Error('THREAD_STILL_ACTIVE');
  }
  if (thread?.id !== candidate.threadId) throw new Error('THREAD_ID_MISMATCH');
  const status = thread?.status?.type;
  if (status !== 'idle' && status !== 'notLoaded') throw new Error('THREAD_NOT_IDLE');
  return true;
}

function validateThreadForResume({ candidate, thread, eventState, resumeState }) {
  validateThreadMetadataForResume({ candidate, thread, eventState, resumeState });
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latest = turns.at(-1);
  if (!latest || latest.id !== candidate.turnId) throw new Error('CANDIDATE_NOT_LATEST_TURN');
  if (latest.status !== 'failed' || codexErrorKind(latest.error) !== 'usagelimitexceeded') {
    throw new Error('LATEST_TURN_NOT_VERIFIED_EXHAUSTION');
  }
  return true;
}

function markResumeCommitted(stateInput, candidate, details = {}, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  if (state.attempts[key]?.committedAtMs) throw new Error('RESUME_ALREADY_COMMITTED');
  const continuation = details.continuation;
  if (
    !continuation?.ok ||
    continuation.classification !== candidate.interruptionClass ||
    !/^[0-9a-f]{64}$/.test(continuation.inputHash || '')
  ) throw new Error('RESUME_INPUT_UNVERIFIED');
  state.attempts[key] = {
    threadId: candidate.threadId,
    interruptedTurnId: candidate.turnId,
    accountId: candidate.accountId || null,
    targetAccountId: details.targetAccountId || null,
    automatic: details.automatic === true,
    interruptionClass: continuation.classification,
    continuationKind: continuation.kind,
    inputHash: continuation.inputHash,
    committedAtMs: nowMs,
    status: 'RESUME_COMMITTED',
    continuationTurnId: null,
    completedAtMs: null,
    terminalStatus: null,
    errorKind: null,
  };
  state.lastError = null;
  return state;
}

function markResumeTerminal(stateInput, candidate, { turnId, status, errorKind = null }, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  const attempt = state.attempts[key];
  if (!attempt?.committedAtMs) throw new Error('RESUME_NOT_COMMITTED');
  state.attempts[key] = {
    ...attempt,
    continuationTurnId: turnId || attempt.continuationTurnId,
    completedAtMs: nowMs,
    terminalStatus: status || null,
    errorKind,
    status: status === 'completed' ? 'COMPLETED' : 'TERMINAL_AFTER_COMMIT',
  };
  return state;
}

function markResumeFailure(stateInput, candidate, errorKind, { committed = false, diagnostics = null } = {}, nowMs = Date.now()) {
  const state = normalizeResumeState(stateInput);
  const key = candidateKey(candidate.threadId, candidate.turnId);
  if (committed || state.attempts[key]?.committedAtMs) {
    state.attempts[key] = {
      ...(state.attempts[key] || {}),
      threadId: candidate.threadId,
      interruptedTurnId: candidate.turnId,
      committedAtMs: state.attempts[key]?.committedAtMs || nowMs,
      status: 'MANUAL_REQUIRED_AFTER_COMMIT',
      errorKind,
      diagnostics,
      failedAtMs: nowMs,
    };
  } else {
    state.lastError = {
      threadId: candidate.threadId,
      interruptedTurnId: candidate.turnId,
      errorKind,
      diagnostics,
      failedAtMs: nowMs,
      actionRequired: true,
    };
  }
  return state;
}

module.exports = {
  CONTINUATION_PROMPT,
  DESKTOP_APP_SERVER_DRAIN_TIMEOUT_MS,
  RESUME_STATE_VERSION,
  atomicWriteJson,
  automaticClientBlocker,
  appServerDrainDecision,
  appServerExclusivityReport,
  captureDesktopLineage,
  isDesktopRootProcess,
  isDesktopRestoreError,
  candidateKey,
  codexErrorKind,
  currentResumeProblemLines,
  interruptedCandidateProblemLines,
  emptyResumeState,
  markResumeCommitted,
  markResumeFailure,
  markResumeTerminal,
  normalizeResumeState,
  pendingInterruptedTurns,
  pollAppServerExclusivity,
  resumeProtocolRequests,
  restoreDesktopWithRetry,
  desktopRestoreLaunchSpec,
  desktopDeepLinkLaunchSpec,
  desktopThreadLink,
  headlessPostRestoreNavigationPlan,
  runHeadlessPostRestoreNavigation,
  splitJsonLines,
  isAppServerProcess,
  isVsCodeCodexAppServerProcess,
  validateThreadMetadataForResume,
  validateThreadForResume,
};
