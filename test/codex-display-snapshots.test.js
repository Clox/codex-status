'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { displayMetadata, pruneDisplaySnapshots, updateDisplaySnapshot } =
  require('../lib/codex-display-snapshots');
const { formatInterruptedCandidate, partitionInterruptedCandidates } =
  require('../lib/codex-interrupted-label');
const { turnKey } = require('../lib/codex-turn-observer');
const { locations, createInstance } = require('../lib/codex-instances');

const THREAD = '01a0e2d5-e5e2-74e1-9ad1-3194bda82e93';
const TURN = '01a0e463-9851-7ed2-9c87-52290cf748a9';

function renderStatus(root, env, inputFile) {
  const outputFile = path.join(root, 'status-output');
  const errorFile = path.join(root, 'status-error');
  const descriptors = [fs.openSync(inputFile, 'r'), fs.openSync(outputFile, 'w'),
    fs.openSync(errorFile, 'w')];
  let result;
  try {
    result = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'bin', 'codex-usage-annotate')],
      { env, stdio: descriptors, timeout: 5_000 });
  } finally {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
  }
  return { ...result, stdout: fs.readFileSync(outputFile, 'utf8'),
    stderr: fs.readFileSync(errorFile, 'utf8') };
}

test('empty and lower-quality metadata cannot erase a verified name; better DB metadata upgrades it', () => {
  const first = updateDisplaySnapshot({}, THREAD, { cwd: '/work/tablance' },
    'rollout-session-meta', 100);
  const named = updateDisplaySnapshot(first, THREAD,
    { name: 'Förbättra blankettvyn', title: 'Earlier prompt', projectName: 'Spadrig' },
    'thread-db', 200);
  const empty = updateDisplaySnapshot(named, THREAD,
    { name: '  ', title: null, projectName: '', cwd: '' }, 'thread-db', 300);
  assert.equal(empty, named);
  assert.equal(empty.displaySnapshots[THREAD].capturedAt, 200);
  const lower = updateDisplaySnapshot(empty, THREAD, { cwd: '/work/worse' },
    'rollout-session-meta', 400);
  assert.equal(lower, empty);
  const better = updateDisplaySnapshot(lower, THREAD, { name: 'Ny förbättrad titel' },
    'thread-db', 500);
  assert.equal(better.displaySnapshots[THREAD].threadName, 'Ny förbättrad titel');
  assert.equal(better.displaySnapshots[THREAD].projectName, 'Spadrig');
  assert.equal(better.displaySnapshots[THREAD].capturedAt, 500);
  assert.equal(better.displaySnapshots[THREAD].source, 'thread-db');
  assert.equal(better.displaySnapshots[THREAD].fieldSources.cwd, 'rollout-session-meta');
});

test('verified observer title is retained until a thread-db name becomes available', () => {
  const observed = updateDisplaySnapshot({}, THREAD, { threadTitle: 'Observer title' },
    'observer-title', 100);
  assert.equal(observed.displaySnapshots[THREAD].threadTitle, 'Observer title');
  const empty = updateDisplaySnapshot(observed, THREAD, { threadTitle: ' ' },
    'observer-title', 200);
  assert.equal(empty, observed);
  const upgraded = updateDisplaySnapshot(observed, THREAD, { name: 'Named thread' },
    'thread-db', 300);
  assert.equal(displayMetadata(upgraded.displaySnapshots[THREAD]).threadName, 'Named thread');
  assert.equal(upgraded.displaySnapshots[THREAD].threadTitle, 'Observer title');
});

test('an equally worded stronger source upgrades field provenance and resists later fallback', () => {
  const observed = updateDisplaySnapshot({}, THREAD, { threadTitle: 'Navigation' },
    'observer-title', 100);
  const confirmed = updateDisplaySnapshot(observed, THREAD, { title: 'Navigation' },
    'thread-db', 200);
  assert.equal(confirmed.displaySnapshots[THREAD].fieldSources.threadTitle, 'thread-db');
  const weaker = updateDisplaySnapshot(confirmed, THREAD, { threadTitle: 'Older fallback' },
    'observer-title', 300);
  assert.equal(weaker.displaySnapshots[THREAD].threadTitle, 'Navigation');
  const empties = updateDisplaySnapshot(weaker, THREAD,
    { threadName: '', name: 'Verified name', projectName: '', rootProjectName: 'Spadrig' },
    'thread-db', 400);
  assert.equal(empties.displaySnapshots[THREAD].threadName, 'Verified name');
  assert.equal(empties.displaySnapshots[THREAD].projectName, 'Spadrig');
});

