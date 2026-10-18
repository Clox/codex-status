'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { acquireOperationLock, classify, startIdentity } = require('../lib/codex-operation-lock');

const helper = path.join(__dirname, '..', 'lib', 'codex-operation-lock.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'exclusive-codex-operation.lock');
}
function owner(lock, value) {
  fs.mkdirSync(lock);
  if (value !== null) fs.writeFileSync(path.join(lock, 'owner'), value);
}
function acquireThenRelease(lock) {
  const release = acquireOperationLock(lock);
  assert.equal(classify(lock), 'live');
  release();
  release();
  assert.equal(fs.existsSync(lock), false);
}

test('normal release is idempotent and generation-bound', t => {
  const lock = fixture(t);
  const releaseOld = acquireOperationLock(lock);
  const first = JSON.parse(fs.readFileSync(path.join(lock, 'owner')));
  assert.throws(() => acquireOperationLock(lock), /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/);
  releaseOld();
  const releaseNew = acquireOperationLock(lock);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner'))).generation, first.generation);
  releaseOld();
  assert.equal(classify(lock), 'live');
  releaseNew();
});

test('missing and empty owner heal after interrupted creation', t => {
  const lock = fixture(t);
  owner(lock, null);
  acquireThenRelease(lock);
  owner(lock, '');
  acquireThenRelease(lock);
});

test('invalid owner and dead PID heal', t => {
  const lock = fixture(t);
  owner(lock, 'not json');
  acquireThenRelease(lock);
  owner(lock, JSON.stringify({ pid: 99999999, identity: 'old:1', generation: 'a'.repeat(32) }));
  acquireThenRelease(lock);
});

test('reused PID with different process start identity heals', t => {
  const lock = fixture(t);
  owner(lock, JSON.stringify({ pid: process.pid, identity: 'different:0', generation: 'a'.repeat(32) }));
  acquireThenRelease(lock);
});

test('live verified owner blocks, including legacy live PID owner', t => {
  const lock = fixture(t);
  owner(lock, JSON.stringify({ pid: process.pid, identity: startIdentity(process.pid), generation: 'a'.repeat(32) }));
  assert.throws(() => acquireOperationLock(lock), /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/);
  fs.rmSync(lock, { recursive: true });
  owner(lock, String(process.pid));
  assert.throws(() => acquireOperationLock(lock), /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/);
});

test('simultaneous contenders never both own the lock', async t => {
  const lock = fixture(t);
  const source = `const {acquireOperationLock}=require(${JSON.stringify(helper)});let release;try{release=acquireOperationLock(process.argv[1]);process.stdout.write('OWNED\\n');setTimeout(()=>{release();process.exit(0)},350)}catch{process.stdout.write('BLOCKED\\n');process.exit(0)}`;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(output.trim()));
  });
  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.sort(), ['BLOCKED', 'OWNED']);
  assert.equal(fs.existsSync(lock), false);
});

test('SIGTERM during codex-auth-repair --hold leaves no exclusive lock', async t => {
  const lock = fixture(t);
  const root = path.dirname(lock);
  const home = path.join(root, 'codex');
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  const inactive = { account_key: 'inactive', chatgpt_account_id: 'id-inactive', email: 'inactive@example.test' };
  const active = { account_key: 'active', chatgpt_account_id: 'id-active', email: 'active@example.test' };
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({ active_account_key: 'active', accounts: [inactive, active] }));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'id-active' } }));
  fs.writeFileSync(path.join(home, 'accounts', 'inactive.auth.json'), JSON.stringify({ tokens: { account_id: 'id-inactive' } }));
  fs.writeFileSync(path.join(home, 'accounts', 'active.auth.json'), JSON.stringify({ tokens: { account_id: 'id-active' } }));
  const usage = path.join(root, 'usage.json');
  fs.writeFileSync(usage, JSON.stringify({ accounts: { 'id-inactive': { refresh: { errorKind: 'auth-401' } } } }));
  const repair = path.join(__dirname, '..', 'bin', 'codex-auth-repair');
  const command = `exec ${process.execPath} ${repair} --preflight --hold`;
  const child = spawn('script', ['-qefc', command, '/dev/null'], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, HOME: root, CODEX_HOME: home,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data'), USAGE_CACHE: usage,
      CODEX_OPERATION_LOCK_DIR: lock }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`repair hold timed out: ${output}`)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Press Enter to close this window.')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`repair exited before hold: ${code}: ${output}`)));
  });
  assert.equal(fs.existsSync(lock), false);
  const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/);
  assert.equal(children.length, 1);
  process.kill(Number(children[0]), 'SIGTERM');
  await new Promise(resolve => child.on('close', resolve));
  assert.equal(fs.existsSync(lock), false);
});
