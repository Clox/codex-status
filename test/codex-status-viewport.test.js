'use strict';
require('./test-isolation');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { layoutStatusFrame, splitStatusFrame, serializeStatusFrame, physicalLines } =
  require('../lib/codex-status-viewport');
const { displayWidth } = require('../lib/codex-interrupted-label');

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

test('instance section follows the account list and scrolls without changing account table width', () => {
  const input = frame({ active: 0, interrupted: 0, problems: 0 })
    .replace('\x1b[1mRECOMMENDATION:',
      'INSTANCES:\n1  Spadrig · running\n2  Rosetta · stopped\n\n\x1b[1mRECOMMENDATION:');
  const parts = splitStatusFrame(input);
  assert.equal(parts.table.length, 4);
  assert.match(parts.middle.join('\n'), /INSTANCES:\n1  Spadrig · running\n2  Rosetta · stopped/);
  const rendered = layoutStatusFrame(input, { rows: 24, columns: 79 });
  assert.match(rendered.lines.map(plain).join('\n'), /Spadrig · running/);
});

test('instances precede accounts in the pinned viewport at normal and narrow widths', () => {
  const input = [
    '\x1b[1;36mINSTANCES:\x1b[0m',
    '1  Spadrig · marko@example.test · running',
    '2  Rosetta · ogggan@example.test · stopped',
    '',
    '\x1b[1;36mACCOUNTS:\x1b[0m',
    'ACCOUNT │ STATUS', '────────┼───────', 'account-a │ OK', 'account-b │ EXHAU',
    '',
    'ACTIVE CODEX TURNS:',
    ...Array.from({ length: 20 }, (_, index) => `active-${index}`),
    '',
    '\x1b[1;35mAUTO: OFF\x1b[0m',
  ].join('\n');
  const parts = splitStatusFrame(input);
  assert.equal(plain(parts.instances[0]), 'INSTANCES:');
  assert.equal(plain(parts.table[0]), 'ACCOUNTS:');
  assert.equal(parts.table[1], 'ACCOUNT │ STATUS');
  for (const columns of [60, 77, 79]) {
    const first = layoutStatusFrame(input, { rows: 13, columns });
    const shown = first.lines.map(plain).join('\n');
    assert.match(shown, /^INSTANCES:\n1  Spadrig/);
    assert.ok(shown.indexOf('Rosetta') < shown.indexOf('ACCOUNTS:'));
    assert.ok(shown.indexOf('ACCOUNTS:') < shown.indexOf('ACCOUNT │ STATUS'));
    assert.match(shown, /AUTO: OFF/);
    assert.ok(serializeStatusFrame(first).split('\n').slice(1).length <= 13);
    assert.ok(first.below > 0);
    const scrolled = layoutStatusFrame(input, { rows: 13, columns, offset: 999 });
    assert.match(scrolled.lines.map(plain).join('\n'), /active-19/);
  }
});

test('selected-instance account prompt remains visible after the account table', () => {
  const input = [
    'INSTANCES:', '1  Spadrig · running', '2  Rosetta · stopped', '',
    'ACCOUNTS:', 'ACCOUNT │ STATUS', '────────┼───────', 'account-a │ OK', '',
    'Selected instance: Rosetta',
    'Choose account [1-4] · [O] Open/focus · [T] Stop · Esc cancel', '',
    'AUTO: OFF',
  ].join('\n');
  const lines = layoutStatusFrame(input, { rows: 16, columns: 77 }).lines.map(plain).join('\n');
  assert.match(lines, /INSTANCES:[\s\S]*ACCOUNTS:[\s\S]*Selected instance: Rosetta\nChoose account \[1-4\] · \[O\] Open\/focus · \[T\] Stop · Esc cancel/);
});

