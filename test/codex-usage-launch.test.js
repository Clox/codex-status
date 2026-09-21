'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const launcher = path.join(__dirname, '..', 'bin', 'codex-usage-launch');

function executable(filename, contents) {
  fs.writeFileSync(filename, contents, { mode: 0o755 });
}

test('status launcher retries one immediate abnormal terminal child failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-launch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const count = path.join(root, 'count');
  const terminal = path.join(root, 'terminal');
  const status = path.join(root, 'status');
  executable(status, '#!/bin/sh\nexit 0\n');
  executable(terminal, `#!/bin/sh
count=0
[ ! -f "${count}" ] || count=$(cat "${count}")
count=$((count + 1))
printf '%s\n' "$count" >"${count}"
[ "$count" -gt 1 ]
`);

  const result = spawnSync(launcher, [], {
    env: {
      ...process.env,
      GNOME_TERMINAL_BIN: terminal,
      CODEX_USAGE_WATCH_BIN: status,
      CODEX_STATUS_LAUNCH_LOG: path.join(root, 'launch.log'),
      CODEX_STATUS_LAUNCH_RETRY_DELAY: '0',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(count, 'utf8').trim(), '2');
  assert.match(fs.readFileSync(path.join(root, 'launch.log'), 'utf8'), /retrying once/);
});

test('status launcher does not retry deliberate old-code shutdown', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-launch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const count = path.join(root, 'count');
  const terminal = path.join(root, 'terminal');
  const status = path.join(root, 'status');
  executable(status, '#!/bin/sh\nexit 0\n');
  executable(terminal, `#!/bin/sh
printf x >>"${count}"
exit 75
`);

  const result = spawnSync(launcher, [], {
    env: {
      ...process.env,
      GNOME_TERMINAL_BIN: terminal,
      CODEX_USAGE_WATCH_BIN: status,
      CODEX_STATUS_LAUNCH_LOG: path.join(root, 'launch.log'),
    },
  });
  assert.equal(result.status, 75);
  assert.equal(fs.readFileSync(count, 'utf8'), 'x');
});

test('status launcher assigns its dedicated WM class and role', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-launch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const terminal = path.join(root, 'terminal');
  const status = path.join(root, 'status');
  const args = path.join(root, 'args');
  executable(status, '#!/bin/sh\nexit 0\n');
  executable(terminal, `#!/bin/sh\nprintf '%s\\n' "$@" >"${args}"\nexit 0\n`);
  const result = spawnSync(launcher, [], {
    env: { ...process.env, GNOME_TERMINAL_BIN: terminal, CODEX_USAGE_WATCH_BIN: status,
      CODEX_STATUS_LAUNCH_LOG: path.join(root, 'launch.log') },
  });
  assert.equal(result.status, 0);
  const argumentsSent = fs.readFileSync(args, 'utf8').split('\n');
  assert.ok(argumentsSent.includes('--class=CodexStatus'));
  assert.ok(argumentsSent.includes('--role=codex-status'));
  assert.ok(argumentsSent.some(arg => /^--app-id=com\.canonical\.Terminal\.CodexStatus\.instance[0-9]+$/.test(arg)));
});

test('production launcher starts a dedicated server before its terminal client', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-launch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  const client = path.join(root, 'client');
  const busctl = path.join(root, 'busctl');
  const status = path.join(root, 'status');
  const events = path.join(root, 'events');
  executable(status, '#!/bin/sh\nexit 0\n');
  executable(server, `#!/bin/sh\nprintf 'server %s\n' "$*" >>"${events}"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n`);
  executable(busctl, `#!/bin/sh\ngrep -q '^server ' "${events}" 2>/dev/null || exit 1\nprintf 'ready %s\n' "$*" >>"${events}"\nexit 0\n`);
  executable(client, `#!/bin/sh\nprintf 'client %s\n' "$*" >>"${events}"\nexit 0\n`);
  const result = spawnSync(launcher, [], {
    env: { ...process.env, GNOME_TERMINAL_BIN: '', GNOME_TERMINAL_SERVER_BIN: server,
      GNOME_TERMINAL_CLIENT_BIN: client, CODEX_STATUS_BUSCTL_BIN: busctl,
      CODEX_USAGE_WATCH_BIN: status, CODEX_STATUS_LAUNCH_LOG: path.join(root, 'launch.log') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(events, 'utf8').trim().split('\n');
  assert.match(lines[0], /^server --app-id com\.canonical\.Terminal\.CodexStatus\.instance[0-9]+ --class CodexStatus$/);
  assert.match(lines[1], /^ready --user status com\.canonical\.Terminal\.CodexStatus\.instance[0-9]+$/);
  assert.match(lines[2], /^client --app-id com\.canonical\.Terminal\.CodexStatus\.instance[0-9]+ --wait /);
});
