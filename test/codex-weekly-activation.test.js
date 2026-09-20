'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  authStateMatches,
  executeVerifiedActivation,
  fetchFreshUsage,
  fingerprintAuthState,
  isNeedsActivation,
  isSuccessfullyActivated,
  runIsolatedCodexTurn,
  schemaSupportsManualActivation,
} = require('../lib/codex-weekly-activation');

const NOW_MS = 1_800_000_000_000;

function usage(weeklyRemaining, resetHours) {
  return {
    primary: { remainingPercent: 100, resetsAt: NOW_MS / 1000 + 18_000 },
    secondary: {
      remainingPercent: weeklyRemaining,
      resetsAt: resetHours === null ? null : NOW_MS / 1000 + resetHours * 3600,
    },
  };
}

test('recognizes only dormant 100 percent weekly as NEEDS_ACTIVATION', () => {
  assert.equal(isNeedsActivation(usage(100, 0), NOW_MS), true);
  assert.equal(isNeedsActivation(usage(100, null), NOW_MS), true);
  assert.equal(isNeedsActivation(usage(0, 24), NOW_MS), false);
  assert.equal(isNeedsActivation(usage(100, 168), NOW_MS), false);
});

test('accepts a verified reset around 168 hours', () => {
  assert.equal(isSuccessfullyActivated(usage(100, 168), NOW_MS), true);
  assert.equal(isSuccessfullyActivated(usage(100, 2), NOW_MS), false);
});

test('server usage request keeps credentials in headers and reports 401 without response content', async () => {
  let options;
  await assert.rejects(fetchFreshUsage({
    accountId: 'account-secret',
    accessToken: 'token-secret',
    fetchImpl: async (_url, supplied) => {
      options = supplied;
      return { ok: false, status: 401 };
    },
  }), /USAGE_HTTP_401/);
  assert.equal(options.headers.Authorization, 'Bearer token-secret');
  assert.equal(options.headers['ChatGPT-Account-Id'], 'account-secret');
});

test('verified activation sends exactly one turn and checks fresh state before and after', async () => {
  const observations = [usage(100, 0), usage(100, 168)];
  let turns = 0;
  const result = await executeVerifiedActivation({
    fetchUsage: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    now: () => NOW_MS,
  });
  assert.equal(turns, 1);
  assert.equal(result.after.secondary.remainingPercent, 100);
  assert.equal(observations.length, 0);
});

test('fails closed before a turn when the account is not dormant', async () => {
  let turns = 0;
  await assert.rejects(executeVerifiedActivation({
    fetchUsage: async () => usage(100, 168),
    runTurn: async () => { turns += 1; },
    now: () => NOW_MS,
  }), /ACCOUNT_NOT_NEEDS_ACTIVATION/);
  assert.equal(turns, 0);
});

test('does not retry when post-turn verification is unexpected', async () => {
  const observations = [usage(100, 0), usage(99, 168)];
  let turns = 0;
  await assert.rejects(executeVerifiedActivation({
    fetchUsage: async () => observations.shift(),
    runTurn: async () => { turns += 1; },
    now: () => NOW_MS,
  }), /ACTIVATION_NOT_VERIFIED/);
  assert.equal(turns, 1);
});

test('capability check requires external auth and ephemeral guarded threads', t => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-schema-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'v2'));
  fs.writeFileSync(path.join(root, 'v2', 'LoginAccountParams.json'), JSON.stringify({
    oneOf: [{ properties: { type: { enum: ['chatgptAuthTokens'] } }, required: ['accessToken', 'chatgptAccountId'] }],
  }));
  fs.writeFileSync(path.join(root, 'v2', 'ThreadStartParams.json'), JSON.stringify({
    properties: { ephemeral: {}, approvalPolicy: {}, sandbox: {}, dynamicTools: {} },
  }));
  fs.writeFileSync(path.join(root, 'v2', 'TurnStartParams.json'), JSON.stringify({ required: ['threadId', 'input'] }));
  assert.equal(schemaSupportsManualActivation(root), true);
  fs.writeFileSync(path.join(root, 'v2', 'LoginAccountParams.json'), '{}');
  assert.equal(schemaSupportsManualActivation(root), false);
});

