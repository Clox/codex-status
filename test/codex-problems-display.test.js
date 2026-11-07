'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { layoutStatusFrame } = require('../lib/codex-status-viewport');
const { problem, ACTION_REQUIRED, DIAGNOSTIC, HISTORY } = require('../lib/codex-problems');

const root = process.env.CODEX_STATUS_TEST_ROOT;
const home = process.env.CODEX_HOME;
const cache = path.join(root, 'cache', 'codex-account-switcher');
const now = 1_800_000_000_000;
const raw = '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY\n' +
  ' *01 a@example.test    Plus  -             -               Now';
const account = { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' };
fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({
  active_account_key: 'key-a', accounts: [account],
}));
fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
  auth_mode: 'chatgpt', tokens: { account_id: 'account-a' },
}));

function write(name, value) { fs.writeFileSync(path.join(cache, name), JSON.stringify(value)); }
function render(states = {}, diagnostics = false) {
  write('usage.json', states.usage || { updatedAtMs: now, accounts: { 'account-a': {
    primary: { remainingPercent: 50, resetsAt: now / 1000 + 3600 },
    secondary: { remainingPercent: 50, resetsAt: now / 1000 + 3600 },
    refresh: { lastSuccessAt: now, lastAttemptAt: now, consecutiveFailures: 0 },
  } } });
  write('five-hour-activation.json', states.activation || { enabled: true,
    worker: { heartbeatAtMs: now }, accounts: {} });
  write('auto-continue.json', states.auto || {});
  write('manual-resume.json', states.resume || {});
  write('turn-events.json', states.events || { version: 4,
    worker: { heartbeatAtMs: now, errorKind: null }, activeTurns: {},
    interruptedTurns: {}, terminalTurns: [], files: {}, pendingErrors: {}, exhaustions: {} });
  const result = spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'codex-usage-annotate'), ...(diagnostics ? ['--diagnostics'] : [])],
    { input: raw, encoding: 'utf8', env: { ...process.env, CODEX_STATUS_NOW_MS: String(now),
      CODEX_AUTO_CONTINUE_STATE: path.join(cache, 'auto-continue.json'),
      FIVE_HOUR_ACTIVATION_STATE: path.join(cache, 'five-hour-activation.json'),
      CODEX_RESUME_STATE: path.join(cache, 'manual-resume.json'),
      CODEX_EVENT_STATE: path.join(cache, 'turn-events.json'),
      USAGE_CACHE: path.join(cache, 'usage.json') } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

test('problem model requires explicit three-way classification', () => {
  for (const classification of [ACTION_REQUIRED, DIAGNOSTIC, HISTORY]) {
    assert.equal(problem({ classification, source: 'test', explanation: 'x' }).classification, classification);
  }
  assert.throws(() => problem({ source: 'test', explanation: 'x' }), /INVALID_PROBLEM_CLASSIFICATION/);
});

test('AUTH remains actionable with account and R repair path', () => {
  const usage = { updatedAtMs: now, accounts: { 'account-a': {
    refresh: { lastSuccessAt: now - 3_600_000, lastAttemptAt: now,
      lastErrorAt: now, errorKind: 'auth-401', httpStatus: 401, consecutiveFailures: 1 },
  } } };
  const main = render({ usage });
  assert.match(main, /ACTION REQUIRED:[\s\S]*a@example\.test[\s\S]*Press \[R\] to repair authentication/);
});

test('unverified rollout and retrying 5H warning appear only in diagnostics', () => {
  const states = {
    events: { version: 4, worker: { heartbeatAtMs: now, errorKind: null },
      activeTurns: {}, terminalTurns: [], files: {}, pendingErrors: {}, exhaustions: {},
      interruptedTurns: { one: { threadId: 'thread-one', turnId: 'turn-one',
        resumable: true, threadIdentityVerified: true, interruptionClass: 'INTERRUPTED_AFTER_WORK',
        classificationVerified: true } } },
    auto: { status: 'blocked', candidateBlocks: {
      '["thread-one","turn-one"]': { threadId: 'thread-one', reason: 'ROLLOUT_IDENTITY_UNVERIFIED' },
    } },
    activation: { enabled: true, worker: { heartbeatAtMs: now }, accounts: {
      'account-a': { phase: 'cooldown', errorKind: 'USAGE_HTTP_401', updatedAtMs: now },
    } },
  };
  const main = render(states);
  const diagnostics = render(states, true);
  assert.doesNotMatch(main, /ACTION REQUIRED:|ROLLOUT_IDENTITY_UNVERIFIED|USAGE_HTTP_401/);
  assert.match(main, /Diagnostics: \d+ \[D\]/);
  assert.match(diagnostics, /ROLLOUT_IDENTITY_UNVERIFIED/);
  assert.match(diagnostics, /USAGE_HTTP_401[\s\S]*waiting\/retry/);
  const viewport = layoutStatusFrame(diagnostics, { rows: 12, columns: 79, diagnostics: true });
  assert.match(viewport.lines.join('\n'), /DIAGNOSTICS \(/);
  assert.match(viewport.lines.at(-1), /\[D\] back/);
});

test('resolved continuation is history while uncertain committed send remains actionable', () => {
  const resolved = { attempts: { '["thread-done","turn-old"]': {
    threadId: 'thread-done', interruptedTurnId: 'turn-old', continuationTurnId: 'turn-new',
    status: 'MANUAL_REQUIRED_AFTER_COMMIT', errorKind: 'TURN_OBSERVER_DID_NOT_SETTLE',
    committedAtMs: now - 1000, completedAtMs: now, terminalStatus: 'completed',
  } } };
  assert.doesNotMatch(render({ resume: resolved }), /ACTION REQUIRED:/);
  assert.match(render({ resume: resolved }, true), /history\/resolved[\s\S]*TURN_OBSERVER_DID_NOT_SETTLE/);
  const uncertain = { attempts: { '["thread-unsafe","turn-old"]': {
    threadId: 'thread-unsafe', interruptedTurnId: 'turn-old',
    status: 'MANUAL_REQUIRED_AFTER_COMMIT', errorKind: 'APP_SERVER_TIMEOUT',
    committedAtMs: now,
  } } };
  assert.match(render({ resume: uncertain }), /ACTION REQUIRED:[\s\S]*thread-unsafe|ACTION REQUIRED:[\s\S]*APP_SERVER_TIMEOUT/);
});