test('active and interrupted turns use the same snapshot after DB and rollout disappear', () => {
  const snapshot = updateDisplaySnapshot({}, THREAD, {
    name: 'Förbättra blankettvyn', projectName: 'Spadrig', cwd: '/work/spadrig',
  }, 'thread-db', 100).displaySnapshots[THREAD];
  const metadata = displayMetadata(snapshot, {});
  for (const state of ['running', 'quota-interrupted-after-work']) {
    const line = formatInterruptedCandidate({ threadId: THREAD, turnId: TURN },
      'ogggan@gmail.com', metadata, state, 120);
    assert.equal(line,
      `ogggan@gmail.com | Spadrig · Förbättra blankettvyn | …bda82e93 | ${state}`);
  }
  assert.equal(formatInterruptedCandidate({ threadId: THREAD, turnId: TURN },
    'ogggan@gmail.com', displayMetadata(null, {}), 'running', 120),
  'ogggan@gmail.com | …bda82e93 | running');
});

test('snapshots survive while active, interrupted, retired or diagnostic history refers to thread', () => {
  const state = updateDisplaySnapshot({ activeTurns: {}, interruptedTurns: {}, terminalTurns: [] },
    THREAD, { name: 'Saved' }, 'thread-db', 100);
  assert.ok(pruneDisplaySnapshots(state, { retiredCandidates: {
    [turnKey(THREAD, TURN)]: { threadId: THREAD, turnId: TURN },
  } }, 0).displaySnapshots[THREAD]);
  assert.ok(pruneDisplaySnapshots(state, { retirementHistory: [{ threadId: THREAD }] }, 0)
    .displaySnapshots[THREAD]);
  assert.ok(pruneDisplaySnapshots({ ...state, activeTurns: { one: { threadId: THREAD } } }, {}, 0)
    .displaySnapshots[THREAD]);
  assert.ok(pruneDisplaySnapshots({ ...state, interruptedTurns: { one: { threadId: THREAD } } }, {}, 0)
    .displaySnapshots[THREAD]);
  assert.equal(pruneDisplaySnapshots(state, {}, 0).displaySnapshots[THREAD], undefined);
});

