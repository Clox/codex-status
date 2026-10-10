'use strict';

const ANSI = /\x1b\[[0-9;]*m/g;

function visible(line) {
  return String(line).replace(ANSI, '');
}

function trimEmpty(lines) {
  const result = [...lines];
  while (result.length && !visible(result[0]).trim()) result.shift();
  while (result.length && !visible(result.at(-1)).trim()) result.pop();
  return result;
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

function middleViewport(lines, budget, requestedOffset) {
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
    return { lines: [lines[offset], `\x1b[2m↑ ${offset} · ↓ ${below} more\x1b[0m`],
      offset, above: offset, below };
  }
  // Reserve indicator rows while scrolling; content never disappears silently.
  const contentRows = budget - 2;
  const maxOffset = Math.max(0, lines.length - contentRows);
  const offset = Math.min(maxOffset, Math.max(0, Number(requestedOffset) || 0));
  const below = Math.max(0, lines.length - offset - contentRows);
  const content = lines.slice(offset, offset + contentRows);
  return {
    lines: [offset ? `\x1b[2m↑ more (${offset})\x1b[0m` : '',
      ...content, below ? `\x1b[2m↓ more (${below})\x1b[0m` : ''],
    offset, above: offset, below,
  };
}

function layoutStatusFrame(frame, { rows, offset = 0, paused = false } = {}) {
  const height = Math.max(1, Math.floor(Number(rows) || 24));
  const sections = splitStatusFrame(frame);
  const explanation = '\x1b[2mPRIOR = weekly % remaining per hour until reset × 100. Higher means more urgent.\x1b[0m';
  const help = paused
    ? '\x1b[1;33mPAUSED — tryck [P] för att återuppta och uppdatera vyn.\x1b[0m'
    : '\x1b[2m1–9 account · K manage · A auto · ↑/↓ scroll · PgUp/PgDn page · P pause · Ctrl+C close\x1b[0m';
  let bottom = [sections.auto, explanation, help];
  const top = [...sections.table, ...sections.recommendation];
  if (top.length + bottom.length > height) bottom = [sections.auto, help];
  if (top.length + bottom.length > height) {
    // Physically too short for every pinned line. Keep the table at row zero,
    // then the recommendation and AUTO/footer in their relative positions.
    if (height < sections.recommendation.length + bottom.length + 1) {
      const tiny = height === 1 ? [sections.table[0] || sections.auto]
        : height === 2 ? [sections.table[0] || sections.auto, sections.auto]
          : [sections.table[0] || sections.auto, sections.auto, help];
      return { lines: tiny.slice(0, height), offset: 0, above: 0,
        below: sections.middle.length, constrained: true };
    }
    const tableBudget = Math.max(0, height - sections.recommendation.length - bottom.length);
    if (sections.middle.length) bottom[bottom.length - 1] = paused
      ? `\x1b[1;33mPAUSED · ↕ ${sections.middle.length} more · [P] resume\x1b[0m`
      : `\x1b[2m↕ ${sections.middle.length} more · resize · 1–9 account · K manage · A auto · P pause\x1b[0m`;
    const pinned = [...sections.table.slice(0, tableBudget), ...sections.recommendation, ...bottom];
    return { lines: pinned.slice(0, height), offset: Math.min(Math.max(0, sections.middle.length - 1), Math.max(0, Number(offset) || 0)), above: 0,
      below: sections.middle.length, constrained: true };
  }
  const budget = height - top.length - bottom.length;
  const middle = middleViewport(sections.middle, budget, offset);
  if (budget <= 1 && sections.middle.length > budget) {
    const marker = `↑ ${middle.above} · ↓ ${middle.below} more`;
    bottom[bottom.length - 1] = paused
      ? `\x1b[1;33mPAUSED · ${marker} · [P] resume\x1b[0m`
      : `\x1b[2m${marker} · 1–9 account · K manage · A auto · [/] scroll · P pause\x1b[0m`;
  }
  const padding = Array(Math.max(0, budget - middle.lines.length)).fill('');
  return { lines: [...top, ...middle.lines, ...padding, ...bottom], offset: middle.offset,
    above: middle.above, below: middle.below, constrained: false };
}

module.exports = { splitStatusFrame, middleViewport, layoutStatusFrame };
