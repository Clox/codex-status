'use strict';

const VSCODE_CRASH_WINDOW_MS = 5 * 60 * 1000;
const VSCODE_AUTO_RESTART_LIMIT = 3;
const VSCODE_CRASH_SAFETY_MARGIN_MS = 1_000;

function isAppServerProcess(entry) {
  return Array.isArray(entry?.args) && entry.args.includes('app-server');
}

function isVsCodeCodexAppServerProcess(entry) {
  return isAppServerProcess(entry) &&
    /\/\.vscode\/extensions\/openai\.chatgpt-[^/]+\/bin\/[^/]+\/codex$/.test(entry.args[0] || '');
}

function isExtensionHostProcess(entry) {
  return Array.isArray(entry?.args) && entry.args.includes('--utility-sub-type=node.mojom.NodeService');
}

function isVsCodeRootProcess(entry) {
  return Array.isArray(entry?.args) &&
    entry.args[0] === '/usr/share/code/code' &&
    !entry.args.some(argument => argument.startsWith('--type=')) &&
    !entry.args.includes('--node-ipc') &&
    entry.args.some(argument => argument === '--crash-reporter-id' || argument.startsWith('--crash-reporter-id='));
}

function descendants(entries, rootPid) {
  const result = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries || []) {
      if (result.has(entry.ppid) && !result.has(entry.pid)) {
        result.add(entry.pid);
        changed = true;
      }
    }
  }
  return [...result];
}

function findVsCodeRootAncestor(entries, descendantPid) {
  const byPid = new Map((entries || []).map(entry => [entry.pid, entry]));
  const visited = new Set();
  let current = byPid.get(descendantPid);
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (isVsCodeRootProcess(current)) return current;
    current = byPid.get(current.ppid);
  }
  throw new Error('VSCODE_ROOT_UNVERIFIED');
}

function discoverVsCodeCodexChain(entries) {
  const servers = (entries || []).filter(isVsCodeCodexAppServerProcess);
  if (servers.length !== 1) throw new Error(`VSCODE_APP_SERVER_NOT_UNIQUE:${servers.map(entry => entry.pid).join(',')}`);
  const server = servers[0];
  const host = entries.find(entry => entry.pid === server.ppid);
  if (!host || !isExtensionHostProcess(host)) throw new Error('VSCODE_EXTENSION_HOST_UNVERIFIED');
  return { host, server, tree: descendants(entries, host.pid) };
}

function accountStateError(verification) {
  if (verification?.ok) return null;
  const errors = new Set(verification?.errors || []);
  if (errors.has('registry-target-account-missing') || errors.has('registry-active-account-missing')) {
    return 'REGISTRY_ACCOUNT_MISSING';
  }
  if (errors.has('registry-active-key-mismatch')) return 'REGISTRY_ACTIVE_KEY_MISMATCH';
  if (errors.has('registry-target-account-id-mismatch') || errors.has('registry-active-account-id-mismatch')) {
    return 'REGISTRY_ACCOUNT_ID_MISMATCH';
  }
  if (errors.has('global-auth-account-id-mismatch')) return 'GLOBAL_AUTH_ACCOUNT_ID_MISMATCH';
  return 'AUTH_STATE_UNVERIFIED';
}

function processSignalPlan(tree) {
  const unique = [...new Set(tree || [])];
  return {
    stop: unique,
    terminate: [...unique].reverse(),
    continue: [...unique].reverse(),
    forceKill: [...unique].reverse(),
  };
}

function parseExtensionHostCrashEvents(logText) {
  const events = [];
  for (const line of String(logText || '').split(/\r?\n/)) {
    if (!/Extension host .* terminated unexpectedly\./.test(line)) continue;
    const match = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!match) continue;
    const timestampMs = new Date(`${match[1]}T${match[2]}`).getTime();
    if (Number.isFinite(timestampMs)) events.push(timestampMs);
  }
  return [...new Set(events)].sort((left, right) => left - right);
}

function mergeExtensionHostCrashEvents(logTexts) {
  return [...new Set((logTexts || []).flatMap(parseExtensionHostCrashEvents))]
    .sort((left, right) => left - right);
}

function extensionHostRestartBudget(crashEvents, nowMs = Date.now(), options = {}) {
  const windowMs = options.windowMs || VSCODE_CRASH_WINDOW_MS;
  const autoRestartLimit = options.autoRestartLimit || VSCODE_AUTO_RESTART_LIMIT;
  const marginMs = options.marginMs ?? VSCODE_CRASH_SAFETY_MARGIN_MS;
  const recent = (crashEvents || [])
    .filter(timestampMs => Number.isFinite(timestampMs) && timestampMs > nowMs - windowMs && timestampMs <= nowMs)
    .sort((left, right) => left - right);
  const maximumExistingCrashes = autoRestartLimit - 2;
  if (recent.length <= maximumExistingCrashes) {
    return { safe: true, recentCrashCount: recent.length, safeAtMs: nowMs };
  }
  const mustExpireIndex = recent.length - maximumExistingCrashes - 1;
  return {
    safe: false,
    recentCrashCount: recent.length,
    safeAtMs: recent[mustExpireIndex] + windowMs + marginMs,
  };
}

module.exports = {
  accountStateError,
  descendants,
  discoverVsCodeCodexChain,
  isExtensionHostProcess,
  isVsCodeRootProcess,
  isVsCodeCodexAppServerProcess,
  extensionHostRestartBudget,
  findVsCodeRootAncestor,
  mergeExtensionHostCrashEvents,
  parseExtensionHostCrashEvents,
  processSignalPlan,
  VSCODE_AUTO_RESTART_LIMIT,
  VSCODE_CRASH_SAFETY_MARGIN_MS,
  VSCODE_CRASH_WINDOW_MS,
};
