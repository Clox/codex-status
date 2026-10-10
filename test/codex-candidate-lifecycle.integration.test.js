'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('HEADLESS retires a due missing candidate while waiting for unrelated active turns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-retire-controller-'));
  try {
    const home = path.join(root, 'codex');
    const cache = path.join(root, 'cache', 'codex-account-switcher');
    const config = path.join(root, 'config', 'codex-account-switcher');
    fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(config, { recursive: true });
    const now = Date.now();
    const candidate = { threadId: 'thread-old', turnId: 'turn-failed', accountId: 'account-a',
      completedAtMs: now - 15 * 86_400_000, resumable: true, threadIdentityVerified: true,
      classificationVerified: true, interruptionClass: 'INTERRUPTED_AFTER_WORK',
      threadSource: 'user', status: 'failed', errorKind: 'usagelimitexceeded' };
    const key = JSON.stringify([candidate.threadId, candidate.turnId]);
    fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({
      accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' }],
    }));
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    fs.writeFileSync(path.join(cache, 'usage.json'), '{}');
    fs.writeFileSync(path.join(config, 'status-preferences.json'), JSON.stringify({ version: 2,
      autoMode: 'HEADLESS', autoContinue: true }));
    fs.writeFileSync(path.join(cache, 'turn-events.json'), JSON.stringify({ version: 4,
      worker: { heartbeatAtMs: now, errorKind: null }, files: {},
      activeTurns: { unrelated: { threadId: 'thread-running', turnId: 'turn-running' } },
      interruptedTurns: { [key]: candidate }, terminalTurns: [], pendingErrors: {}, exhaustions: {},
    }));
    fs.writeFileSync(path.join(cache, 'manual-resume.json'), JSON.stringify({ version: 2,
      attempts: {}, retiredCandidates: {}, retirementHistory: [] }));
    fs.writeFileSync(path.join(cache, 'continuation-drafts.json'), JSON.stringify({ version: 1, claims: {} }));
    fs.writeFileSync(path.join(cache, 'auto-continue.json'), JSON.stringify({ status: 'waiting',
      waitingReason: 'active-turns', candidateBlocks: { [key]: {
        threadId: candidate.threadId, failedTurnId: candidate.turnId,
        reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
        firstSeenAtMs: now - 8 * 86_400_000,
        continuousMissingSinceMs: now - 8 * 86_400_000,
        lastSeenAtMs: now - 30_000,
      } } }));
    const run = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'bin', 'codex-manual-resume'), '--auto'], {
        env: { ...process.env, HOME: root, CODEX_HOME: home,
          XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'config'),
          CODEX_EVENT_STATE: path.join(cache, 'turn-events.json'),
          CODEX_RESUME_STATE: path.join(cache, 'manual-resume.json'),
          CODEX_AUTO_CONTINUE_STATE: path.join(cache, 'auto-continue.json'),
          CODEX_DRAFT_JOURNAL: path.join(cache, 'continuation-drafts.json'),
          CODEX_STATUS_PREFERENCES: path.join(config, 'status-preferences.json'),
          CODEX_OPERATION_LOCK_DIR: path.join(cache, 'exclusive-codex-operation.lock'),
          USAGE_CACHE: path.join(cache, 'usage.json') },
        encoding: 'utf8', timeout: 5_000,
      });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const journal = JSON.parse(fs.readFileSync(path.join(cache, 'manual-resume.json')));
    const auto = JSON.parse(fs.readFileSync(path.join(cache, 'auto-continue.json')));
    assert.ok(journal.retiredCandidates[key], JSON.stringify({ auto, journal, stderr: run.stderr }));
    assert.equal(journal.retirementHistory[0].reason, 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME');
    assert.deepEqual(journal.attempts, {});
    assert.equal(auto.status, 'waiting');
    assert.equal(auto.waitingReason, 'active-turns');
    assert.equal(auto.pending, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
