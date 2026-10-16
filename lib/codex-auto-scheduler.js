'use strict';

const { execFileSync } = require('node:child_process');

const TIMER_UNIT = 'codex-auto-continue.timer';
const MAX_HEARTBEAT_AGE_MS = 90_000;
const SYSTEMCTL_BIN = process.env.CODEX_SYSTEMCTL_BIN || 'systemctl';

function readAutoTimerState(run = execFileSync) {
  try {
    const output = run(SYSTEMCTL_BIN, ['--user', 'show', TIMER_UNIT,
      '--property=LoadState', '--property=ActiveState', '--no-pager'], {
      encoding: 'utf8', timeout: 2_000,
    });
    const properties = Object.fromEntries(String(output).trim().split('\n')
      .map(line => line.split(/=(.*)/s).slice(0, 2)));
    return { loadState: properties.LoadState || null, activeState: properties.ActiveState || null };
  } catch {
    return { loadState: null, activeState: null };
  }
}

function autoSchedulerHealth(preferences, autoState, timerState, nowMs = Date.now()) {
  if (preferences?.autoMode !== 'HEADLESS') {
    return { healthy: true, reason: null };
  }
  if (timerState?.loadState !== 'loaded' || timerState?.activeState !== 'active') {
    return { healthy: false, reason: 'AUTO CONTROLLER/TIMER INACTIVE' };
  }
  const heartbeatAtMs = Number(autoState?.heartbeatAtMs);
  const enabledAtMs = Number(autoState?.modeEnabledAtMs);
  const newestAtMs = Math.max(Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : 0,
    Number.isFinite(enabledAtMs) ? enabledAtMs : 0);
  if (!newestAtMs || nowMs - newestAtMs > MAX_HEARTBEAT_AGE_MS || newestAtMs > nowMs + 5_000) {
    return { healthy: false, reason: 'AUTO CONTROLLER HEARTBEAT STALE' };
  }
  return { healthy: true, reason: null };
}

function ensureAutoTimerRunning(run = execFileSync) {
  run(SYSTEMCTL_BIN, ['--user', 'start', TIMER_UNIT], { encoding: 'utf8', timeout: 5_000 });
  const state = readAutoTimerState(run);
  if (state.loadState !== 'loaded' || state.activeState !== 'active') {
    throw new Error('AUTO_CONTROLLER_TIMER_INACTIVE');
  }
}

module.exports = { TIMER_UNIT, MAX_HEARTBEAT_AGE_MS, readAutoTimerState,
  autoSchedulerHealth, ensureAutoTimerRunning };
