'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const { isWeeklyDormant, parseUsageResponse } = require('./codex-usage-cache');

const ACTIVATION_RESET_MIN_HOURS = 160;
const ACTIVATION_RESET_MAX_HOURS = 169;
const WEEKLY_OBSERVATION_DELAY_MS = 6_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PROTOCOL_BUFFER = 1024 * 1024;

function isNeedsActivation(usage) {
  const weekly = usage?.secondary;
  return weekly?.remainingPercent === 100 && usage?.weeklyDormant === true;
}

function activatedResetHours(usage, nowMs = Date.now()) {
  const resetsAt = Number(usage?.secondary?.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;
  return (resetsAt * 1000 - nowMs) / 3_600_000;
}

function isSuccessfullyActivated(usage, nowMs = Date.now()) {
  const hours = activatedResetHours(usage, nowMs);
  return usage?.secondary?.remainingPercent === 100 &&
    usage?.weeklyDormant === false &&
    Number.isFinite(hours) &&
    hours >= ACTIVATION_RESET_MIN_HOURS &&
    hours <= ACTIVATION_RESET_MAX_HOURS;
}

async function fetchFreshUsageObservation({ accountId, accessToken, fetchImpl = fetch, timeoutMs = 10_000 }) {
  let response;
  try {
    response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('USAGE_REQUEST_FAILED');
  }
  if (!response.ok) throw new Error(`USAGE_HTTP_${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('USAGE_PROTOCOL_MISMATCH');
  }
  const observedAtMs = Date.now();
  try {
    parseUsageResponse(payload, observedAtMs);
  } catch {
    throw new Error('USAGE_PROTOCOL_MISMATCH');
  }
  const serverDate = response.headers?.get?.('date');
  const serverObservedAtMs = serverDate ? Date.parse(serverDate) : null;
  return {
    payload,
    observedAtMs,
    serverObservedAtMs: Number.isFinite(serverObservedAtMs) ? serverObservedAtMs : null,
  };
}

function usageFromObservations(observations) {
  const parsed = observations.map(observation => ({
    observation,
    usage: parseUsageResponse(observation.payload, observation.observedAtMs),
  }));
  const latest = parsed.at(-1);
  const entry = {
    ...latest.usage,
    observations: {
      secondary: parsed.map(({ observation, usage }) => ({
        observedAtMs: observation.observedAtMs,
        serverObservedAtMs: observation.serverObservedAtMs,
        usedPercent: usage.secondary.raw.usedPercent,
        limitWindowSeconds: usage.secondary.raw.limitWindowSeconds,
        resetAfterSeconds: usage.secondary.raw.resetAfterSeconds,
        resetAt: usage.secondary.raw.resetAt,
      })),
    },
    refresh: {
      lastSuccessAt: latest.observation.observedAtMs,
      lastAttemptAt: latest.observation.observedAtMs,
      lastErrorAt: null,
      errorKind: null,
      httpStatus: 200,
      consecutiveFailures: 0,
    },
  };
  return {
    ...latest.usage,
    weeklyDormant: isWeeklyDormant(entry, { nowMs: latest.observation.observedAtMs }),
  };
}

async function fetchFreshUsage(options) {
  const delay = options.delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const observationDelayMs = options.observationDelayMs ?? WEEKLY_OBSERVATION_DELAY_MS;
  const first = await fetchFreshUsageObservation(options);
  await delay(observationDelayMs);
  const second = await fetchFreshUsageObservation(options);
  return usageFromObservations([first, second]);
}

function schemaSupportsManualActivation(schemaDirectory) {
  try {
    const login = JSON.parse(fs.readFileSync(path.join(schemaDirectory, 'v2', 'LoginAccountParams.json'), 'utf8'));
    const thread = JSON.parse(fs.readFileSync(path.join(schemaDirectory, 'v2', 'ThreadStartParams.json'), 'utf8'));
    const turn = JSON.parse(fs.readFileSync(path.join(schemaDirectory, 'v2', 'TurnStartParams.json'), 'utf8'));
    const externalAuth = login.oneOf?.find(option =>
      option.properties?.type?.enum?.includes('chatgptAuthTokens')
    );
    const requiredAuth = new Set(externalAuth?.required || []);
    const requiredTurn = new Set(turn.required || []);
    return Boolean(
      requiredAuth.has('accessToken') &&
      requiredAuth.has('chatgptAccountId') &&
      thread.properties?.ephemeral &&
      thread.properties?.approvalPolicy &&
      thread.properties?.sandbox &&
      thread.properties?.dynamicTools &&
      requiredTurn.has('threadId') &&
      requiredTurn.has('input') &&
      turn.properties?.model &&
      turn.properties?.effort &&
      turn.properties?.serviceTierForTurn
    );
  } catch {
    return false;
  }
}

function generateAndCheckSchema({ codexBin, privateHome, schemaDirectory }) {
  const result = spawnSync(codexBin, [
    'app-server',
    'generate-json-schema',
    '--experimental',
    '--out',
    schemaDirectory,
  ], {
    cwd: privateHome,
    env: isolatedChildEnvironment(privateHome),
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 15_000,
  });
  if (result.status !== 0 || !schemaSupportsManualActivation(schemaDirectory)) {
    throw new Error('APP_SERVER_CAPABILITY_MISMATCH');
  }
}

function authStateFiles(codexHome) {
  const candidates = [path.join(codexHome, 'auth.json')];
  const accountsDirectory = path.join(codexHome, 'accounts');
  try {
    for (const filename of fs.readdirSync(accountsDirectory)) {
      if (filename.endsWith('.auth.json')) candidates.push(path.join(accountsDirectory, filename));
    }
  } catch {}
  return [...new Set(candidates)].filter(filename => fs.existsSync(filename)).sort();
}

function accountIdentity(account) {
  return {
    accountKey: account?.account_key || account?.accountKey || null,
    accountId: account?.chatgpt_account_id || account?.accountId || null,
    userId: account?.chatgpt_user_id || account?.userId || null,
  };
}

function normalizedRegistrySecurityState(codexHome) {
  const filename = path.join(codexHome, 'accounts', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const accounts = Array.isArray(registry?.accounts)
    ? registry.accounts
    : Object.values(registry?.accounts || {});
  const identities = accounts.map(accountIdentity).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  return {
    activeAccountKey: registry?.active_account_key || null,
    activeAccountActivatedAtMs: Number.isFinite(Number(registry?.active_account_activated_at_ms))
      ? Number(registry.active_account_activated_at_ms)
      : null,
    accountIdentities: identities,
  };
}

function fingerprintAuthState(codexHome) {
  const authFileHashes = Object.fromEntries(authStateFiles(codexHome).map(filename => {
    const contents = fs.readFileSync(filename);
    const relative = path.relative(codexHome, filename);
    return [relative, crypto.createHash('sha256').update(contents).digest('hex')];
  }));
  return {
    authFileHashes,
    registrySecurityState: normalizedRegistrySecurityState(codexHome),
  };
}

function authStateChanges(before, after) {
  const changes = [];
  const beforeFiles = before?.authFileHashes || {};
  const afterFiles = after?.authFileHashes || {};
  for (const filename of [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])].sort()) {
    if (beforeFiles[filename] !== afterFiles[filename]) {
      changes.push(filename === 'auth.json'
        ? 'auth.globalAuthHash'
        : `auth.snapshotHash:${path.basename(filename)}`);
    }
  }
  const beforeRegistry = before?.registrySecurityState || {};
  const afterRegistry = after?.registrySecurityState || {};
  if (beforeRegistry.activeAccountKey !== afterRegistry.activeAccountKey) {
    changes.push('registry.activeAccountKey');
  }
  if (beforeRegistry.activeAccountActivatedAtMs !== afterRegistry.activeAccountActivatedAtMs) {
    changes.push('registry.activeAccountActivatedAtMs');
  }
  if (JSON.stringify(beforeRegistry.accountIdentities) !== JSON.stringify(afterRegistry.accountIdentities)) {
    changes.push('registry.accountIdentities');
  }
  return changes;
}

function authStateMatches(before, after) {
  return authStateChanges(before, after).length === 0;
}

function assertAuthStateUnchanged(before, after) {
  const changes = authStateChanges(before, after);
  if (changes.length === 0) return;
  const error = new Error('GLOBAL_AUTH_STATE_CHANGED');
  error.authStateChanges = changes;
  throw error;
}

function containsCredential(value, credentials) {
  const rendered = JSON.stringify(value);
  return credentials.some(secret => secret && rendered.includes(secret));
}

function isolatedChildEnvironment(privateHome) {
  const environment = { ...process.env, CODEX_HOME: privateHome };
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ACCESS_TOKEN']) {
    delete environment[name];
  }
  return environment;
}

function isToolItem(item) {
  const type = String(item?.type || '').toLowerCase();
  return /(tool|command|filechange|websearch|imagegeneration|mcp)/.test(type);
}

class JsonRpcConnection {
  constructor(child, credentials, timeoutMs) {
    this.child = child;
    this.credentials = credentials;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.notifications = [];
    this.buffer = '';
    this.failure = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    child.stderr.on('data', () => {});
    child.on('error', () => this.fail(new Error('APP_SERVER_START_FAILED')));
    child.on('exit', () => this.fail(new Error('APP_SERVER_EXITED')));
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PROTOCOL_BUFFER) {
      this.fail(new Error('APP_SERVER_PROTOCOL_OVERFLOW'));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error('APP_SERVER_PROTOCOL_MISMATCH'));
        return;
      }
      if (containsCredential(message, this.credentials)) {
        this.fail(new Error('APP_SERVER_CREDENTIAL_ECHO'));
        return;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('APP_SERVER_REQUEST_FAILED'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.fail(new Error('APP_SERVER_UNEXPECTED_SERVER_REQUEST'));
      return;
    }
    if (message.method === 'item/started' && isToolItem(message.params?.item)) {
      this.fail(new Error('APP_SERVER_UNEXPECTED_TOOL_USE'));
      return;
    }
    this.notifications.push(message);
    if (this.notifications.length > 100) this.notifications.shift();
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return promise;
  }

  notify(method, params) {
    if (this.failure) throw this.failure;
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate) {
    if (this.failure) return Promise.reject(this.failure);
    const existingIndex = this.notifications.findIndex(predicate);
    if (existingIndex >= 0) {
      const [message] = this.notifications.splice(existingIndex, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('APP_SERVER_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').catch(() => {});
  child.stdin.end();
  child.kill('SIGTERM');
  let timer;
  await Promise.race([
    exited,
    new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function runIsolatedCodexTurn({
  codexBin,
  privateHome,
  accountId,
  accessToken,
  planType = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  const child = spawnImpl(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: privateHome,
    env: isolatedChildEnvironment(privateHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = new JsonRpcConnection(child, [accessToken, accountId], timeoutMs);
  try {
    await withTimeout((async () => {
      await rpc.request('initialize', {
        clientInfo: {
          name: 'codex_isolated_activation',
          title: 'Codex Isolated Activation',
          version: '1.0.0',
        },
        capabilities: { experimentalApi: true },
      });
      rpc.notify('initialized');
      const login = await rpc.request('account/login/start', {
        type: 'chatgptAuthTokens',
        accessToken,
        chatgptAccountId: accountId,
        ...(planType ? { chatgptPlanType: String(planType).toLowerCase() } : {}),
      });
      if (login?.type !== 'chatgptAuthTokens') throw new Error('APP_SERVER_AUTH_MISMATCH');
      const started = await rpc.request('thread/start', {
        cwd: privateHome,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        dynamicTools: [],
        environments: [],
        serviceName: 'codex_isolated_activation',
        developerInstructions: 'This is a one-turn quota activation. Do not call or use any tools. Reply with exactly OK.',
      });
      const threadId = started?.thread?.id;
      if (!threadId || started?.thread?.ephemeral !== true) throw new Error('APP_SERVER_THREAD_MISMATCH');
      const turn = await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Reply with exactly OK. Do not use tools.' }],
        approvalPolicy: 'never',
        model: 'gpt-5.6-luna',
        effort: 'low',
        serviceTierForTurn: 'default',
      });
      const turnId = turn?.turn?.id;
      if (!turnId) throw new Error('APP_SERVER_TURN_MISMATCH');
      const completed = await rpc.waitFor(message =>
        message.method === 'turn/completed' && message.params?.turn?.id === turnId
      );
      if (completed.params?.turn?.status !== 'completed') throw new Error('APP_SERVER_TURN_FAILED');
    })(), timeoutMs);
  } finally {
    await terminateChild(child);
  }
}

async function executeVerifiedActivation({
  fetchUsage,
  runTurn,
  assertCanActivate = () => {},
  now = () => Date.now(),
}) {
  const before = await fetchUsage();
  if (!isNeedsActivation(before, now())) throw new Error('ACCOUNT_NOT_NEEDS_ACTIVATION');
  await assertCanActivate();
  await runTurn();
  const after = await fetchUsage();
  if (!isSuccessfullyActivated(after, now())) throw new Error('ACTIVATION_NOT_VERIFIED');
  return { before, after };
}

module.exports = {
  ACTIVATION_RESET_MAX_HOURS,
  ACTIVATION_RESET_MIN_HOURS,
  DEFAULT_TIMEOUT_MS,
  activatedResetHours,
  assertAuthStateUnchanged,
  authStateChanges,
  authStateMatches,
  executeVerifiedActivation,
  fetchFreshUsage,
  fetchFreshUsageObservation,
  fingerprintAuthState,
  generateAndCheckSchema,
  isNeedsActivation,
  isSuccessfullyActivated,
  runIsolatedCodexTurn,
  schemaSupportsManualActivation,
};