test('small terminal pins table, legacy recommendation, AUTO and help while scrolling crowded middle', () => {
  const rendered = layoutStatusFrame(frame(), { rows: 13 });
  const lines = rendered.lines.map(plain);
  assert.equal(lines.length, 13);
  assert.deepEqual(lines.slice(0, 5), [
    'ACCOUNT │ STATUS', '────────┼───────', 'account-a │ OK', 'account-b │ EXHAU',
    'RECOMMENDATION: Switch to account-a',
  ]);
  assert.match(lines.at(-2), /^AUTO: HEADLESS/);
  assert.match(lines.at(-1), /scroll.*P pause/);
  assert.match(lines.join('\n'), /↓ more/);
  assert.equal(lines.includes('problem-7'), false);
});

test('AUTO continuation progress stays inside the middle viewport at 77–79 columns', () => {
  const progressFrame = frame({ active: 2, interrupted: 2, problems: 3 })
    .replace('ACTIVE CODEX TURNS:', 'HEADLESS CONTINUATION:\n/ target@example.test | Spadrig · Förbättra blankettvyn | …bda82e93 | switching auth\nsource@example.test → target@example.test · switching auth\n\nACTIVE CODEX TURNS:');
  for (const columns of [77, 78, 79]) {
    const layout = layoutStatusFrame(progressFrame, { rows: 13, columns });
    const rendered = serializeStatusFrame(layout);
    assert.equal(layout.lines.map(plain)[0], 'ACCOUNT │ STATUS');
    assert.match(layout.lines.map(plain).join('\n'), /AUTO: HEADLESS/);
    assert.ok(rendered.split('\n').slice(1).length <= 13);
    assert.equal(rendered.endsWith('\n'), false);
  }
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

test('copy feedback preserves the middle scroll offset', () => {
  const original = frame({ active: 8, interrupted: 8, problems: 8 });
  const before = layoutStatusFrame(original, { rows: 13, columns: 78, offset: 5 });
  const copied = layoutStatusFrame(original, { rows: 13, columns: 78,
    offset: before.offset, copyFeedback: 'Status copied' });
  const after = layoutStatusFrame(original, { rows: 13, columns: 78, offset: copied.offset });
  assert.equal(copied.offset, before.offset);
  assert.equal(after.offset, before.offset);
  assert.match(copied.lines.map(plain).join('\n'), /Status copied/);
  assert.match(after.lines.map(plain).join('\n'), /C copy status/);
  assert.ok(serializeStatusFrame(copied).split('\n').slice(1).length <= 13);
  assert.ok(!serializeStatusFrame(copied).endsWith('\n'));
});

test('copy and pause help stays on one physical line at 77–79 columns', () => {
  for (const columns of [77, 78, 79]) {
    const layout = layoutStatusFrame(frame({ active: 0, interrupted: 0, problems: 0 }),
      { rows: 24, columns });
    const help = layout.lines.at(-1);
    assert.match(plain(help), /1–9 inst.*C copy status · P pause/);
    assert.equal(physicalLines([help], columns).length, 1);
  }
});

test('one middle row shows actual content and moves overflow notice into fixed help', () => {
  const content = frame({ active: 2, interrupted: 2, problems: 2 });
  const first = layoutStatusFrame(content, { rows: 9, offset: 0 });
  assert.equal(first.lines.length, 9);
  assert.match(plain(first.lines[5]), /ACTIVE CODEX TURNS/);
  assert.ok(first.below > 0);
  assert.match(plain(first.lines.join('\n')), /↓ .*more/);
  const moved = layoutStatusFrame(content, { rows: 9, offset: 999 });
  assert.match(plain(moved.lines[5]), /problem-1/);
  assert.match(plain(moved.lines.join('\n')), /↑ .*more/);
  const noMiddleRoom = layoutStatusFrame(content, { rows: 8, offset: moved.offset });
  assert.equal(noMiddleRoom.lines.length, 8);
  assert.match(plain(noMiddleRoom.lines.at(-2)), /^AUTO:/);
  assert.doesNotMatch(plain(noMiddleRoom.lines.join('\n')), /PRIOR = weekly/);
});

test('physically undersized terminals never receive more rows than they have', () => {
  for (const rows of [1, 2, 3, 4]) {
    const result = layoutStatusFrame(frame(), { rows });
    assert.ok(result.lines.length <= rows);
    assert.match(plain(result.lines[0]), /^ACCOUNT/);
  }
});

test('watch uses terminal height, in-place redraw, distinct scroll keys and no trailing newline', () => {
  assert.match(source, /stty size <\/dev\/tty/);
  assert.match(source, /CODEX_STATUS_LINES="\$terminal_rows" CODEX_STATUS_COLUMNS="\$terminal_columns"/);
  assert.match(source, /trap 'force_render=1' WINCH/);
  assert.match(source, /CODEX_STATUS_SCROLL_OFFSET="\$scroll_offset"/);
  assert.match(source, /printf '%s' "\$rendered_frame"/);
  assert.match(source, /tput cup 0 0/);
  assert.match(source, /'\['\|'\]'\|\$'\\e'/);
  assert.match(source, /'\[5~'/);
  assert.match(source, /'\[6~'/);
});

function physicalFrameHeight(result, columns) {
  const wire = serializeStatusFrame(result);
  const body = wire.slice(wire.indexOf('\n') + 1);
  const lines = body.split('\n');
  for (const line of lines) {
    assert.ok(displayWidth(plain(line)) < columns,
      `physical row exceeds ${columns - 1} cells: ${plain(line)}`);
  }
  return lines.length;
}

function liveShapeFrame({ extraProblems = 0 } = {}) {
  return [
    '\x1b[1m ACCOUNT                         5H USAGE         WEEKLY USAGE\x1b[0m',
    '────────────────────────────────────────────────────────────────────',
    '  01 alexander@example.test      EXHAU             EXHAU',
    '  02 marko@example.test          OK                 OK',
    '  03 linus@example.test          OK                 OK',
    '  04 ogggan@example.test         OK                 OK',
    '',
    'RECOMMENDATION: Marko',
    '',
    'ACTIVE CODEX TURNS:',
    'linus@example.test | Spadrig · Förbättra formulärvyn 界面 😀 med extra detaljer | …a08a86a9 | running',
    'marko@example.test | Codex-status · Fixa terminalens höjd och scrollning | …f7a3e2d8 | running',
    '',
    'INTERRUPTED CODEX TURNS:',
    'marko@example.test | Spadrig · Tablance navigation | …fcc0c140 | quota-interrupted-after-work',
    '',
    'UNAVAILABLE INTERRUPTED TURNS:',
    'ogggan@example.test | …bda82e93 | rollout missing · awaiting retirement',
    '',
    'ACCOUNT PROBLEMS:',
    '  • AUTO-CONTINUE BLOCKED / ACTION REQUIRED: …bda82e93 ROLLOUT_NOT_IN_ACTIVE_CODEX_HOME',
    ...Array.from({ length: extraProblems }, (_, index) => `  • problem ${index}: ${'long detail '.repeat(7)}`),
    '',
    '\x1b[1;35mAUTO: HEADLESS · WAIT: active-turns\x1b[0m',
  ].join('\n');
}

test('wire frame fits actual terminal rows at the boundary and during overflow', () => {
  const columns = 78;
  const frame = liveShapeFrame({ extraProblems: 12 });
  for (const terminalRows of [23, 24, 25]) {
    for (const offset of [0, 5, 999]) {
      const result = layoutStatusFrame(frame, { rows: terminalRows, columns, offset });
      assert.equal(physicalFrameHeight(result, columns), terminalRows);
      const body = serializeStatusFrame(result).split('\n').slice(1);
      assert.match(plain(body[0]), /ACCOUNT/);
      assert.match(plain(body.slice(-5).join('\n')), /AUTO: HEADLESS/);
      assert.ok(!serializeStatusFrame(result).endsWith('\n'));
      assert.ok(result.below > 0 || result.above > 0);
    }
  }
  const exact = layoutStatusFrame(liveShapeFrame(), { rows: 24, columns });
  assert.equal(physicalFrameHeight(exact, columns), 24);
  assert.match(plain(serializeStatusFrame(exact).split('\n').slice(-5).join('\n')), /AUTO: HEADLESS/);
  const tooLong = `${serializeStatusFrame(exact)}\n`;
  assert.equal(tooLong.slice(tooLong.indexOf('\n') + 1).split('\n').length, 25);
});

test('ANSI and wide text consume physical rows before middle scroll is chosen', () => {
  const frame = liveShapeFrame({ extraProblems: 2 });
  const narrow = layoutStatusFrame(frame, { rows: 20, columns: 54, offset: 999 });
  assert.equal(physicalFrameHeight(narrow, 54), 20);
  assert.match(plain(narrow.lines[0]), /ACCOUNT/);
  assert.match(plain(narrow.lines.join('\n')), /AUTO: HEADLESS/);
  const wide = layoutStatusFrame(frame, { rows: 20, columns: 110, offset: narrow.offset });
  assert.equal(physicalFrameHeight(wide, 110), 20);
  assert.match(plain(wide.lines[0]), /ACCOUNT/);
  assert.notEqual(narrow.offset, wide.offset);
});

test('four-account table and its label stay seven physical rows at 77, 78 and 79 columns', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-table-viewport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex');
  fs.mkdirSync(path.join(home, 'accounts'), { recursive: true });
  const labels = ['alexander@example.test', 'marko@example.test',
    'linus@example.test', 'ogggan@example.test'];
  fs.writeFileSync(path.join(home, 'accounts', 'registry.json'), JSON.stringify({ accounts:
    labels.map((email, index) => ({ email, chatgpt_account_id: `account-${index}` })),
  }));
  const input = [
    '     ACCOUNT                    PLAN  5H USAGE     WEEKLY USAGE           LAST ACTIVITY',
    '-------------------------------------------------------------------------------------------',
    ...labels.map((label, index) => `  0${index + 1} ${label.padEnd(27)} Plus  -             -                      Now`),
  ].join('\n');
  const inputFile = path.join(root, 'input');
  const outputFile = path.join(root, 'output');
  const errorFile = path.join(root, 'error');
  fs.writeFileSync(inputFile, input);
  for (const columns of [77, 78, 79]) {
    const descriptors = [fs.openSync(inputFile, 'r'), fs.openSync(outputFile, 'w'),
      fs.openSync(errorFile, 'w')];
    let result;
    try {
      result = spawnSync(process.execPath,
        [path.join(__dirname, '..', 'bin', 'codex-usage-annotate')], {
          env: { ...process.env, HOME: root, CODEX_HOME: home,
            CODEX_STATUS_COLUMNS: String(columns),
            CODEX_STATUS_PREFERENCES: path.join(root, 'missing-preferences.json') },
          stdio: descriptors, timeout: 5_000,
        });
    } finally {
      for (const descriptor of descriptors) fs.closeSync(descriptor);
    }
    assert.equal(result.status, 0, fs.readFileSync(errorFile, 'utf8') || result.error?.message);
    const annotated = fs.readFileSync(outputFile, 'utf8');
    const sections = splitStatusFrame(annotated);
    assert.equal(sections.table.length, 7);
    const layout = layoutStatusFrame(annotated, { rows: 24, columns });
    assert.equal(physicalFrameHeight(layout, columns), 24);
    const accountStart = layout.lines.findIndex(line => plain(line) === 'ACCOUNTS:');
    assert.ok(accountStart > 0);
    const table = layout.lines.slice(accountStart + 1, accountStart + 7).map(plain);
    assert.match(table[0], /ACCOUNT.*STATU.*RESETS.*5H USAGE.*WEEKLY USAGE.*PRIOR.*ACTIVITY/);
    assert.match(table[1], /┼/);
    for (let index = 0; index < 4; index++) {
      assert.match(table[index + 2], new RegExp(`0${index + 1}`));
      assert.equal(table[index + 2].split('│').length, 7);
    }
    assert.ok(table.every(line => line.trim() && displayWidth(line) < columns));
    assert.ok(!serializeStatusFrame(layout).endsWith('\n'));
  }
});
