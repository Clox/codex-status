'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { headlessStoragePreflight } = require('../lib/codex-headless-storage-preflight');

const THREAD = '01a11380-6142-7870-ad8e-2c97dcba496e';
const FAILED = '01a12ce7-a639-7dd2-a733-66cae213d206';
const quota = { codex_error_info: 'usage_limit_exceeded' };
const candidate = [{ threadId: THREAD, turnId: FAILED }];

function record(type, payload, second) {
  return { timestamp: new Date(Date.UTC(2026, 9, 11, 12, 0, second)).toISOString(), type, payload };
}

function segment(home, name, turns, start = 0, id = THREAD) {
  const directory = path.join(home, 'sessions', '2026', '10', '11');
  fs.mkdirSync(directory, { recursive: true });
  const records = [record('session_meta', { id }, start)];
  let second = start + 1;
  for (const [turnId, error = null] of turns) {
    records.push(record('event_msg', { type: 'task_started', turn_id: turnId }, second++));
    records.push(record('event_msg', { type: 'task_complete', turn_id: turnId, error }, second++));
  }
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, `${records.map(JSON.stringify).join('\n')}\n`);
  return filename;
}

function databases(home, current, projectedTurn = null) {
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD, current);
  db.close();
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT)');
  if (projectedTurn) history.prepare('INSERT INTO thread_turns VALUES (?, ?)').run(THREAD, projectedTurn);
  history.close();
}

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preflight-'));
  try { await run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

async function reason(home, turnId = FAILED) {
  const result = await headlessStoragePreflight(home, [{ ...candidate[0], turnId }]);
  return result.ok ? null : result.reason;
}

test('classic rollout and suffix segment both resolve exact failed turn', async () => withHome(async home => {
  const classic = segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [[FAILED, quota]]);
  databases(home, classic);
  assert.equal(await reason(home), null);
  fs.rmSync(path.join(home, 'state_5.sqlite'));
  fs.renameSync(classic, path.join(path.dirname(classic),
    `rollout-2026-10-11T12-00-00-${THREAD}_next.jsonl`));
  assert.equal(await reason(home), null);
}));

test('old and new verified segments use current metadata and find failed turn in new segment',
  async () => withHome(async home => {
    segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [['old-turn']], 0);
    const current = segment(home, `rollout-2026-10-11T12-00-10-${THREAD}_next.jsonl`,
      [[FAILED, quota]], 10);
    databases(home, current, 'old-turn');
    assert.equal(await reason(home), null);
    assert.equal(await reason(home, 'absent-turn'), 'FAILED_TURN_NOT_FOUND');
  }));

test('multiple verified segments are ordered by timestamps, independent of directory order',
  async () => withHome(async home => {
    segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [['old-turn']], 0);
    segment(home, `rollout-2026-10-11T12-00-10-${THREAD}_middle.jsonl`, [['middle-turn']], 10);
    const current = segment(home, `rollout-2026-10-11T12-00-20-${THREAD}_latest.jsonl`,
      [[FAILED, quota]], 20);
    databases(home, current);
    assert.equal(await reason(home), null);
  }));

test('mismatched session_meta fails closed even when metadata points at the file',
  async () => withHome(async home => {
    const current = segment(home, `rollout-2026-10-11T12-00-00-${THREAD}_next.jsonl`,
      [[FAILED, quota]], 0, 'other-thread');
    databases(home, current);
    assert.equal(await reason(home), 'THREAD_ID_MISMATCH');
  }));

test('duplicate failed turn across segments is ambiguous', async () => withHome(async home => {
  segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [[FAILED, quota]], 0);
  const current = segment(home, `rollout-2026-10-11T12-00-10-${THREAD}_next.jsonl`,
    [[FAILED, null]], 10);
  databases(home, current);
  assert.equal(await reason(home), 'FAILED_TURN_AMBIGUOUS');
}));

test('conflicting completions of the failed turn are ambiguous', async () => withHome(async home => {
  const current = segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`,
    [[FAILED, quota]], 0);
  fs.appendFileSync(current, `${JSON.stringify(record('event_msg', {
    type: 'task_complete', turn_id: FAILED, error: null,
  }, 3))}\n`);
  databases(home, current);
  assert.equal(await reason(home), 'FAILED_TURN_AMBIGUOUS');
}));

test('later turn makes failed turn stale', async () => withHome(async home => {
  segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [[FAILED, quota]], 0);
  const current = segment(home, `rollout-2026-10-11T12-00-10-${THREAD}_next.jsonl`,
    [['later-turn']], 10);
  databases(home, current);
  assert.equal(await reason(home), 'FAILED_TURN_NOT_LATEST');
}));

test('overlapping segment timestamps fail closed', async () => withHome(async home => {
  segment(home, `rollout-2026-10-11T12-00-00-${THREAD}.jsonl`, [[FAILED, quota]], 0);
  const current = segment(home, `rollout-2026-10-11T12-00-01-${THREAD}_next.jsonl`,
    [['other-turn']], 1);
  databases(home, current);
  assert.equal(await reason(home), 'ROLLOUT_ORDER_UNVERIFIED');
}));
