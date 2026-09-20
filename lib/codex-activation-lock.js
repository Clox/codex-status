'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function lockPathForAccount(directory, accountId) {
  const digest = crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24);
  return path.join(directory, `five-hour-${digest}.lock`);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireAccountActivationLock(directory, accountId) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filename = lockPathForAccount(directory, accountId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(filename, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`);
      return { descriptor, filename };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
      } catch {}
      if (processExists(Number(owner?.pid))) throw new Error('ACTIVATION_ALREADY_RUNNING');
      try {
        fs.unlinkSync(filename);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw new Error('ACTIVATION_LOCK_UNAVAILABLE');
      }
    }
  }
  throw new Error('ACTIVATION_LOCK_UNAVAILABLE');
}

function releaseAccountActivationLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.descriptor);
  } catch {}
  try {
    fs.unlinkSync(lock.filename);
  } catch {}
}

module.exports = {
  acquireAccountActivationLock,
  lockPathForAccount,
  processExists,
  releaseAccountActivationLock,
};
