'use strict';
require('./test-isolation');

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

test('C copies the complete local frame without collection or persistent mutations; P remains unchanged', () => {
  const toggle = source.slice(source.indexOf('      c|C)'), source.indexOf("      '['|']'|$'\\e')"));
  assert.match(toggle, /refresh_local_frame[\s\S]*copy_frame=\$base_frame/);
  assert.match(toggle, /printf '%s' "\$copy_frame" \| "\$\(dirname -- "\$0"\)\/codex-status-copy"/);
  assert.match(toggle, /Status copied/);
  assert.doesNotMatch(toggle, /process_snapshot|launch_usage_refresh|RESET_CREDITS_REFRESHER|CODEX_QUOTA_TRANSITION_BIN|CODEX_STATUS_PREFERENCES_BIN|draw_frame/);
  assert.doesNotMatch(source, /f\|F\)|display_frozen|CODEX_STATUS_FROZEN/);
  const loop = source.slice(source.indexOf('while true; do'), source.indexOf('  key=\'\''));
  assert.match(loop, /launch_usage_refresh/);
  assert.match(loop, /finish_local_collection/);
  assert.match(loop, /refresh_local_frame/);
  assert.match(loop, /if \(\(SECONDS - last_background_refresh >= 10\)\); then\s+launch_usage_refresh/);
  assert.match(loop, /if \(\(force_render\)\) && \[\[ -n \$raw_frame \]\]; then\s+process_snapshot/);
  assert.match(source, /if \(\(!paused_rendering\)\) && \(\(scroll_direction != 0\)\)/);
  const pause = source.slice(source.indexOf('      p|P)'), source.indexOf('      c|C)'));
  assert.match(pause, /if \(\(paused_rendering\)\); then/);
  assert.doesNotMatch(pause, /CODEX_STATUS_PREFERENCES_BIN|toggle-auto-continue/);
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

test('selection prompt is conditional and magenta auto-continue remains last before help', () => {
  const outputStatement = annotateSource.indexOf('process.stdout.write(`${instancesSection}');
  assert.notEqual(outputStatement, -1);
  const outputExpression = annotateSource.slice(outputStatement, outputStatement + 400);
  assert.match(outputExpression, /ACCOUNTS:.*output\.join/);
  assert.match(outputExpression, /accountSelectionLines\.length \? .*accountSelectionLines\.join/);
  assert.doesNotMatch(outputExpression, /renderedRecommendationLines/);
  const footerStatement = annotateSource.indexOf('const footerParts = [');
  const footerExpression = annotateSource.slice(footerStatement,
    annotateSource.indexOf('const footer =', footerStatement));
  assert.ok(footerExpression.indexOf('activeTurnsSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.ok(footerExpression.indexOf('interruptedTurnsSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.ok(footerExpression.indexOf('problemSection') < footerExpression.indexOf('autoContinueStatusLine'));
  assert.match(footerExpression, /\\x1b\[1;35m.*autoContinueStatusLine/);
  assert.ok(annotateSource.includes('  • ${line}'));
  assert.doesNotMatch(annotateSource, /resumeState\.lastError\?\.actionRequired/);
});

test('pending AUTO renders countdown attention and exposes an isolated X cancel action', () => {
  assert.match(annotateSource, /pendingAttentionDecision\(autoContinueState, statusPreferences\.autoContinue === true, nowMs\)/);
  assert.match(annotateSource, /autoContinueStatusLine\(statusPreferences, autoContinueState, nowMs, \{ operation \}\)/);
  assert.match(source, /x\|X\)/);
  assert.match(source, /grep -Fq '\[X\] Avbryt'/);
  assert.match(source, /cancel-auto-pending/);
});

test('status keys select an instance before an account and Esc or X cancels selection', () => {
  const keyBranch = source.slice(source.indexOf('      1|2|3|4|5|6|7|8|9)'), source.indexOf('      k|K)'));
  assert.match(keyBranch, /if \[\[ -z \$selected_instance_id \]\]; then[\s\S]*resolve-index "\$key"/);
  assert.match(keyBranch, /else[\s\S]*availability "\$selected_instance_id" "\$launcher_account"/);
  assert.match(keyBranch, /already-active\) selection_error='Account already active; no change'/);
  assert.match(keyBranch, /in-use:\*\) selection_error="Account in use by/);
  assert.match(keyBranch, /launch_instance_switch "\$selected_instance_id" "\$launcher_account"/);
  assert.match(source, /launch_instance_switch\(\)[\s\S]*codex-instance" switch-key "\$1" "\$2"/);
  assert.match(source, /instance-switch\.XXXXXXXX\.log/);
  assert.match(keyBranch, /Account switch blocked: \$\{availability/);
  assert.match(keyBranch, /selection_error="Account switch blocked: \$\{availability/);
  assert.doesNotMatch(keyBranch, /notify-send 'Codex-kontobyte stoppat'/);
  assert.match(keyBranch, /if launch_instance_switch[\s\S]*pending_source_row=\$source_row/);
  assert.match(keyBranch, /selected_instance_id=''[\s\S]*else\s+selection_error='Account switch could not be launched'/);
  assert.match(source, /x\|X\)[\s\S]*if \[\[ -n \$selected_instance_id \]\]; then[\s\S]*Instance selection cancelled/);
  assert.match(source, /\$'\\e'\)[\s\S]*if \[\[ \$key == \$'\\e' && -n \$selected_instance_id \]\]; then/);
});

test('detached switch completion preserves the real failure instead of silently clearing WAIT', () => {
  const finish = source.slice(source.indexOf('finish_instance_switch() {'),
    source.indexOf('launch_usage_refresh() {'));
  assert.match(finish, /if wait "\$instance_switch_pid"; then[\s\S]*else[\s\S]*result=\$\?/);
  assert.match(finish, /instance_switch_feedback="Account switch failed \(\$\{result\}\):/);
  assert.match(finish, /CODEX_INSTANCE_SWITCH_FEEDBACK=\$instance_switch_feedback/);
  assert.match(finish, /refresh_local_frame/);
  assert.match(source, /\[\[ -z \$instance_switch_pid && -n \$pending_source_row/);
});

test('selected-instance O and T use shared instance commands then exit and refresh on success', () => {
  const branch = source.slice(source.indexOf('      o|O|t|T)'), source.indexOf('      r|R)'));
  assert.match(branch, /if \[\[ -n \$selected_instance_id \]\]; then/);
  assert.match(branch, /instance_action=open/);
  assert.match(branch, /if \[\[ \$key == t \|\| \$key == T \]\]; then instance_action=stop; fi/);
  assert.match(branch, /codex-instance" "\$instance_action" "\$selected_instance_id"/);
  assert.match(branch, /selected_instance_id=''[\s\S]*CODEX_SELECTED_INSTANCE_ID=''[\s\S]*refresh_local_frame/);
  assert.doesNotMatch(branch, /codex-account|AUTO|pkill|pgrep/);
});

test('AUTO animation and countdown redraw locally without extra usage refresh', () => {
  const local = source.slice(source.indexOf('refresh_local_frame() {'),
    source.indexOf('signal_launcher_ready() {'));
  assert.match(local, /CODEX_STATUS_NOW_MS="\$now_ms" "\$USAGE_ANNOTATOR"/);
  assert.doesNotMatch(local, /USAGE_REFRESHER|launch_usage_refresh|CODEX_QUOTA_TRANSITION_BIN/);
  assert.match(source, /display_frame=\$\{display_frame\/\/AUTO_SPINNER/);
  assert.match(source, /auto_spinner_frames=\('\/' '-' '\\' '\|'\)/);
  assert.match(source, /live_interval=5[\s\S]*AUTO_SPINNER[\s\S]*live_interval=1/);
  assert.match(source, /if \(\(SECONDS != last_live_second\)\)/);
  assert.match(source, /if \(\(!paused_rendering\)\) && \[\[ \$base_frame == \*AUTO_SPINNER\* \]\]/);
  assert.equal((source.match(/launch_usage_refresh\n/g) || []).length, 1);
  assert.match(source, /runtime_signature\(\) \{[\s\S]*CODEX_ACCOUNT_SWITCH_STATE/);
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
