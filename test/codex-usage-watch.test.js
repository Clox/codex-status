'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'codex-usage-watch'), 'utf8');
const annotateSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'codex-usage-annotate'), 'utf8');

test('status watch avoids unchanged redraws and exposes a render-only pause toggle', () => {
  assert.match(source, /\[\[ \$display_frame != "\$last_drawn_input" \]\]/);
  assert.match(source, /p\|P\)/);
  assert.match(source, /CODEX_STATUS_PAUSED="\$paused_rendering"/);
  assert.match(source, /if \(\(paused_rendering\)\); then\s+paused_rendering=0/);
});

test('switch spinner uses a cheap five-fps UI tick independent of collection and freezes while paused', () => {
  assert.match(source, /pending_spinner_frames=\('WAIT\/' 'WAIT─' 'WAIT\\' 'WAIT\|'\)/);
  assert.match(source, /CODEX_PENDING_STATUS='WAIT\/'/);
  assert.match(source, /read -rsn 1 -t 0\.2/);
  assert.match(source, /display_frame=\$\{display_frame\/\/WAIT\\\//);
  assert.match(source, /if \(\(!paused_rendering\)\) && \[\[ -n \$pending_source_row \]\]; then\s+pending_spinner_index=/);
  assert.doesNotMatch(source, /launch_usage_refresh[\s\S]{0,160}pending_spinner_index/);
});

test('startup renders cached or loading state before asynchronous local collection', () => {
  const initialDraw = source.indexOf('draw_current_frame\nsignal_launcher_ready\nstart_local_collection');
  assert.notEqual(initialDraw, -1);
  assert.match(source, /status_raw_frame_cache=.*status-raw-frame\.txt/);
  assert.match(source, /Loading cached account state/);
  assert.match(source, /script -qefc[\s\S]*&\s+collector_pid=\$!/);
  assert.match(source, /CODEX_STATUS_READY_FILE/);
});

test('recommendation precedes dynamic sections and magenta auto-continue remains last before help', () => {
  const outputStatement = annotateSource.indexOf('process.stdout.write(`${output.join');
  assert.notEqual(outputStatement, -1);
  const outputExpression = annotateSource.slice(outputStatement, outputStatement + 220);
  assert.ok(outputExpression.indexOf('renderedRecommendationLines') < outputExpression.indexOf('${footer}'));
  const footerStatement = annotateSource.indexOf('const footerParts = [');
  const footerExpression = annotateSource.slice(footerStatement, footerStatement + 420);
  assert.ok(footerExpression.indexOf('activeTurnsSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.ok(footerExpression.indexOf('interruptedTurnsSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.ok(footerExpression.indexOf('problemSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.match(footerExpression, /\\x1b\[1;35m.*autoContinueStatusLine/);
  assert.ok(annotateSource.includes('  • ${line}'));
  assert.doesNotMatch(annotateSource, /resumeState\.lastError\?\.actionRequired/);
});

test('pending AUTO renders countdown attention and exposes an isolated X cancel action', () => {
  assert.match(annotateSource, /pendingAttentionDecision\(autoContinueState, statusPreferences\.autoContinue === true, nowMs\)/);
  assert.match(annotateSource, /autoContinueStatusLine\(statusPreferences, autoContinueState, nowMs\)/);
  assert.match(source, /x\|X\)/);
  assert.match(source, /grep -Fq '\[X\] Avbryt'/);
  assert.match(source, /cancel-auto-pending/);
});

test('a quota recovery event sends one labelled desktop notification and persistent attention', () => {
  const recoveryBranch = source.slice(
    source.indexOf('if [[ -n $recovery_fingerprint ]]'),
    source.indexOf('base_frame=$frame'),
  );
  assert.match(recoveryBranch, /map\(account => account\.label\)\.join\(", "\)/);
  assert.equal((recoveryBranch.match(/notify-send 'Codex-kvot åter tillgänglig'/g) || []).length, 1);
  assert.match(recoveryBranch, /"persistentUntilFocus":true/);
  assert.match(recoveryBranch, /"situationClass":"quota-recovered"/);
});
