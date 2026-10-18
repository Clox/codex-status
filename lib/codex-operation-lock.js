'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function startIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const startTicks = fields[19]; // /proc stat field 22
  if (!/^\d+$/.test(startTicks)) throw new Error('INVALID_PROCESS_START_IDENTITY');
  return `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${startTicks}`;
}

function classify(directory) {
  let raw;
  try { raw = fs.readFileSync(path.join(directory, 'owner'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'empty owner'; throw error; }
  if (!raw.trim()) return 'empty owner';
  let owner;
  try { owner = JSON.parse(raw); } catch { return 'invalid owner'; }
  if (Number.isSafeInteger(owner) && owner > 0) {
    // Old installations wrote PID-only owners. A live legacy owner must remain exclusive.
    try { process.kill(owner, 0); return 'live'; }
    catch (error) { return error.code === 'ESRCH' ? 'dead PID' : 'live'; }
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 ||
      typeof owner.identity !== 'string' || !owner.identity ||
      typeof owner.generation !== 'string' || !/^[a-f0-9]{32}$/.test(owner.generation)) return 'invalid owner';
  try { return startIdentity(owner.pid) === owner.identity ? 'live' : 'start-identity mismatch'; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return 'dead PID'; throw error; }
}

function transaction(action, directory, pid, generation) {
  if (action === 'acquire') {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    if (fs.existsSync(directory)) {
      const reason = classify(directory);
      if (reason === 'live') throw new Error('EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS');
      // The flock guard serializes every new writer before a stale directory is removed.
      const entries = fs.readdirSync(directory);
      if (entries.some(name => name !== 'owner' && !/^\.owner-[a-f0-9]{32}$/.test(name))) {
        throw new Error('EXCLUSIVE_CODEX_OPERATION_LOCK_UNSAFE');
      }
      for (const entry of entries) fs.unlinkSync(path.join(directory, entry));
      fs.rmdirSync(directory);
      process.stderr.write(`exclusive Codex operation lock recovered: ${reason}\n`);
    }
    fs.mkdirSync(directory, { mode: 0o700 });
    const owner = { pid, identity: startIdentity(pid), generation: crypto.randomBytes(16).toString('hex') };
    const temporary = path.join(directory, `.owner-${owner.generation}`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, path.join(directory, 'owner'));
      process.stdout.write(owner.generation);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      try { fs.rmdirSync(directory); } catch {}
      throw error;
    }
  } else if (action === 'release') {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner'), 'utf8')); }
    catch { return; }
    if (owner.pid !== pid || owner.generation !== generation || owner.identity !== startIdentity(pid)) return;
    fs.unlinkSync(path.join(directory, 'owner'));
    fs.rmdirSync(directory);
  } else throw new Error('INVALID_LOCK_ACTION');
}

function lockedTransaction(action, directory, pid, generation) {
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const result = spawnSync('flock', ['-x', `${directory}.guard`, process.execPath, __filename,
    `raw-${action}`, directory, String(pid), generation || ''], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error((result.stderr || '').trim() || 'EXCLUSIVE_CODEX_OPERATION_LOCK_UNAVAILABLE');
    error.code = /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/.test(error.message) ? 'ELOCKED' : 'ELOCKUNAVAILABLE';
    throw error;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

function acquireOperationLock(directory) {
  const generation = lockedTransaction('acquire', directory, process.pid);
  let released = false;
  return () => {
    if (released) return;
    lockedTransaction('release', directory, process.pid, generation);
    released = true;
  };
}

if (require.main === module) {
  try {
    const action = process.argv[2];
    if (action.startsWith('raw-')) transaction(action.slice(4), process.argv[3], Number(process.argv[4]), process.argv[5]);
    else process.stdout.write(lockedTransaction(action, process.argv[3], Number(process.argv[4]), process.argv[5]));
  }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.code === 'ELOCKED' ? 75 : 1; }
}

module.exports = { acquireOperationLock, classify, lockedTransaction, startIdentity };
