'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { acquireOperationLock, classify } = require('../lib/codex-operation-lock');

const launcher = path.join(__dirname, '..', 'bin', 'codex-account');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-launcher-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config', 'codex-account-switcher');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(tools);
  const checker = path.join(tools, 'checker');
  fs.writeFileSync(checker, '#!/bin/sh\nprintf "id-target\\tkey-target\\tselector\\n"\n', { mode: 0o755 });
  const core = path.join(tools, 'core');
  fs.writeFileSync(core, '#!/bin/sh\ntouch "$CORE_STARTED"\nwhile test ! -e "$CORE_RELEASE"; do sleep 0.05; done\n', { mode: 0o755 });
  const manager = path.join(tools, 'instance-manager');
  fs.writeFileSync(manager, `#!/bin/sh
case "$1" in
  pool-migrate|check-account|record-release) exit 0 ;;
  assignment-lock-path) printf '%s\\n' '${path.join(root, 'assignment.lock')}' ;;
  account-lock-path) printf '%s\\n' '${path.join(root, 'account.lock')}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(config, 'accounts.conf'), [
    `CODEX_HOME=${JSON.stringify(path.join(root, 'codex'))}`,
    `NODE_BIN_DIR=${JSON.stringify(path.dirname(process.execPath))}`,
    'CODEX_AUTH_BIN=/bin/true',
    `ACCOUNT_STATE_CHECKER=${JSON.stringify(checker)}`,
    `ACCOUNT_SWITCH_CORE=${JSON.stringify(core)}`,
  ].join('\n'));
  return { root, lock: path.join(root, 'exclusive.lock'),
    started: path.join(root, 'started'), release: path.join(root, 'release'),
    env: { ...process.env, NODE_TEST_CONTEXT: undefined,
      XDG_CONFIG_HOME: path.join(root, 'config'), CODEX_OPERATION_LOCK_DIR: path.join(root, 'exclusive.lock'),
      CODEX_INSTANCE_MANAGER: manager,
      CORE_STARTED: path.join(root, 'started'), CORE_RELEASE: path.join(root, 'release') } };
}

async function until(condition, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for launcher');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('first manual switch owns its own generation until core finishes and releases it', async t => {
  const f = fixture(t);
  const child = spawn(launcher, ['--key', Buffer.from('key-target').toString('base64url')],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await until(() => fs.existsSync(f.started));
  const owner = JSON.parse(fs.readFileSync(path.join(f.lock, 'owner'), 'utf8'));
  assert.equal(owner.pid, child.pid);
  assert.equal(classify(f.lock), 'live');
  assert.throws(() => acquireOperationLock(f.lock), /EXCLUSIVE_CODEX_OPERATION_IN_PROGRESS/);
  fs.writeFileSync(f.release, 'go');
  const exitCode = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(fs.existsSync(f.lock), false);
});

test('manual switch waits for a short live lock instead of dropping the first keypress', async t => {
  const f = fixture(t);
  const releaseExisting = acquireOperationLock(f.lock);
  const child = spawn(launcher, ['--key', Buffer.from('key-target').toString('base64url')],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fs.existsSync(f.started), false);
  releaseExisting();
  await until(() => fs.existsSync(f.started));
  fs.writeFileSync(f.release, 'go');
  const exitCode = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(f.lock), false);
});
