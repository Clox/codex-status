'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { layoutStatusFrame, splitStatusFrame } = require('../lib/codex-status-viewport');

const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'codex-usage-watch'), 'utf8');
const plain = value => String(value).replace(/\x1b\[[0-9;]*m/g, '');

function frame({ active = 8, interrupted = 8, problems = 8 } = {}) {
  return [
    'ACCOUNT │ STATUS',
    '────────┼───────',
    'account-a │ OK',
    'account-b │ EXHAU',
    '',
    '\x1b[1mRECOMMENDATION:\x1b[0m Switch to account-a',
    '',
    'ACTIVE CODEX TURNS:',
    ...Array.from({ length: active }, (_, index) => `active-${index}`),
    '',
    'INTERRUPTED CODEX TURNS:',
    ...Array.from({ length: interrupted }, (_, index) => `interrupted-${index}`),
    '',
    'ACCOUNT PROBLEMS:',
    ...Array.from({ length: problems }, (_, index) => `problem-${index}`),
    '',
    '\x1b[1;35mAUTO: HEADLESS · WAIT: active-turns\x1b[0m',
  ].join('\n');
}

test('small terminal pins table, recommendation, AUTO and help while scrolling crowded middle', () => {
  const rendered = layoutStatusFrame(frame(), { rows: 13 });
  const lines = rendered.lines.map(plain);
  assert.equal(lines.length, 13);
  assert.deepEqual(lines.slice(0, 5), [
    'ACCOUNT │ STATUS', '────────┼───────', 'account-a │ OK', 'account-b │ EXHAU',
    'RECOMMENDATION: Switch to account-a',
  ]);
  assert.match(lines.at(-3), /^AUTO: HEADLESS/);
  assert.match(lines.at(-1), /scroll.*P pause/);
  assert.match(lines.join('\n'), /↓ more/);
  assert.equal(lines.includes('problem-7'), false);
});

test('user scroll survives refresh, exposes above/below and clamps when content shrinks', () => {
  const original = frame();
  const first = layoutStatusFrame(original, { rows: 14, offset: 12 });
  assert.equal(first.offset, 12);
  assert.ok(first.above > 0);
  assert.ok(first.below > 0);
  assert.match(plain(first.lines.join('\n')), /↑ more/);
  const refreshed = layoutStatusFrame(original.replace('active-3', 'active-3 updated'), {
    rows: 14, offset: first.offset,
  });
  assert.equal(refreshed.offset, first.offset);
  const shorter = layoutStatusFrame(frame({ active: 0, interrupted: 0, problems: 1 }), {
    rows: 14, offset: first.offset,
  });
  assert.equal(shorter.offset, 0);
  assert.match(plain(shorter.lines.join('\n')), /problem-0/);
});

test('resize down and back up changes viewport without moving the pinned sections', () => {
  const content = frame({ active: 5, interrupted: 5, problems: 5 });
  const wide = layoutStatusFrame(content, { rows: 40, offset: 0 });
  assert.equal(wide.lines.length, 40);
  assert.equal(wide.below, 0);
  assert.match(plain(wide.lines.join('\n')), /problem-4/);
  const short = layoutStatusFrame(content, { rows: 12, offset: wide.offset });
  assert.equal(short.lines.length, 12);
  assert.match(plain(short.lines.slice(-3).join('\n')), /AUTO:/);
  assert.match(plain(short.lines.join('\n')), /↓ more|↕ .*more rows/);
  const expanded = layoutStatusFrame(content, { rows: 40, offset: short.offset });
  assert.equal(expanded.offset, 0);
  assert.equal(expanded.below, 0);
});

test('new important rows beyond the viewport retain an explicit more indicator', () => {
  const before = layoutStatusFrame(frame({ active: 1, interrupted: 1, problems: 1 }), { rows: 13 });
  const after = layoutStatusFrame(frame({ active: 1, interrupted: 2, problems: 10 }), {
    rows: 13, offset: before.offset,
  });
  assert.ok(after.below > 0);
  assert.match(plain(after.lines.join('\n')), /↓ more/);
  const bottom = layoutStatusFrame(frame({ active: 1, interrupted: 2, problems: 10 }), {
    rows: 13, offset: 999,
  });
  assert.match(plain(bottom.lines.join('\n')), /problem-9/);
  assert.match(plain(bottom.lines.join('\n')), /↑ more/);
});

test('paused layout keeps the pause affordance within the terminal height', () => {
  const rendered = layoutStatusFrame(frame(), { rows: 13, offset: 4, paused: true });
  assert.equal(rendered.lines.length, 13);
  assert.match(plain(rendered.lines.at(-1)), /PAUSED.*\[P\]/);
  assert.equal(splitStatusFrame(frame()).middle.some(line => line.includes('problem-7')), true);
});

test('one middle row shows actual content and moves overflow notice into fixed help', () => {
  const content = frame({ active: 2, interrupted: 2, problems: 2 });
  const first = layoutStatusFrame(content, { rows: 9, offset: 0 });
  assert.equal(first.lines.length, 9);
  assert.match(plain(first.lines[5]), /ACTIVE CODEX TURNS/);
  assert.match(plain(first.lines.at(-1)), /↓ .*more/);
  const moved = layoutStatusFrame(content, { rows: 9, offset: 999 });
  assert.match(plain(moved.lines[5]), /problem-1/);
  assert.match(plain(moved.lines.at(-1)), /↑ .*more/);
  const noMiddleRoom = layoutStatusFrame(content, { rows: 8, offset: moved.offset });
  assert.equal(noMiddleRoom.lines.length, 8);
  assert.match(plain(noMiddleRoom.lines.at(-2)), /^PRIOR/);
  assert.match(plain(noMiddleRoom.lines.at(-1)), /more/);
});

test('physically undersized terminals never receive more rows than they have', () => {
  for (const rows of [1, 2, 3, 4]) {
    const result = layoutStatusFrame(frame(), { rows });
    assert.ok(result.lines.length <= rows);
    assert.match(plain(result.lines[0]), /^ACCOUNT/);
  }
});

test('watch uses terminal height, in-place redraw, distinct scroll keys and no trailing newline', () => {
  assert.match(source, /rows=\$\(tput lines/);
  assert.match(source, /CODEX_STATUS_SCROLL_OFFSET="\$scroll_offset"/);
  assert.match(source, /printf '%s' "\$rendered_frame"/);
  assert.match(source, /tput cup 0 0/);
  assert.match(source, /'\['\|'\]'\|\$'\\e'/);
  assert.match(source, /'\[5~'/);
  assert.match(source, /'\[6~'/);
});
