'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  CONTINUATION_DRAFT,
  buildContinuationPlan,
  continuationDeepLinks,
  validateContinuationPlan,
} = require('../lib/codex-continuation-drafts');
const { INTERRUPTION_CLASS, inputHash } = require('../lib/codex-turn-continuation');

const NOW = 1_790_190_000_000;

function usageEntry({ primary = 40, secondary = 60, allowed = true, at = NOW } = {}) {
  return {
    primary: { remainingPercent: primary },
    secondary: { remainingPercent: secondary },
    ordinaryUsageAllowedObserved: true,
    ordinaryUsageAllowed: allowed,
    refresh: {
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };
}

function usageCache(overrides = {}) {
  return {
    worker: { heartbeatAtMs: NOW, fatalErrorKind: null },
    accounts: {
      source: usageEntry({ allowed: false }),
      target: usageEntry(),
      ...overrides,
    },
  };
}

function eventState({ heartbeatAtMs = NOW, includeExhaustion = true } = {}) {
  return {
    worker: { heartbeatAtMs, errorKind: null },
    activeTurns: {},
    interruptedTurns: {
      later: {
        threadId: 'thread-later', turnId: 'turn-later', accountId: 'source',
        completedAtMs: NOW - 1_000, resumable: true, threadIdentityVerified: true,
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
      earlier: {
        threadId: 'thread-earlier', turnId: 'turn-earlier', accountId: 'source',
        completedAtMs: NOW - 2_000, resumable: true, threadIdentityVerified: true,
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
      guardian: {
        threadId: 'thread-guardian', turnId: 'turn-guardian', accountId: 'source',
        completedAtMs: NOW - 3_000, resumable: true, threadIdentityVerified: true,
        threadSource: 'guardian_review',
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
      other: {
        threadId: 'thread-other', turnId: 'turn-other', accountId: 'other',
        completedAtMs: NOW - 4_000, resumable: true, threadIdentityVerified: true,
        interruptionClass: INTERRUPTION_CLASS.AFTER_WORK, classificationVerified: true,
      },
    },
    exhaustions: includeExhaustion ? {
      source: {
        accountId: 'source', verified: true, threadIdentityVerified: true,
        errorKind: 'usageLimitExceeded',
      },
    } : {},
  };
}

function planInput(overrides = {}) {
  return {
    sourceAccountId: 'source',
    sourceAccountKey: 'source-key',
    targetAccountId: 'target',
    targetAccountKey: 'target-key',
    eventState: eventState(),
    resumeState: {},
    usageCache: usageCache(),
    preferences: { autoMode: 'OFF' },
    nowMs: NOW,
    ...overrides,
  };
}

test('plans every verified interrupted main thread oldest first so the newest remains visible', () => {
  const plan = buildContinuationPlan(planInput());
  assert.equal(plan.action, 'prefill');
  assert.deepEqual(plan.candidates.map(candidate => candidate.threadId), [
    'thread-earlier',
    'thread-later',
  ]);
  const links = continuationDeepLinks(plan.candidates);
  assert.equal(links.length, 2);
  assert.match(links[0], /^codex:\/\/threads\/thread-earlier\?/);
  assert.equal(new URL(links[0]).searchParams.get('prompt'), CONTINUATION_DRAFT);
  assert.match(links[1], /^codex:\/\/threads\/thread-later\?/);
});

test('a rejected text-only prompt is restored exactly while structured input is navigation-only', () => {
  const textInput = [{ type: 'text', text: 'Original exact request' }];
  const structuredInput = [{ type: 'image', url: 'https://example.test/image.png' }];
  const state = eventState();
  state.interruptedTurns = {
    text: {
      threadId: 'thread-text', turnId: 'turn-text', accountId: 'source', completedAtMs: NOW - 2_000,
      resumable: true, threadIdentityVerified: true, classificationVerified: true,
      interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK,
      originalInput: textInput, originalInputHash: inputHash(textInput),
    },
    structured: {
      threadId: 'thread-structured', turnId: 'turn-structured', accountId: 'source', completedAtMs: NOW - 1_000,
      resumable: true, threadIdentityVerified: true, classificationVerified: true,
      interruptionClass: INTERRUPTION_CLASS.BEFORE_WORK,
      originalInput: structuredInput, originalInputHash: inputHash(structuredInput),
    },
  };
  const plan = buildContinuationPlan(planInput({ eventState: state }));
  assert.equal(plan.action, 'prefill');
  assert.deepEqual(plan.candidates.map(candidate => candidate.mode), ['prefill', 'navigate']);
  const links = continuationDeepLinks(plan.candidates);
  assert.equal(new URL(links[0]).searchParams.get('prompt'), 'Original exact request');
  assert.equal(new URL(links[1]).searchParams.has('prompt'), false);
});

test('unknown interruption classification never creates a continuation draft', () => {
  const state = eventState();
  state.interruptedTurns = {
    unknown: {
      threadId: 'thread-unknown', turnId: 'turn-unknown', accountId: 'source', completedAtMs: NOW,
      resumable: true, threadIdentityVerified: true, classificationVerified: false,
      interruptionClass: INTERRUPTION_CLASS.UNKNOWN,
    },
  };
  const plan = buildContinuationPlan(planInput({ eventState: state }));
  assert.equal(plan.action, 'blocked');
  assert.equal(plan.reason, 'candidate-classification-unverified');
  assert.deepEqual(continuationDeepLinks(plan.candidates), []);
});

test('ordinary switches and switches to the same account never create a prefill plan', () => {
  assert.equal(buildContinuationPlan(planInput({
    eventState: eventState({ includeExhaustion: false }),
  })).action, 'none');
  assert.equal(buildContinuationPlan(planInput({
    targetAccountId: 'source', targetAccountKey: 'source-key',
  })).action, 'none');
});

test('stale observer or source usage blocks prefill before switching', () => {
  assert.deepEqual(buildContinuationPlan(planInput({
    eventState: eventState({ heartbeatAtMs: NOW - 60_000 }),
  })).reason, 'observer-unverified');
  assert.deepEqual(buildContinuationPlan(planInput({
    usageCache: usageCache({ source: usageEntry({ allowed: false, at: NOW - 4 * 60_000 }) }),
  })).reason, 'source-usage-unverified');
});

test('post-switch validation requires exact target, fresh usable target and unchanged candidates', () => {
  const input = planInput();
  const plan = buildContinuationPlan(input);
  const valid = validateContinuationPlan({
    plan,
    eventState: input.eventState,
    resumeState: input.resumeState,
    usageCache: input.usageCache,
    preferences: input.preferences,
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
    nowMs: NOW,
  });
  assert.equal(valid.ok, true);

  assert.equal(validateContinuationPlan({
    ...input, plan, activeAccountId: 'wrong', activeAccountKey: 'target-key',
  }).reason, 'target-account-mismatch');
  assert.equal(validateContinuationPlan({
    ...input,
    plan,
    usageCache: usageCache({ target: usageEntry({ primary: 0, allowed: false }) }),
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
  }).reason, 'target-not-usable');
  assert.equal(validateContinuationPlan({
    ...input,
    plan,
    eventState: { ...input.eventState, interruptedTurns: {} },
    activeAccountId: 'target',
    activeAccountKey: 'target-key',
  }).reason, 'interrupted-candidates-changed');
});

test('HEADLESS owns every exact interrupted candidate during a manual switch', () => {
  const plan = buildContinuationPlan(planInput({ preferences: { autoMode: 'HEADLESS' } }));
  assert.equal(plan.action, 'none');
  assert.equal(plan.reason, 'auto-owns-candidates');
  assert.deepEqual(plan.candidates.map(candidate => [candidate.threadId, candidate.turnId, candidate.owner, candidate.mode]), [
    ['thread-earlier', 'turn-earlier', 'headless', 'skip'],
    ['thread-later', 'turn-later', 'headless', 'skip'],
  ]);
  assert.deepEqual(continuationDeepLinks(plan.candidates), []);
});

test('retired DESKTOP mode cannot create claims; OFF retains manual draft semantics', () => {
  assert.throws(() => buildContinuationPlan(planInput({ preferences: { autoMode: 'DESKTOP' } })),
    /CONTINUATION_MODE_UNVERIFIED/);
  const off = buildContinuationPlan(planInput());
  assert.equal(off.action, 'prefill');
  assert.equal(continuationDeepLinks(off.candidates).length, 2);
  assert.equal(validateContinuationPlan({ ...planInput(), plan: off, preferences: { autoMode: 'HEADLESS' },
    activeAccountId: 'target', activeAccountKey: 'target-key' }).reason, 'interrupted-candidates-changed');
});

test('HEADLESS manual prepare/apply journals two skips and dispatches no deep links', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-draft-ownership-'));
  try {
    const input = planInput({ nowMs: Date.now() });
    const event = input.eventState;
    event.version = 4;
    const usage = input.usageCache;
    const now = Date.now();
    event.worker.heartbeatAtMs = now;
    usage.worker.heartbeatAtMs = now;
    for (const entry of Object.values(usage.accounts)) {
      entry.refresh.lastSuccessAt = now;
      entry.refresh.lastAttemptAt = now;
    }
    const eventFile = path.join(directory, 'events.json');
    const usageFile = path.join(directory, 'usage.json');
    const resumeFile = path.join(directory, 'resume.json');
    const preferencesFile = path.join(directory, 'preferences.json');
    const journalFile = path.join(directory, 'draft-journal.json');
    const planFile = path.join(directory, 'plan.json');
    for (const [file, value] of [[eventFile, event], [usageFile, usage], [resumeFile, {}],
      [preferencesFile, { version: 2, autoMode: 'HEADLESS' }]]) {
      fs.writeFileSync(file, JSON.stringify(value));
    }
    const environment = { ...process.env, CODEX_EVENT_STATE: eventFile, USAGE_CACHE: usageFile,
      CODEX_RESUME_STATE: resumeFile, CODEX_STATUS_PREFERENCES: preferencesFile,
      CODEX_DRAFT_JOURNAL: journalFile, CHATGPT_BINARY_PATTERN: '/bin/false' };
    const bin = path.join(__dirname, '..', 'bin', 'codex-continuation-drafts');
    const prepared = spawnSync(process.execPath, [bin, 'prepare', planFile,
      'source', 'source-key', 'target', 'target-key'], { env: environment, encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /^none:auto-owns-candidates/);
    const applied = spawnSync(process.execPath, [bin, 'apply', planFile], { env: environment, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stdout.trim(), 'skipped');
    const events = JSON.parse(fs.readFileSync(journalFile)).events;
    assert.equal(events.length, 4);
    assert.deepEqual([...new Set(events.map(event => event.owner))], ['headless']);
    assert.equal(events.every(event => event.eligible === false && event.result !== 'dispatched'), true);
    assert.equal(JSON.stringify(events).includes(CONTINUATION_DRAFT), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a committed headless resume and subagent candidates are never drafted', () => {
  const resumeState = {
    attempts: {
      '["thread-later","turn-later"]': { committedAtMs: NOW - 500 },
    },
  };
  const plan = buildContinuationPlan(planInput({ resumeState }));
  assert.deepEqual(plan.candidates.map(candidate => candidate.threadId), ['thread-earlier']);
});