test('account rows mark every instance-active account in bold and leave unused accounts plain', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-instance-markers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  const accounts = [
    { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'a@example.test' },
    { account_key: 'key-b', chatgpt_account_id: 'account-b', email: 'b@example.test' },
    { account_key: 'key-c', chatgpt_account_id: 'account-c', email: 'c@example.test' },
  ];
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({
    active_account_key: 'key-a', accounts,
  }));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a' } }));
  const env = { ...process.env, HOME: root, CODEX_HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), CODEX_STATUS_COLUMNS: '110',
    CODEX_EVENT_STATE: path.join(root, 'events.json'),
    CODEX_RESUME_STATE: path.join(root, 'resume.json'),
    CODEX_AUTO_CONTINUE_STATE: path.join(root, 'auto.json'),
    CODEX_STATUS_PREFERENCES: path.join(root, 'preferences.json'),
    CODEX_ACCOUNT_SWITCH_STATE: path.join(root, 'switch.json'),
    USAGE_CACHE: path.join(root, 'usage.json'),
    RESET_CREDITS_CACHE: path.join(root, 'reset-credits.json') };
  const b = createInstance('rosetta', 'Rosetta', locations(env), env);
  const inputFile = path.join(root, 'input');
  fs.writeFileSync(inputFile, [
    '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY',
    ' *01 a@example.test    Plus  -             -               Now',
    '  02 b@example.test    Plus  -             -               Now',
    ' *03 c@example.test    Plus  -             -               Now',
  ].join('\n'));
  const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '');
  const rows = frame => frame.split('\n').filter(line => /^[ *]0[1-3] /.test(plain(line)));
  const one = rows(renderStatus(root, env, inputFile).stdout);
  assert.equal(one.length, 3);
  assert.match(one[0], /^\x1b\[1m/);
  assert.match(plain(one[0]), /^\*01 /);
  assert.match(plain(one[1]), /^ 02 /);
  assert.match(plain(one[2]), /^ 03 /);
  assert.doesNotMatch(one[1], /^\x1b\[1m/);
  assert.doesNotMatch(one[2], /^\x1b\[1m/);

  fs.mkdirSync(path.join(b.codexHome, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(b.codexHome, 'accounts', 'registry.json'), JSON.stringify({
    active_account_key: 'key-b', accounts: [accounts[1]],
  }));
  fs.writeFileSync(path.join(b.codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-b' } }));
  const two = rows(renderStatus(root, env, inputFile).stdout);
  assert.match(two[0], /^\x1b\[1m/);
  assert.match(two[1], /^\x1b\[1m/);
  assert.match(plain(two[0]), /^\*01 /);
  assert.match(plain(two[1]), /^\*02 /);
  assert.match(plain(two[2]), /^ 03 /);
  assert.doesNotMatch(two[2], /^\x1b\[1m/);
  assert.match(renderStatus(root, env, inputFile).stdout, /Rosetta · key-b · stopped/);
});

test('observer captures candidate display metadata at creation and preserves it after sources disappear', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-display-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  const sessions = path.join(home, 'sessions', '2026', '10', '11');
  const registry = path.join(home, 'accounts');
  const cache = path.join(root, 'cache');
  const statePath = path.join(cache, 'codex-account-switcher', 'turn-events.json');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(path.join(registry, 'registry.json'), JSON.stringify({
    active_account_key: 'key-a',
    accounts: [{ account_key: 'key-a', chatgpt_account_id: 'account-a' }],
  }));
  const database = path.join(home, 'state_5.sqlite');
  const dbSetup = spawnSync('sqlite3', [database, `
    CREATE TABLE projects(id TEXT, name TEXT);
    CREATE TABLE project_roots(path TEXT, project_id TEXT);
    CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT, git_origin_url TEXT, project_id TEXT);
    INSERT INTO projects VALUES ('project-a', 'Spadrig');
    INSERT INTO project_roots VALUES ('/work/spadrig', 'project-a');
    INSERT INTO threads VALUES ('${THREAD}', 'Förbättra blankettvyn', 'Första prompten',
      '/work/spadrig', NULL, 'project-a');
  `], { encoding: 'utf8' });
  assert.equal(dbSetup.status, 0, dbSetup.stderr);
  fs.writeFileSync(statePath, JSON.stringify({ version: 4, worker: {}, files: {}, activeTurns: {},
    pendingErrors: {}, exhaustions: {}, interruptedTurns: {}, terminalTurns: [] }));
  const rollout = path.join(sessions, `rollout-${THREAD}.jsonl`);
  const now = Date.now();
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta',
    payload: { id: THREAD, cwd: '/work/spadrig' } })}\n`);
  const env = { ...process.env, HOME: root, CODEX_HOME: home, XDG_CACHE_HOME: cache,
    CODEX_EVENT_STATE: statePath, USAGE_CACHE: path.join(cache, 'usage.json'),
    PATH: '/usr/bin:/bin',
  };
  const run = () => spawnSync(process.execPath,
    [path.join(__dirname, '..', 'bin', 'codex-turn-observer'), '--once'],
    { env, encoding: 'utf8' });
  assert.equal(run().status, 0);
  fs.appendFileSync(rollout, `${JSON.stringify({ type: 'event_msg',
    timestamp: new Date(now).toISOString(), payload: { type: 'task_started',
      turn_id: TURN, started_at: now } })}\n`);
  assert.equal(run().status, 0);
  let state = JSON.parse(fs.readFileSync(statePath));
  assert.ok(state.activeTurns[turnKey(THREAD, TURN)]);
  assert.equal(state.displaySnapshots[THREAD].threadName, 'Förbättra blankettvyn');
  assert.equal(state.displaySnapshots[THREAD].projectName, 'Spadrig');
  fs.appendFileSync(rollout, [
    { type: 'event_msg', timestamp: new Date(now + 1).toISOString(),
      payload: { type: 'task_complete', turn_id: TURN, completed_at: now + 1,
        error: { codex_error_info: 'usage_limit_exceeded' } } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(run().status, 0);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.ok(state.interruptedTurns[turnKey(THREAD, TURN)]);
  assert.equal(state.displaySnapshots[THREAD].threadName, 'Förbättra blankettvyn');
  assert.equal(state.displaySnapshots[THREAD].projectName, 'Spadrig');
  fs.rmSync(database);
  fs.rmSync(rollout);
  assert.equal(run().status, 0);
  state = JSON.parse(fs.readFileSync(statePath));
  assert.equal(state.displaySnapshots[THREAD].threadName, 'Förbättra blankettvyn');
});

test('status renders one persisted snapshot for active and interrupted rows without metadata sources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-display-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  const registry = path.join(home, 'accounts');
  const events = path.join(root, 'events.json');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, 'registry.json'), JSON.stringify({ accounts: [
    { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'ogggan@gmail.com' },
  ] }));
  const snapshot = updateDisplaySnapshot({}, THREAD,
    { name: 'Förbättra blankettvyn', projectName: 'Spadrig' }, 'thread-db', Date.now());
  const base = { version: 4, worker: { heartbeatAtMs: Date.now(), errorKind: null },
    files: {}, pendingErrors: {}, exhaustions: {}, terminalTurns: [],
    displaySnapshots: snapshot.displaySnapshots };
  const input = '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY\n'
    + '  01 ogggan@gmail.com Plus  -             -               Now\n';
  const inputFile = path.join(root, 'status-input');
  fs.writeFileSync(inputFile, input);
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_EVENT_STATE: events,
    CODEX_STATUS_PREFERENCES: path.join(root, 'preferences.json'),
    CODEX_RESUME_STATE: path.join(root, 'resume.json'),
    CODEX_AUTO_CONTINUE_STATE: path.join(root, 'auto.json'),
    CODEX_STATUS_COLUMNS: '110' };
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2, autoMode: 'OFF' }));
  const render = () => renderStatus(root, env, inputFile);
  fs.writeFileSync(events, JSON.stringify({ ...base, activeTurns: {
    [turnKey(THREAD, 'live-turn')]: { threadId: THREAD, turnId: 'live-turn',
      accountId: 'account-a', startedAtMs: Date.now() },
  }, interruptedTurns: {} }));
  let result = render();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /ACTIVE CODEX TURNS:[\s\S]*Spadrig · Förbättra blankettvyn \| …bda82e93 \| running/);
  fs.writeFileSync(events, JSON.stringify({ ...base, activeTurns: {}, interruptedTurns: {
    [turnKey(THREAD, TURN)]: { threadId: THREAD, turnId: TURN,
      accountId: 'account-a', completedAtMs: Date.now(), resumable: true,
      threadIdentityVerified: true, interruptionClass: 'INTERRUPTED_AFTER_WORK' },
  } }));
  result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout,
    /INTERRUPTED CODEX TURNS:[\s\S]*Spadrig · Förbättra blankettvyn \| …bda82e93 \| quota-interrupted-after-work/);
});

test('unavailable turns use a separate section, exact blocks, ID fallback, and retirement removes the row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-unavailable-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  const events = path.join(root, 'events.json');
  const resume = path.join(root, 'resume.json');
  const auto = path.join(root, 'auto.json');
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({ accounts: [
    { account_key: 'key-a', chatgpt_account_id: 'account-a', email: 'ogggan@gmail.com' },
  ] }));
  const secondThread = '01a0e2d5-e5e2-74e1-9ad1-3194bda82e94';
  const secondTurn = '01a0e463-9851-7ed2-9c87-52290cf748aa';
  const candidate = (threadId, turnId) => ({ threadId, turnId, accountId: 'account-a',
    completedAtMs: Date.now(), resumable: true, threadIdentityVerified: true,
    interruptionClass: 'INTERRUPTED_AFTER_WORK' });
  const oldKey = turnKey(THREAD, TURN);
  const newKey = turnKey(secondThread, secondTurn);
  const snapshot = updateDisplaySnapshot({}, THREAD,
    { name: 'Förbättra blankettvyn', projectName: 'Spadrig' }, 'thread-db', Date.now());
  fs.writeFileSync(events, JSON.stringify({ version: 4,
    worker: { heartbeatAtMs: Date.now(), errorKind: null }, files: {},
    activeTurns: {}, interruptedTurns: {
      [oldKey]: candidate(THREAD, TURN), [newKey]: candidate(secondThread, secondTurn),
    }, terminalTurns: [], pendingErrors: {}, exhaustions: {},
    displaySnapshots: snapshot.displaySnapshots }));
  fs.writeFileSync(auto, JSON.stringify({ candidateBlocks: { [oldKey]: {
    threadId: THREAD, failedTurnId: TURN, actionRequired: false,
    reason: 'ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
  } } }));
  const input = '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY\n'
    + '  01 ogggan@gmail.com Plus  -             -               Now\n';
  const inputFile = path.join(root, 'status-input');
  fs.writeFileSync(inputFile, input);
  const env = { ...process.env, HOME: root, CODEX_HOME: home, CODEX_EVENT_STATE: events,
    CODEX_STATUS_PREFERENCES: path.join(root, 'preferences.json'),
    CODEX_RESUME_STATE: resume, CODEX_AUTO_CONTINUE_STATE: auto,
    CODEX_STATUS_COLUMNS: '110' };
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2, autoMode: 'OFF' }));
  const render = () => renderStatus(root, env, inputFile);
  fs.writeFileSync(resume, JSON.stringify({ attempts: {}, retiredCandidates: {} }));
  let result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /INTERRUPTED CODEX TURNS:[\s\S]*…bda82e94 \| quota-interrupted-after-work/);
  assert.match(result.stdout, /UNAVAILABLE INTERRUPTED TURNS:[\s\S]*Spadrig · Förbättra blankettvyn \| …bda82e93 \| rollout missing · awaiting retirement/);
  assert.doesNotMatch(result.stdout, /AUTO-CONTINUE BLOCKED[^\n]*ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME/);
  assert.doesNotMatch(result.stdout.split('UNAVAILABLE INTERRUPTED TURNS:')[0], /…bda82e93/);
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2, autoMode: 'HEADLESS' }));
  fs.writeFileSync(auto, JSON.stringify({ status: 'waiting', waitingReason: 'active-turns',
    candidateBlocks: { [oldKey]: { threadId: THREAD, failedTurnId: TURN,
      actionRequired: true, reason: 'ROLLOUT_METADATA_UNVERIFIED' } } }));
  result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UNAVAILABLE INTERRUPTED TURNS:[\s\S]*rollout metadata unverified · unavailable/);
  assert.doesNotMatch(result.stdout, /AUTO-CONTINUE BLOCKED[^\n]*ROLLOUT_METADATA_UNVERIFIED|rollout metadata unverified · action required|AUTO: HEADLESS · BLOCKED/);
  assert.match(result.stdout, /AUTO: HEADLESS · WAIT: active-turns/);
  fs.writeFileSync(resume, JSON.stringify({ attempts: {}, retiredCandidates: {
    [oldKey]: { threadId: THREAD, turnId: TURN },
  } }));
  result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /UNAVAILABLE INTERRUPTED TURNS:/);
  assert.match(result.stdout, /INTERRUPTED CODEX TURNS:[\s\S]*…bda82e94/);
  const mismatched = partitionInterruptedCandidates([candidate(secondThread, secondTurn)], {
    [newKey]: { threadId: THREAD, failedTurnId: TURN, actionRequired: true, reason: 'BAD' },
  });
  assert.equal(mismatched.available.length, 1);
});

test('status shows AUTO switch progress and HEADLESS continuation without duplicate interrupted row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auto-display-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  const registryFile = path.join(home, 'accounts', 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ active_account_key: 'source-key', accounts: [
    { account_key: 'source-key', chatgpt_account_id: 'source', email: 'source@example.test' },
    { account_key: 'target-key', chatgpt_account_id: 'target', email: 'target@example.test' },
    { account_key: 'later-key', chatgpt_account_id: 'later', email: 'later@example.test' },
  ] }));
  const authFile = path.join(home, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'source' } }));
  const switchFile = path.join(root, 'switch.json');
  const events = path.join(root, 'events.json');
  const resume = path.join(root, 'resume.json');
  const auto = path.join(root, 'auto.json');
  const inputFile = path.join(root, 'input');
  fs.writeFileSync(inputFile, '     ACCOUNT           PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY\n'
    + '  01 source@example.test Plus  -             -               Now\n'
    + '  02 target@example.test Plus  -             -               Now\n'
    + '  03 later@example.test Plus  -             -               Now\n');
  const snapshot = updateDisplaySnapshot({}, THREAD,
    { name: 'Förbättra blankettvyn', projectName: 'Spadrig' }, 'thread-db', Date.now());
  const candidate = { threadId: THREAD, turnId: TURN, accountId: 'source',
    completedAtMs: Date.now(), resumable: true, threadIdentityVerified: true,
    classificationVerified: true, interruptionClass: 'INTERRUPTED_AFTER_WORK' };
  const key = turnKey(THREAD, TURN);
  const event = { version: 4, worker: { heartbeatAtMs: Date.now(), errorKind: null },
    files: {}, activeTurns: {}, interruptedTurns: { [key]: candidate }, terminalTurns: [],
    pendingErrors: {}, exhaustions: {}, displaySnapshots: snapshot.displaySnapshots };
  const env = { ...process.env, HOME: root, CODEX_HOME: home,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    CODEX_EVENT_STATE: events, CODEX_RESUME_STATE: resume,
    CODEX_AUTO_CONTINUE_STATE: auto,
    CODEX_STATUS_PREFERENCES: path.join(root, 'preferences.json'),
    CODEX_STATUS_COLUMNS: '110', CODEX_AUTO_SPINNER_PLACEHOLDER: '1',
    CODEX_ACCOUNT_SWITCH_STATE: switchFile };
  createInstance('rosetta', 'Rosetta', locations(env), env);
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2,
    autoMode: 'HEADLESS', autoContinue: true }));
  const render = () => {
    fs.writeFileSync(events, JSON.stringify(event));
    return renderStatus(root, env, inputFile).stdout;
  };
  fs.writeFileSync(resume, JSON.stringify({ attempts: {} }));
  fs.writeFileSync(auto, JSON.stringify({ status: 'idle' }));
  const normalFrame = render();
  const normalPlain = normalFrame.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(normalPlain, /^INSTANCES:\n/);
  assert.ok(normalPlain.indexOf('Rosetta · not signed in · stopped') < normalPlain.indexOf('ACCOUNTS:'));
  assert.ok(normalPlain.indexOf('ACCOUNTS:') < normalPlain.indexOf('PRIOR'));
  assert.match(normalFrame, /INTERRUPTED CODEX TURNS:[\s\S]*Spadrig · Förbättra blankettvyn/);
  assert.match(normalFrame, /Rosetta · not signed in · stopped/);
  assert.match(normalFrame, /PRIOR/);
  assert.doesNotMatch(normalFrame, /RECOMMENDATION:|Select instance \[1\], then account|Choose account \[1-3\]|PRIOR = weekly/);
  const normalViewport = require('../lib/codex-status-viewport').layoutStatusFrame(normalFrame,
    { rows: 28, columns: 110 }).lines.join('\n');
  assert.doesNotMatch(normalViewport, /RECOMMENDATION:|Select instance \[1\], then account|PRIOR = weekly/);
  const poolSwitch = path.join(root, 'config', 'codex-status', 'account-pool', 'switch-state.json');
  fs.mkdirSync(path.dirname(poolSwitch), { recursive: true });
  fs.writeFileSync(poolSwitch, JSON.stringify({ version: 1, instanceId: 'rosetta',
    phase: 'failed', errorKind: 'INSTANCE_AUTH_IMPORT_FAILED', updatedAtMs: Date.now() }));
  assert.match(render(), /ACCOUNT SWITCH FAILED: rosetta · INSTANCE_AUTH_IMPORT_FAILED/);
  fs.unlinkSync(poolSwitch);
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2,
    autoMode: 'DESKTOP', autoContinue: true }));
  fs.writeFileSync(auto, JSON.stringify({ status: 'waiting', waitingReason: 'no-candidates',
    desktopAttemptHistory: [{ outcome: 'fallback-headless', errorKind: 'SEND_CONTROL_COUNT_0' }] }));
  assert.match(render(), /AUTO: HEADLESS · WAIT: no-candidates/);
  assert.doesNotMatch(render(), /DESKTOP CONTINUATION|last fallback|AUTO: DESKTOP/);
  fs.writeFileSync(env.CODEX_STATUS_PREFERENCES, JSON.stringify({ version: 2,
    autoMode: 'HEADLESS', autoContinue: true }));
  fs.writeFileSync(auto, JSON.stringify({ status: 'running', phase: 'switching auth',
    candidateThreadId: THREAD, candidateTurnId: TURN,
    sourceAccountId: 'source', targetAccountId: 'target' }));
  fs.writeFileSync(switchFile, JSON.stringify({ source: 'auto', phase: 'switching',
    sourceAccountId: 'source', targetAccountId: 'target', updatedAtMs: Date.now() }));
  let frame = render();
  assert.match(frame.replace(/\x1b\[[0-9;]*m/g, ''), /\*01 source@example\.tes/);
  assert.match(frame, /HEADLESS CONTINUATION:[\s\S]*Spadrig · Förbättra blankettvyn[^\n]*switching auth/);
  assert.doesNotMatch(frame, /AUTO_SPINNER [^\n]*Spadrig · Förbättra blankettvyn/);
  assert.match(frame, /ACCOUNT SWITCH:[\s\S]*AUTO_SPINNER source@example\.tes → target@example\.tes · switching auth/);
  assert.match(frame, /WAIT\//);
  assert.doesNotMatch(frame, /INTERRUPTED CODEX TURNS:/);
  // The observer still reports the failed turn while a journal refresh briefly
  // removes it from the pending list. AUTO ownership keeps its display stable.
  fs.writeFileSync(resume, JSON.stringify({ attempts: { [key]: {
    threadId: THREAD, interruptedTurnId: TURN, status: 'PREFILL_STARTED', automatic: true,
  } } }));
  for (let refresh = 0; refresh < 3; refresh += 1) {
    frame = render();
    assert.match(frame, /HEADLESS CONTINUATION:[\s\S]*Spadrig · Förbättra blankettvyn[^\n]*switching auth/);
    assert.doesNotMatch(frame, /QUEUED INTERRUPTED TURNS:|INTERRUPTED CODEX TURNS:/);
  }
  fs.writeFileSync(resume, JSON.stringify({ attempts: {} }));
  env.CODEX_SELECTED_INSTANCE_ID = 'default';
  const selectedFrame = render();
  assert.match(selectedFrame.replace(/\x1b\[[0-9;]*m/g, ''),
    /Selected instance: Spadrig\nChoose account \[1-3\] · \[O\] Open\/focus · \[T\] Stop · Esc cancel/);
  assert.doesNotMatch(selectedFrame, /RECOMMENDATION:|Select instance \[1\], then account/);
  assert.match(require('../lib/codex-status-viewport').layoutStatusFrame(selectedFrame,
    { rows: 28, columns: 110 }).lines.join('\n'), /Selected instance: Spadrig/);
  delete env.CODEX_SELECTED_INSTANCE_ID;
  fs.writeFileSync(switchFile, JSON.stringify({ source: 'manual', phase: 'switching',
    sourceAccountId: 'source', targetAccountId: 'target', updatedAtMs: Date.now() }));
  assert.match(render(), /ACCOUNT SWITCH:[\s\S]*AUTO_SPINNER source@example\.tes → target@example\.tes · switching auth/);
  fs.writeFileSync(registryFile, JSON.stringify({ active_account_key: 'target-key', accounts: [
    { account_key: 'source-key', chatgpt_account_id: 'source', email: 'source@example.test' },
    { account_key: 'target-key', chatgpt_account_id: 'target', email: 'target@example.test' },
    { account_key: 'later-key', chatgpt_account_id: 'later', email: 'later@example.test' },
  ] }));
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'target' } }));
  fs.writeFileSync(switchFile, JSON.stringify({ source: 'auto', phase: 'completed',
    sourceAccountId: 'source', targetAccountId: 'target', updatedAtMs: Date.now() }));
  frame = render();
  assert.match(frame.replace(/\x1b\[[0-9;]*m/g, ''), /\*02 target@example\.tes/);
  assert.doesNotMatch(frame, /ACCOUNT SWITCH:|Account:|source@example\.tes → target@example\.tes/);
  fs.writeFileSync(resume, JSON.stringify({ attempts: { [key]: {
    threadId: THREAD, interruptedTurnId: TURN, accountId: 'source', targetAccountId: 'target',
    committedAtMs: Date.now(), status: 'RESUME_COMMITTED', automatic: true,
  } } }));
  event.activeTurns = { running: { threadId: THREAD, turnId: 'continuation-turn',
    accountId: 'target', startedAtMs: Date.now() } };
  fs.writeFileSync(auto, JSON.stringify({ status: 'waiting', waitingReason: 'resume-already-running' }));
  frame = render();
  assert.match(frame, /HEADLESS CONTINUATION:[^\n]*\n\x1b\[36mAUTO_SPINNER target@example\.tes \| Spadrig · Förbättra blankettvyn[^\n]*running/);
  assert.match(frame, /AUTO: HEADLESS · RUNNING/);
  assert.doesNotMatch(frame, /ACTIVE CODEX TURNS:|INTERRUPTED CODEX TURNS:|ACCOUNT SWITCH:|Account:|source@example\.tes → target@example\.tes/);
  fs.writeFileSync(switchFile, JSON.stringify({ source: 'auto', phase: 'switching',
    sourceAccountId: 'target', targetAccountId: 'later', updatedAtMs: Date.now() }));
  frame = render();
  assert.match(frame, /ACCOUNT SWITCH:[\s\S]*AUTO_SPINNER target@example\.tes → later@example\.test · switching auth/);
  assert.doesNotMatch(frame, /source@example\.tes → target@example\.tes → later|Account:/);
  fs.writeFileSync(registryFile, JSON.stringify({ active_account_key: 'later-key', accounts: [
    { account_key: 'source-key', chatgpt_account_id: 'source', email: 'source@example.test' },
    { account_key: 'target-key', chatgpt_account_id: 'target', email: 'target@example.test' },
    { account_key: 'later-key', chatgpt_account_id: 'later', email: 'later@example.test' },
  ] }));
  fs.writeFileSync(authFile, JSON.stringify({ tokens: { account_id: 'later' } }));
  fs.writeFileSync(switchFile, JSON.stringify({ source: 'auto', phase: 'completed',
    sourceAccountId: 'target', targetAccountId: 'later', updatedAtMs: Date.now() }));
  frame = render();
  assert.match(frame.replace(/\x1b\[[0-9;]*m/g, ''), /\*03 later@example\.test/);
  assert.match(frame, /HEADLESS CONTINUATION:[^\n]*\n\x1b\[36mAUTO_SPINNER later@example\.test \| Spadrig · Förbättra blankettvyn[^\n]*running/);
  assert.doesNotMatch(frame, /ACCOUNT SWITCH:|Account:|target@example\.tes → later@example\.test|source@example\.tes → later@example\.test/);
  fs.writeFileSync(resume, JSON.stringify({ attempts: { [key]: {
    threadId: THREAD, interruptedTurnId: TURN, continuationTurnId: 'continuation-turn',
    committedAtMs: Date.now(), status: 'COMPLETED',
  } } }));
  fs.writeFileSync(auto, JSON.stringify({ status: 'completed' }));
  frame = render();
  assert.doesNotMatch(frame, /HEADLESS CONTINUATION:|ACTIVE CODEX TURNS:|INTERRUPTED CODEX TURNS:/);
});
