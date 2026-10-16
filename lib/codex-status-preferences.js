'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CURRENT_VERSION = 2;
const AUTO_MODE = Object.freeze({
  OFF: 'OFF',
  HEADLESS: 'HEADLESS',
});
const AUTO_MODE_ORDER = Object.freeze([AUTO_MODE.OFF, AUTO_MODE.HEADLESS]);

function defaultStatusPreferencesPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'codex-account-switcher', 'status-preferences.json');
}

function emptyStatusPreferences() {
  return {
    version: CURRENT_VERSION,
    autoMode: AUTO_MODE.OFF,
    autoContinue: false,
  };
}

function normalizeStatusPreferences(value) {
  if (value == null) return emptyStatusPreferences();
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('STATUS_PREFERENCES_INVALID');
  // V1 had a boolean switch. Preserve an enabled installation as HEADLESS.
  if (value.version === 1 && typeof value.autoContinue === 'boolean') {
    const autoMode = value.autoContinue ? AUTO_MODE.HEADLESS : AUTO_MODE.OFF;
    return { version: CURRENT_VERSION, autoMode, autoContinue: autoMode !== AUTO_MODE.OFF };
  }
  if (value.version !== CURRENT_VERSION ||
      (!AUTO_MODE_ORDER.includes(value.autoMode) && value.autoMode !== 'DESKTOP')) {
    throw new Error('STATUS_PREFERENCES_INVALID');
  }
  const autoMode = value.autoMode === 'DESKTOP' ? AUTO_MODE.HEADLESS : value.autoMode;
  return {
    version: CURRENT_VERSION,
    autoMode,
    autoContinue: autoMode !== AUTO_MODE.OFF,
  };
}

function effectiveAutoMode(preferences) {
  if (preferences?.autoMode === AUTO_MODE.OFF) return AUTO_MODE.OFF;
  return preferences?.autoMode === AUTO_MODE.HEADLESS ||
    preferences?.autoMode === 'DESKTOP' || preferences?.autoContinue === true
    ? AUTO_MODE.HEADLESS : AUTO_MODE.OFF;
}

function readStatusPreferences(filePath = defaultStatusPreferencesPath()) {
  try {
    return normalizeStatusPreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStatusPreferences();
    if (error?.message === 'STATUS_PREFERENCES_INVALID') throw error;
    throw new Error('STATUS_PREFERENCES_INVALID');
  }
}

function writeStatusPreferences(filePath, value) {
  const normalized = normalizeStatusPreferences(value);
  const persisted = { version: CURRENT_VERSION, autoMode: normalized.autoMode };
  const directory = path.dirname(filePath);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) fs.chmodSync(directory, 0o700);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return normalized;
}

function toggleAutoContinue(filePath = defaultStatusPreferencesPath()) {
  const current = readStatusPreferences(filePath);
  const index = AUTO_MODE_ORDER.indexOf(current.autoMode);
  return writeStatusPreferences(filePath, {
    version: CURRENT_VERSION,
    autoMode: AUTO_MODE_ORDER[(index + 1) % AUTO_MODE_ORDER.length],
  });
}

function autoContinueLine(preferences) {
  const mode = normalizeStatusPreferences(preferences).autoMode;
  return `AUTO: ${mode} [A] mode`;
}

module.exports = {
  AUTO_MODE,
  AUTO_MODE_ORDER,
  CURRENT_VERSION,
  autoContinueLine,
  defaultStatusPreferencesPath,
  effectiveAutoMode,
  emptyStatusPreferences,
  normalizeStatusPreferences,
  readStatusPreferences,
  toggleAutoContinue,
  writeStatusPreferences,
};
