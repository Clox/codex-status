'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CURRENT_VERSION = 1;

function defaultStatusPreferencesPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'codex-account-switcher', 'status-preferences.json');
}

function emptyStatusPreferences() {
  return {
    version: CURRENT_VERSION,
    autoContinue: false,
  };
}

function normalizeStatusPreferences(value) {
  if (value == null) return emptyStatusPreferences();
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('STATUS_PREFERENCES_INVALID');
  if (value.version !== CURRENT_VERSION || typeof value.autoContinue !== 'boolean') {
    throw new Error('STATUS_PREFERENCES_INVALID');
  }
  return {
    version: CURRENT_VERSION,
    autoContinue: value.autoContinue,
  };
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
  const directory = path.dirname(filePath);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) fs.chmodSync(directory, 0o700);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
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
  return writeStatusPreferences(filePath, {
    ...current,
    autoContinue: !current.autoContinue,
  });
}

function autoContinueLine(preferences) {
  return `AUTO-CONTINUE: ${preferences?.autoContinue === true ? 'ON' : 'OFF'} [A] toggle`;
}

module.exports = {
  CURRENT_VERSION,
  autoContinueLine,
  defaultStatusPreferencesPath,
  emptyStatusPreferences,
  normalizeStatusPreferences,
  readStatusPreferences,
  toggleAutoContinue,
  writeStatusPreferences,
};
