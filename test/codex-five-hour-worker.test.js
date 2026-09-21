'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  activationWorkerHealth,
  runFiveHourActivationCycle,
} = require('../lib/codex-five-hour-worker');
const {
  assertAuthStateUnchanged,
  fingerprintAuthState,
} = require('../lib/codex-weekly-activation');

const NOW_MS = 1_800_000_000_000;
const ACCOUNT_ID = 'account-a';
const account = { chatgpt_account_id: ACCOUNT_ID, email: 'account-a@example.com' };

function usageCache({ dormant = true, quality = 'verified', observedAtMs = NOW_MS } = {}) {
  const resetAt = observedAtMs / 1000 + 18_000;
  const primary = dormant
    ? [
        { observedAtMs: observedAtMs - 6_000, serverObservedAtMs: observedAtMs - 6_000, usedPercent: 0, limitWindowSeconds: 18_000, resetAfterSeconds: 18_000, resetAt: resetAt - 6 },
        { observedAtMs, serverObservedAtMs: observedAtMs, usedPercent: 0, limitWindowSeconds: 18_000, resetAfterSeconds: 18_000, resetAt },
      ]
    : [
        { observedAtMs: observedAtMs - 6_000, serverObservedAtMs: observedAtMs - 6_000, usedPercent: 1, limitWindowSeconds: 18_000, resetAfterSeconds: 17_000, resetAt },
        { observedAtMs, serverObservedAtMs: observedAtMs, usedPercent: 1, limitWindowSeconds: 18_000, resetAfterSeconds: 16_994, resetAt },
      ];
  const lastSuccessAt = quality === 'verified' ? observedAtMs : observedAtMs - 20 * 60_000;
  return {
    worker: { heartbeatAtMs: observedAtMs },
    accounts: {
      [ACCOUNT_ID]: {
        primary: { remainingPercent: dormant ? 100 : 99, usedPercent: dormant ? 0 : 1, resetsAt: resetAt, windowSeconds: 18_000 },
        secondary: { remainingPercent: 50, usedPercent: 50, resetsAt: resetAt + 100_000, windowSeconds: 604_800 },
        observations: { primary, secondary: [] },
        refresh: { lastSuccessAt, lastAttemptAt: observedAtMs, errorKind: null, httpStatus: 200, consecutiveFailures: 0 },
      },
    },
  };
}

async function cycle({ cache = usageCache(), previousState = {}, activateAccount, nowMs = NOW_MS } = {}) {
  const persisted = [];
  const state = await runFiveHourActivationCycle({
    accounts: [account],
    usageCache: cache,
    previousState,
    activateAccount,
    persistState: async value => persisted.push(JSON.parse(JSON.stringify(value))),
    now: () => nowMs,
    createAttemptId: () => 'attempt-1',
  });
  return { state, persisted };
}

