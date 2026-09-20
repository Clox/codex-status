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