test('auth-state fingerprints detect any mutation without exposing file contents', t => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-auth-hash-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'accounts'));
  fs.writeFileSync(path.join(root, 'auth.json'), '{"secret":"first"}');
  fs.writeFileSync(path.join(root, 'accounts', 'registry.json'), '{}');
  const before = fingerprintAuthState(root);
  const same = fingerprintAuthState(root);
  assert.equal(authStateMatches(before, same), true);
  fs.writeFileSync(path.join(root, 'auth.json'), '{"secret":"second"}');
  const after = fingerprintAuthState(root);
  assert.equal(authStateMatches(before, after), false);
  assert.equal(JSON.stringify(before).includes('first'), false);
});

function fakeAppServer(requests) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  let input = '';
  function send(message) {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', chunk => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf('\n')) >= 0) {
      const message = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      requests.push(message);
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
      if (message.method === 'account/login/start') send({ id: message.id, result: { type: 'chatgptAuthTokens' } });
      if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr-test', ephemeral: true } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-test', status: 'inProgress' } } });
        setImmediate(() => send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed' } } }));
      }
    }
  });
  child.kill = signal => {
    child.signalCode = signal;
    setImmediate(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

test('isolated protocol passes credentials only over stdin and creates one guarded ephemeral turn', async () => {
  const requests = [];
  let spawnRecord;
  await runIsolatedCodexTurn({
    codexBin: '/fake/codex',
    privateHome: '/private/temporary/home',
    accountId: 'account-secret',
    accessToken: 'token-secret',
    planType: 'Plus',
    spawnImpl: (command, args, options) => {
      spawnRecord = { command, args, options };
      return fakeAppServer(requests);
    },
  });
  assert.equal(JSON.stringify(spawnRecord).includes('token-secret'), false);
  assert.equal(JSON.stringify(spawnRecord).includes('account-secret'), false);
  const login = requests.find(request => request.method === 'account/login/start');
  assert.equal(login.params.accessToken, 'token-secret');
  const initialized = requests.find(request => request.method === 'initialized');
  assert.equal(Object.hasOwn(initialized, 'params'), false);
  const thread = requests.find(request => request.method === 'thread/start');
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.approvalPolicy, 'never');
  assert.equal(thread.params.sandbox, 'read-only');
  assert.deepEqual(thread.params.dynamicTools, []);
  assert.deepEqual(thread.params.environments, []);
  assert.equal(requests.filter(request => request.method === 'turn/start').length, 1);
});

test('isolated protocol times out closed without retrying a turn', async () => {
  const requests = [];
  const child = fakeAppServer(requests);
  child.stdin.removeAllListeners('data');
  await assert.rejects(runIsolatedCodexTurn({
    codexBin: '/fake/codex',
    privateHome: '/private/temporary/home',
    accountId: 'account-secret',
    accessToken: 'token-secret',
    timeoutMs: 20,
    spawnImpl: () => child,
  }), /APP_SERVER_TIMEOUT/);
  assert.equal(requests.filter(request => request.method === 'turn\/start').length, 0);
});

test('isolated protocol rejects a server-side token refresh request', async () => {
  const requests = [];
  const child = fakeAppServer(requests);
  const originalWrite = child.stdout.write.bind(child.stdout);
  let injected = false;
  child.stdout.write = chunk => {
    const result = originalWrite(chunk);
    const message = JSON.parse(String(chunk));
    if (!injected && message.result?.type === 'chatgptAuthTokens') {
      injected = true;
      setImmediate(() => originalWrite(`${JSON.stringify({
        id: 999,
        method: 'account/chatgptAuthTokens/refresh',
        params: { reason: 'unauthorized', previousAccountId: 'account-secret' },
      })}\n`));
    }
    return result;
  };
  await assert.rejects(runIsolatedCodexTurn({
    codexBin: '/fake/codex',
    privateHome: '/private/temporary/home',
    accountId: 'account-secret',
    accessToken: 'token-secret',
    spawnImpl: () => child,
  }), /APP_SERVER_(CREDENTIAL_ECHO|UNEXPECTED_SERVER_REQUEST)/);
  assert.equal(requests.filter(request => request.method === 'turn/start').length <= 1, true);
});
