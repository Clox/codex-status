'use strict';

const { displayWidth } = require('./codex-interrupted-label');
const ANSI = /\x1b\[[0-9;]*m/g;
const TOKEN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[^\x1b]+|\x1b/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function visible(line) {
  return String(line).replace(ANSI, '');
}

function trimEmpty(lines) {
  const result = [...lines];
  while (result.length && !visible(result[0]).trim()) result.shift();
  while (result.length && !visible(result.at(-1)).trim()) result.pop();
  return result;
}

function physicalLines(lines, columns) {
  // Leave the last column unused. Some terminals wrap or scroll as soon as it
  // is filled, even when the next write contains only an escape sequence.
  const width = Math.max(1, Math.floor(Number(columns) || 120) - 1);
  const output = [];
  for (const logical of lines) {
    let current = '';
    let cells = 0;
    let style = '';
    for (const token of String(logical).match(TOKEN) || []) {
      if (token.startsWith('\x1b')) {
        if (/^\x1b\[[0-9;]*m$/.test(token)) {
          current += token;
          style = /^\x1b\[(?:0)?m$/.test(token) ? '' : `${style}${token}`;
        }
        continue;
      }
      for (const { segment } of segmenter.segment(token)) {
        if (/\p{Cc}/u.test(segment)) continue;
        const size = displayWidth(segment);
        if (cells > 0 && cells + size > width) {
          output.push(current);
          current = style;
          cells = 0;
        }
        // A single wide glyph cannot fit into a one-column terminal.
        if (size > width) continue;
        current += segment;
        cells += size;
      }
    }
    output.push(current);
  }
  return output;
}

function singleTableLine(line, columns) {
  const physical = physicalLines([line], columns);
  // The annotator normally emits a safe one-row table. If an older source or
  // unusual glyph is wider, clip only this row and end any open color state.
  return physical.length === 1 ? physical[0] : `${physical[0]}\x1b[0m`;
}

function splitStatusFrame(frame) {
  const lines = String(frame || '').replace(/\r/g, '').split('\n');
  const recommendationIndex = lines.findIndex(line => /^RECOMMENDATION:/.test(visible(line).trimStart()));
  const autoIndex = lines.findLastIndex(line => /^AUTO:/.test(visible(line).trimStart()));
  if (recommendationIndex < 0 || autoIndex <= recommendationIndex) {
    return { table: trimEmpty(lines), recommendation: [], middle: [], auto: '\x1b[1;35mAUTO: loading…\x1b[0m' };
  }
  const table = trimEmpty(lines.slice(0, recommendationIndex));
  const afterRecommendation = lines.findIndex((line, index) =>
    index > recommendationIndex && !visible(line).trim());
  const recommendationEnd = afterRecommendation < 0 || afterRecommendation > autoIndex
    ? autoIndex : afterRecommendation;
  return {
    table,
    recommendation: trimEmpty(lines.slice(recommendationIndex, recommendationEnd)),
    middle: trimEmpty(lines.slice(recommendationEnd, autoIndex)),
    auto: lines[autoIndex],
  };
}

function middleViewport(lines, budget, requestedOffset, columns = 120) {
  const indicator = value => physicalLines([value], columns)[0];
  if (!lines.length) return { lines: [], offset: 0, above: 0, below: 0 };
  if (budget <= 0) {
    const offset = Math.min(lines.length - 1, Math.max(0, Number(requestedOffset) || 0));
    return { lines: [], offset, above: offset, below: lines.length - offset };
  }
  if (lines.length <= budget) return { lines, offset: 0, above: 0, below: 0 };
  if (budget <= 2) {
    const offset = Math.min(lines.length - 1, Math.max(0, Number(requestedOffset) || 0));
    const below = lines.length - offset - 1;
    if (budget === 1) return { lines: [lines[offset]],
      offset, above: offset, below };
    return { lines: [lines[offset], indicator(`\x1b[2m↑ ${offset} · ↓ ${below} more\x1b[0m`)],
      offset, above: offset, below };
  }
  // Reserve indicator rows while scrolling; content never disappears silently.
  const contentRows = budget - 2;
  const maxOffset = Math.max(0, lines.length - contentRows);
  const offset = Math.min(maxOffset, Math.max(0, Number(requestedOffset) || 0));
  const below = Math.max(0, lines.length - offset - contentRows);
  const content = lines.slice(offset, offset + contentRows);
  return {
    lines: [offset ? indicator(`\x1b[2m↑ more (${offset})\x1b[0m`) : '',
      ...content, below ? indicator(`\x1b[2m↓ more (${below})\x1b[0m`) : ''],
    offset, above: offset, below,
  };
}

function layoutStatusFrame(frame, { rows, columns, offset = 0, paused = false, copyFeedback = '' } = {}) {
  const height = Math.max(1, Math.floor(Number(rows) || 24));
  const original = splitStatusFrame(frame);
  const sections = {
    // The account renderer owns its column widths. A stale or unusual source
    // may still be too wide, but table rows must never become continuation rows.
    table: original.table.map(line => singleTableLine(line, columns)),
    recommendation: physicalLines(original.recommendation, columns),
    middle: physicalLines(original.middle, columns),
    auto: physicalLines([original.auto], columns),
  };
  const explanation = '\x1b[2mPRIOR = weekly % remaining per hour until reset × 100. Higher means more urgent.\x1b[0m';
  const help = copyFeedback
    ? `\x1b[1;32m${copyFeedback}\x1b[0m · C copy status · P pause view`
    : paused
    ? '\x1b[1;33mPAUSED — tryck [P] för att återuppta och uppdatera vyn.\x1b[0m'
    : '\x1b[2m1–9 acct · K manage · A auto · ↑↓ scroll · C copy status · P pause view\x1b[0m';
  let bottom = [...sections.auto, ...physicalLines([explanation, help], columns)];
  const top = [...sections.table, ...sections.recommendation];
  if (top.length + bottom.length > height) bottom = [...sections.auto, ...physicalLines([help], columns)];
  if (top.length + bottom.length > height) {
    // Physically too short for every pinned line. Keep the table at row zero,
    // then the recommendation and AUTO/footer in their relative positions.
    if (height < sections.recommendation.length + bottom.length + 1) {
      const tiny = height === 1 ? [sections.table[0] || sections.auto[0]]
        : height === 2 ? [sections.table[0] || sections.auto[0], sections.auto[0]]
          : [sections.table[0] || sections.auto[0], sections.auto[0], physicalLines([help], columns)[0]];
      return { lines: tiny.slice(0, height), offset: 0, above: 0,
        below: sections.middle.length, constrained: true };
    }
    const tableBudget = Math.max(0, height - sections.recommendation.length - bottom.length);
    if (sections.middle.length) bottom[bottom.length - 1] = physicalLines([copyFeedback
      ? `\x1b[1;32m${copyFeedback}\x1b[0m · ↕ ${sections.middle.length} more`
      : paused
      ? `\x1b[1;33mPAUSED · ↕ ${sections.middle.length} more · [P] resume\x1b[0m`
      : `\x1b[2m↕ ${sections.middle.length} more · C copy status · P pause view\x1b[0m`], columns)[0];
    const pinned = [...sections.table.slice(0, tableBudget), ...sections.recommendation, ...bottom];
    return { lines: pinned.slice(0, height), offset: Math.min(Math.max(0, sections.middle.length - 1), Math.max(0, Number(offset) || 0)), above: 0,
      below: sections.middle.length, constrained: true };
  }
  const budget = height - top.length - bottom.length;
  const middleLines = sections.middle.length > budget
    ? sections.middle.filter(line => visible(line).trim()) : sections.middle;
  const middle = middleViewport(middleLines, budget, offset, columns);
  if (budget <= 1 && middleLines.length > budget) {
    const marker = `↑ ${middle.above} · ↓ ${middle.below} more`;
    bottom[bottom.length - 1] = physicalLines([copyFeedback
      ? `\x1b[1;32m${copyFeedback}\x1b[0m · ${marker}`
      : paused
      ? `\x1b[1;33mPAUSED · ${marker} · [P] resume\x1b[0m`
      : `\x1b[2m${marker} · C copy status · P pause view\x1b[0m`], columns)[0];
  }
  const padding = Array(Math.max(0, budget - middle.lines.length)).fill('');
  return { lines: [...top, ...middle.lines, ...padding, ...bottom], offset: middle.offset,
    above: middle.above, below: middle.below, constrained: false };
}

function serializeStatusFrame(result) {
  // The final newline would advance a full-height frame past the TTY bottom.
  return `${result.offset}\n${result.lines.join('\n')}`;
}

module.exports = { splitStatusFrame, middleViewport, layoutStatusFrame, physicalLines,
  serializeStatusFrame };
