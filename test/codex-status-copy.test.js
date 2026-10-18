'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { layoutStatusFrame } = require('../lib/codex-status-viewport');

test('copy sends the complete logical frame as plain text, including viewport-hidden rows', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-copy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clipboard = path.join(directory, 'clipboard.txt');
  const fakeXclip = path.join(directory, 'xclip');
  fs.writeFileSync(fakeXclip, '#!/bin/sh\ncat > "$COPY_OUTPUT"\n');
  fs.chmodSync(fakeXclip, 0o755);
  const middle = Array.from({ length: 30 }, (_, index) => `problem-${index}`);
  const frame = ['\x1b[1mACCOUNT │ STATUS\x1b[0m', '────────┼───────',
    'account-a │ OK', '', 'RECOMMENDATION: stay', '',
    'ACCOUNT PROBLEMS:', ...middle, '', '\x1b[35mAUTO: HEADLESS\x1b[0m'].join('\n');
  const viewport = layoutStatusFrame(frame, { rows: 10, columns: 78 });
  assert.doesNotMatch(viewport.lines.join('\n'), /problem-29/);
  const inputFile = path.join(directory, 'frame.txt');
  fs.writeFileSync(inputFile, frame);
  const input = fs.openSync(inputFile, 'r');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'codex-status-copy')], {
    stdio: [input, 'pipe', 'pipe'], encoding: 'utf8',
    env: { ...process.env, WAYLAND_DISPLAY: '', DISPLAY: ':test',
      COPY_OUTPUT: clipboard, PATH: `${directory}:${process.env.PATH}` },
  });
  fs.closeSync(input);
  assert.equal(result.status, 0, result.stderr);
  const copied = fs.readFileSync(clipboard, 'utf8');
  assert.match(copied, /ACCOUNT │ STATUS\n────────┼───────\naccount-a │ OK/);
  assert.match(copied, /problem-0[\s\S]*problem-29/);
  assert.match(copied, /AUTO: HEADLESS\n$/);
  assert.doesNotMatch(copied, /\x1b/);
});
