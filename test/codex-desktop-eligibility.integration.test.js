'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const threadId = '01a0e2d5-e5e2-74e1-9ad1-3194bda82e93';
const turnId = '01a0e463-9851-7ed2-9c87-52290cf748a9';
const key = JSON.stringify([threadId, turnId]);

test('legacy DESKTOP preference uses HEADLESS and repeated ticks do not start Desktop for unavailable turns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-eligibility-'));
  try {
    const home = path.join(root, 'codex');
    const cache = path.join(root, 'cache', 'codex-account-switcher');
    const config = path.join(root, 'config', 'codex-account-switcher');
    fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(config, { recursive: true });
    const now = Date.now();
    const write = (name, value) => fs.writeFileSync(path.join(cache, name), JSON.stringify(value));
    const candidate = { threadId, turnId, accountId: 'source', completedAtMs: now - 60_000,
      resumable: true, threadIdentityVerified: true, classificationVerified: true,
      interruptionClass: 'INTERRUPTED_AFTER_WORK' };
    fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({
      active_account_key: 'source-key', accounts: [
        { account_key: 'source-key', chatgpt_account_id: 'source', email: 'source@example.test' },
        { account_key: 'target-key', chatgpt_account_id: 'target', email: 'target@example.test' },
      ],
    }));
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'source' } }));
    const usage = (remainingPercent) => ({
      primary: { remainingPercent, resetsAt: (now + 3_600_000) / 1000 },
      secondary: { remainingPercent: 80, resetsAt: (now + 86_400_000) / 1000 },
      ordinaryUsageAllowedObserved: true, ordinaryUsageAllowed: remainingPercent > 0,
      refresh: { lastSuccessAt: now, errorKind: null, consecutiveFailures: 0 },
    });
    write('usage.json', { worker: { heartbeatAtMs: now },
      accounts: { source: usage(0), target: usage(70) } });
    write('turn-events.json', { version: 4, worker: { heartbeatAtMs: now, errorKind: null },
      activeTurns: {}, interruptedTurns: { [key]: candidate }, terminalTurns: [],
      pendingErrors: {}, exhaustions: { source: {
        verified: true, threadIdentityVerified: true, errorKind: 'usageLimitExceeded',
      } }, files: {} });
    write('manual-resume.json', { version: 2, attempts: {}, retiredCandidates: {} });
    write('continuation-drafts.json', { version: 1, claims: {} });
    write('auto-continue.json', { status: 'blocked', phase: 'starting continuation',
      errorKind: 'SOURCE_EXHAUSTION_CHANGED', actionRequired: true,
      candidateThreadId: threadId, candidateTurnId: turnId });
    const database = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    database.prepare('INSERT INTO threads VALUES (?, ?)').run(threadId, '/outside/rollout.jsonl');
    database.close();
    const marker = path.join(root, 'desktop-called');
    const launcher = path.join(root, 'desktop-launcher');
    fs.writeFileSync(launcher, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const preferences = path.join(config, 'status-preferences.json');
    const env = { ...process.env, HOME: root, CODEX_HOME: home,
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'config'),
      CODEX_EVENT_STATE: path.join(cache, 'turn-events.json'),
      CODEX_RESUME_STATE: path.join(cache, 'manual-resume.json'),
      CODEX_AUTO_CONTINUE_STATE: path.join(cache, 'auto-continue.json'),
      CODEX_DRAFT_JOURNAL: path.join(cache, 'continuation-drafts.json'),
      CODEX_STATUS_PREFERENCES: preferences,
      CODEX_OPERATION_LOCK_DIR: path.join(cache, 'exclusive-codex-operation.lock'),
      USAGE_CACHE: path.join(cache, 'usage.json'), CHATGPT_LAUNCHER: launcher };
    const tick = (reason = 'ROLLOUT_METADATA_UNVERIFIED') => {
      const result = spawnSync(process.execPath,
        [path.join(__dirname, '..', 'bin', 'codex-manual-resume'), '--auto'],
        { env, encoding: 'utf8', timeout: 5_000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const state = JSON.parse(fs.readFileSync(path.join(cache, 'auto-continue.json')));
      assert.equal(state.status, 'waiting');
      assert.equal(state.waitingReason, 'unavailable-candidates');
      assert.equal(state.errorKind, null);
      assert.equal(state.actionRequired, false);
      assert.equal(state.candidateThreadId, null);
      assert.equal(state.phase, null);
      assert.equal(state.candidateBlocks[key].reason, reason);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(path.join(cache, 'manual-resume.json.client-lease.json')), false);
      assert.equal(fs.existsSync(path.join(cache, 'exclusive-codex-operation.lock')), false);
      return state;
    };
    fs.writeFileSync(preferences, JSON.stringify({ version: 2, autoMode: 'DESKTOP', autoContinue: true }));
    const first = tick();
    assert.equal(first.errorKind, null);
    write('auto-continue.json', { ...first, status: 'blocked', phase: 'starting continuation',
      errorKind: 'SOURCE_EXHAUSTION_CHANGED', actionRequired: true,
      candidateThreadId: threadId, candidateTurnId: turnId });
    const activeEventsFile = path.join(cache, 'turn-events.json');
    const activeEvents = JSON.parse(fs.readFileSync(activeEventsFile));
    activeEvents.activeTurns = { ordinary: { threadId: 'ordinary-thread', turnId: 'ordinary-turn' } };
    fs.writeFileSync(activeEventsFile, JSON.stringify(activeEvents));
    const activeTick = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'bin', 'codex-manual-resume'), '--auto'],
      { env, encoding: 'utf8', timeout: 5_000 });
    assert.equal(activeTick.status, 0, activeTick.stderr || activeTick.error?.message);
    const waitingForTurn = JSON.parse(fs.readFileSync(path.join(cache, 'auto-continue.json')));
    assert.equal(waitingForTurn.waitingReason, 'active-turns');
    assert.equal(waitingForTurn.phase, null);
    assert.equal(waitingForTurn.errorKind, null);
    assert.equal(fs.existsSync(marker), false);
    activeEvents.activeTurns = {};
    fs.writeFileSync(activeEventsFile, JSON.stringify(activeEvents));
    fs.writeFileSync(preferences, JSON.stringify({ version: 2, autoMode: 'HEADLESS', autoContinue: true }));
    tick();
    fs.writeFileSync(preferences, JSON.stringify({ version: 2, autoMode: 'DESKTOP', autoContinue: true }));
    tick();
    tick();
    const sessions = path.join(home, 'sessions', '2026', '10', '13');
    fs.mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, `rollout-2026-10-13T12-00-00-${threadId}.jsonl`);
    fs.writeFileSync(rollout, [
      { type: 'session_meta', payload: { id: threadId } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId,
        error: { codex_error_info: 'usage_limit_exceeded' } } },
    ].map(JSON.stringify).join('\n') + '\n');
    const restoredDatabase = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    restoredDatabase.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(rollout, threadId);
    restoredDatabase.close();
    const eventsFile = path.join(cache, 'turn-events.json');
    const events = JSON.parse(fs.readFileSync(eventsFile));
    events.exhaustions = {};
    fs.writeFileSync(eventsFile, JSON.stringify(events));
    tick('SOURCE_EXHAUSTION_CHANGED');
    tick('SOURCE_EXHAUSTION_CHANGED');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cache, 'manual-resume.json'))).attempts, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