test('verified dormant account gets exactly one committed activation attempt', async () => {
  let calls = 0;
  const { state, persisted } = await cycle({
    activateAccount: async (_account, hooks) => {
      calls += 1;
      await hooks.beforeTurn();
      return { activatedResetAt: NOW_MS / 1000 + 18_000 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(state.accounts[ACCOUNT_ID].phase, 'succeeded');
  assert.equal(state.accounts[ACCOUNT_ID].lastSuccessAtMs, NOW_MS);
  assert.equal(state.accounts[ACCOUNT_ID].activatedResetAt, NOW_MS / 1000 + 18_000);
  assert.equal(persisted.some(saved => saved.accounts[ACCOUNT_ID]?.phase === 'turn-committed'), true);
});

test('concurrent registry activity metadata does not prevent recording activation success', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-registry-metadata-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'accounts'));
  fs.writeFileSync(path.join(root, 'auth.json'), '{"global":"unchanged"}');
  fs.writeFileSync(path.join(root, 'accounts', 'account-a.auth.json'), '{"snapshot":"unchanged"}');
  const registryPath = path.join(root, 'accounts', 'registry.json');
  const registry = {
    active_account_key: 'key-a',
    active_account_activated_at_ms: 123,
    accounts: [{
      account_key: 'key-a',
      chatgpt_account_id: ACCOUNT_ID,
      chatgpt_user_id: 'user-a',
      last_usage: { primary: { used_percent: 0 } },
      last_usage_at: 100,
      last_local_rollout: { path: '/tmp/old', event_timestamp_ms: 100 },
    }],
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const before = fingerprintAuthState(root);

  const { state } = await cycle({
    activateAccount: async (_account, hooks) => {
      await hooks.beforeTurn();
      registry.accounts[0].last_usage.primary.used_percent = 1;
      registry.accounts[0].last_usage_at = 200;
      registry.accounts[0].last_local_rollout = { path: '/tmp/new', event_timestamp_ms: 200 };
      fs.writeFileSync(registryPath, JSON.stringify(registry));
      assertAuthStateUnchanged(before, fingerprintAuthState(root));
      return { activatedResetAt: NOW_MS / 1000 + 18_000 };
    },
  });
  assert.equal(state.accounts[ACCOUNT_ID].phase, 'succeeded');
  assert.equal(state.accounts[ACCOUNT_ID].lastSuccessAtMs, NOW_MS);
  assert.equal(state.accounts[ACCOUNT_ID].activatedResetAt, NOW_MS / 1000 + 18_000);
});

test('stale or unverified dormant-looking data never triggers activation', async () => {
  let calls = 0;
  const { state } = await cycle({
    cache: usageCache({ quality: 'unverified' }),
    activateAccount: async () => { calls += 1; },
    nowMs: NOW_MS,
  });
  assert.equal(calls, 0);
  assert.equal(state.accounts[ACCOUNT_ID], undefined);
});

test('ranking, active account marker and weekly state do not gate a verified dormant 5H window', async () => {
  let calls = 0;
  const decoratedAccount = { ...account, active: false, rank: 99, recommended: false };
  const cache = usageCache();
  cache.accounts[ACCOUNT_ID].secondary = {
    remainingPercent: 0,
    usedPercent: 100,
    resetsAt: NOW_MS / 1000 + 1,
    windowSeconds: 604_800,
  };
  await runFiveHourActivationCycle({
    accounts: [decoratedAccount],
    usageCache: cache,
    activateAccount: async (_target, hooks) => {
      calls += 1;
      await hooks.beforeTurn();
      return { activatedResetAt: NOW_MS / 1000 + 18_000 };
    },
    now: () => NOW_MS,
    createAttemptId: () => 'attempt-independent',
  });
  assert.equal(calls, 1);
});

test('per-account observation hold skips only the matching stable identity', async () => {
  const otherAccountId = 'account-b';
  const cache = usageCache();
  cache.accounts[otherAccountId] = JSON.parse(JSON.stringify(cache.accounts[ACCOUNT_ID]));
  const activated = [];
  const state = await runFiveHourActivationCycle({
    accounts: [account, { chatgpt_account_id: otherAccountId, email: 'account-b@example.com' }],
    usageCache: cache,
    activationHoldForAccount: candidate => candidate.chatgpt_account_id === ACCOUNT_ID
      ? { reason: 'weekly-observation' }
      : null,
    activateAccount: async (target, hooks) => {
      activated.push(target.chatgpt_account_id);
      await hooks.beforeTurn();
      return { activatedResetAt: NOW_MS / 1000 + 18_000 };
    },
    now: () => NOW_MS,
    createAttemptId: () => 'attempt-hold-test',
  });
  assert.deepEqual(activated, [otherAccountId]);
  assert.equal(state.accounts[ACCOUNT_ID].phase, 'held');
  assert.equal(state.accounts[ACCOUNT_ID].holdReason, 'weekly-observation');
  assert.equal(state.accounts[ACCOUNT_ID].actionRequired, false);
  assert.equal(state.accounts[otherAccountId].phase, 'succeeded');
});

test('observation hold preserves no-retry journal states for a dormant account', async () => {
  for (const phase of ['succeeded', 'blocked', 'turn-committed']) {
    const prior = { phase, attemptId: 'previous-turn', actionRequired: phase === 'blocked' };
    const state = await runFiveHourActivationCycle({
      accounts: [account],
      usageCache: usageCache(),
      previousState: { accounts: { [ACCOUNT_ID]: prior } },
      activationHoldForAccount: () => ({ reason: 'weekly-observation' }),
      activateAccount: async () => { assert.fail('a held account must not activate'); },
      now: () => NOW_MS,
    });
    assert.deepEqual(state.accounts[ACCOUNT_ID], prior);
  }
});

test('successful dormant window is single-flight until verified active state is observed', async () => {
  let calls = 0;
  const previousState = {
    enabled: true,
    accounts: { [ACCOUNT_ID]: { phase: 'succeeded', activatedResetAt: NOW_MS / 1000 + 18_000 } },
  };
  await cycle({
    previousState,
    activateAccount: async () => { calls += 1; },
  });
  assert.equal(calls, 0);

  const active = await cycle({
    cache: usageCache({ dormant: false }),
    previousState,
    activateAccount: async () => { calls += 1; },
  });
  assert.equal(active.state.accounts[ACCOUNT_ID].phase, 'idle');
});

test('crash or ambiguity after turn commit blocks all automatic retries for that window', async () => {
  let calls = 0;
  const first = await cycle({
    activateAccount: async (_account, hooks) => {
      calls += 1;
      await hooks.beforeTurn();
      throw new Error('FIVE_HOUR_ACTIVATION_NOT_VERIFIED');
    },
  });
  assert.equal(first.state.accounts[ACCOUNT_ID].phase, 'blocked');
  assert.equal(first.state.accounts[ACCOUNT_ID].actionRequired, true);

  await cycle({
    previousState: first.state,
    activateAccount: async () => { calls += 1; },
  });
  assert.equal(calls, 1);
});

test('auth identity change after turn commit records safe diagnostics and never retries', async () => {
  let calls = 0;
  const changed = new Error('GLOBAL_AUTH_STATE_CHANGED');
  changed.authStateChanges = [
    'registry.activeAccountKey',
    'auth.globalAuthHash',
    'unsafe.secret:value',
  ];
  const first = await cycle({
    activateAccount: async (_account, hooks) => {
      calls += 1;
      await hooks.beforeTurn();
      throw changed;
    },
  });
  assert.equal(first.state.accounts[ACCOUNT_ID].phase, 'blocked');
  assert.equal(first.state.accounts[ACCOUNT_ID].errorKind, 'GLOBAL_AUTH_STATE_CHANGED');
  assert.deepEqual(first.state.accounts[ACCOUNT_ID].diagnosticFields, [
    'auth.globalAuthHash',
    'registry.activeAccountKey',
  ]);

  await cycle({
    previousState: first.state,
    activateAccount: async () => { calls += 1; },
  });
  assert.equal(calls, 1);
});

test('persisted turn-committed state after a crash is converted to blocked without retry', async () => {
  let calls = 0;
  const previousState = {
    enabled: true,
    accounts: { [ACCOUNT_ID]: { phase: 'turn-committed', attemptId: 'crashed-attempt' } },
  };
  const result = await cycle({
    previousState,
    activateAccount: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.state.accounts[ACCOUNT_ID].phase, 'blocked');
  assert.equal(result.state.accounts[ACCOUNT_ID].errorKind, 'INTERRUPTED_AFTER_TURN_COMMIT');
});

test('state changing during fresh pre-turn revalidation stops with zero turns and cooldown', async () => {
  let turns = 0;
  const result = await cycle({
    activateAccount: async () => {
      throw new Error('ACCOUNT_NOT_FIVE_HOUR_DORMANT');
    },
  });
  assert.equal(turns, 0);
  assert.equal(result.state.accounts[ACCOUNT_ID].phase, 'cooldown');
  assert.equal(result.state.accounts[ACCOUNT_ID].turnSentOrUncertain, false);
});

test('worker heartbeat and fatal state are observable', () => {
  assert.equal(activationWorkerHealth({ enabled: true, worker: { heartbeatAtMs: NOW_MS } }, NOW_MS).healthy, true);
  assert.equal(activationWorkerHealth({ enabled: true, worker: { heartbeatAtMs: NOW_MS - 4 * 60_000 } }, NOW_MS).healthy, false);
  assert.equal(activationWorkerHealth({ enabled: true, worker: { heartbeatAtMs: NOW_MS, fatalErrorKind: 'WORKER_FATAL' } }, NOW_MS).healthy, false);
});

test('unknown errors are reduced to a credential-free diagnostic code', () => {
  const { safeErrorKind } = require('../lib/codex-five-hour-worker');
  assert.equal(safeErrorKind(new Error('server response contained secret material')), 'UNEXPECTED_ERROR');
  assert.equal(safeErrorKind(new Error('USAGE_HTTP_401')), 'USAGE_HTTP_401');
});

test('corrupt persistent state is preserved and stops the worker fail closed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-worker-corrupt-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'five-hour-activation.json');
  const invalidState = '{"accounts":{"possibly-committed":';
  fs.writeFileSync(stateFile, invalidState, { mode: 0o600 });
  const worker = path.join(__dirname, '..', 'bin', 'codex-five-hour-activation-worker');
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [worker], {
    env: {
      ...childEnvironment,
      CODEX_HOME: path.join(root, 'codex-home'),
      XDG_CACHE_HOME: root,
      FIVE_HOUR_ACTIVATION_STATE: stateFile,
      USAGE_CACHE: path.join(root, 'usage.json'),
      USAGE_REFRESHER: '/bin/true',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), invalidState);
});
