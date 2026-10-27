#!/usr/bin/env node
// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Report on CJK font coverage for one converted layout.json.
//
//   node test/font-check.js C:/out/cjk10/layout.json
//
// It answers three questions with numbers instead of adjectives:
//   1. how many text widgets actually need CJK glyphs;
//   2. how many of those got a fallback face registered in assets.fonts[].fallbacks;
//   3. whether the registered files really contain those codepoints (cmap check), so a
//      "fallback exists" can never be mistaken for "fallback covers".
'use strict';

const fs = require('fs');
const path = require('path');

const {
  cjkCodepoints,
  cjkBlockOf,
  CJK_BLOCKS,
  fontCoverageForFile,
  coverageHas,
} = require('../src/assets');

function walkNodes(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walkNodes(child, visit);
}

function pct(covered, total) {
  if (!total) return '100.0%';
  return `${((covered / total) * 100).toFixed(1)}%`;
}

function main(argv) {
  const jsonPath = argv[0];
  if (!jsonPath) {
    process.stderr.write('usage: node test/font-check.js <layout.json>\n');
    return 1;
  }
  const absJson = path.resolve(jsonPath);
  const layout = JSON.parse(fs.readFileSync(absJson, 'utf8'));
  const baseDir = path.dirname(absJson);
  const fonts = (layout.assets && layout.assets.fonts) || [];
  const byKey = new Map();
  for (const entry of fonts) byKey.set(entry.key, entry);

  const resolveFile = (rel) => (rel ? path.join(baseDir, rel.replace(/\//g, path.sep)) : null);

  const rows = [];
  let textCount = 0;
  let cjkTextCount = 0;
  let withFallback = 0;
  let withFile = 0;
  let coveredByPrimary = 0;
  let coveredByChain = 0;
  let uncovered = 0;
  const blockHits = new Map();
  const usedKeys = new Map();

  walkNodes(layout.root, (node) => {
    const props = node.properties || {};
    if (props.Text === undefined || props.Text === null || props.Text === '') return;
    const text = String(props.Text);
    textCount += 1;
    const cps = cjkCodepoints(text);
    if (!cps.length) return;
    cjkTextCount += 1;
    for (const cp of cps) {
      const block = cjkBlockOf(cp);
      if (block) blockHits.set(block, (blockHits.get(block) || 0) + 1);
    }
    const fontObject = props.Font && props.Font.FontObject ? String(props.Font.FontObject) : '';
    const key = fontObject.replace(/^@/, '');
    const entry = byKey.get(key) || null;
    const fallbacks = (entry && entry.fallbacks) || [];
    const primaryFile = entry ? resolveFile(entry.file) : null;
    const primaryCoverage =
      primaryFile && fs.existsSync(primaryFile) ? fontCoverageForFile(primaryFile, entry.subface || 0) : null;
    let primaryOk = 0;
    const chainRanges = [];
    if (primaryCoverage) chainRanges.push(...primaryCoverage.ranges);
    const fallbackFiles = [];
    for (const fallback of fallbacks) {
      const file = resolveFile(fallback.file);
      fallbackFiles.push(file);
      const coverage = file && fs.existsSync(file) ? fontCoverageForFile(file, fallback.subface || 0) : null;
      if (coverage) chainRanges.push(...coverage.ranges);
    }
    let chainOk = 0;
    for (const cp of cps) {
      if (primaryCoverage && coverageHas(primaryCoverage.ranges, cp)) primaryOk += 1;
      if (coverageHas(chainRanges, cp)) chainOk += 1;
    }
    if (primaryOk === cps.length) coveredByPrimary += 1;
    else {
      if (fallbacks.length) withFallback += 1;
      if (fallbackFiles.some((file) => file && fs.existsSync(file))) withFile += 1;
    }
    if (chainOk === cps.length) coveredByChain += 1;
    else uncovered += 1;
    if (entry) usedKeys.set(entry.key, entry);
    rows.push({
      key: key || '(engine default)',
      family: entry ? entry.family : '(none)',
      weight: entry ? entry.weight : '',
      fallbacks: fallbacks.map((f) => `${f.family}${f.weight || ''}`).join(' + ') || '-',
      primary: primaryCoverage ? pct(primaryOk, cps.length) : 'no file',
      chain: pct(chainOk, cps.length),
      sample: text.replace(/\s+/g, ' ').slice(0, 22),
    });
  });

  process.stdout.write(`layout: ${absJson}\n`);
  process.stdout.write(
    `fonts: ${fonts.length} entr(ies), ${fonts.filter((f) => (f.fallbacks || []).length).length} with fallbacks\n\n`
  );

  const header = ['font', 'family', 'w', 'fallbacks', 'primary', 'with-fb', 'text'];
  const widths = [10, 18, 4, 34, 8, 9, 24];
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' ');
  process.stdout.write(`${line(header)}\n${'-'.repeat(widths.reduce((a, b) => a + b + 1, 0))}\n`);
  for (const row of rows) {
    process.stdout.write(`${line([row.key, row.family, row.weight, row.fallbacks, row.primary, row.chain, row.sample])}\n`);
  }

  // Distribution: which fallback family actually ended up serving the CJK text, and
  // where that choice came from (platformFonts / CSS stack / system table).
  const distribution = new Map();
  walkNodes(layout.root, (node) => {
    const props = node.properties || {};
    if (!props.Text) return;
    if (!cjkCodepoints(String(props.Text)).length) return;
    const fontObject = props.Font && props.Font.FontObject ? String(props.Font.FontObject) : '';
    const entry = byKey.get(fontObject.replace(/^@/, ''));
    if (!entry) return;
    const fallbacks = (entry.fallbacks || []).filter(Boolean);
    const primaryFile = resolveFile(entry.file);
    const primaryCoverage = primaryFile && fs.existsSync(primaryFile) ? fontCoverageForFile(primaryFile, entry.subface || 0) : null;
    const cps = cjkCodepoints(String(props.Text));
    const primaryOk = primaryCoverage ? cps.every((cp) => coverageHas(primaryCoverage.ranges, cp)) : false;
    const used = primaryOk ? null : fallbacks[0];
    const family = used ? used.family : `${entry.family} (primary)`;
    const key = `${family}|${used ? used.source || '?' : 'primary'}`;
    distribution.set(key, (distribution.get(key) || 0) + 1);
  });

  const blocks = CJK_BLOCKS.map((b) => `${b.id}:${blockHits.get(b.id) || 0}`).join(' ');
  process.stdout.write('\n');
  process.stdout.write(`text widgets                 ${textCount}\n`);
  process.stdout.write(`  needing CJK glyphs         ${cjkTextCount}\n`);
  process.stdout.write(`  covered by primary alone   ${coveredByPrimary}\n`);
  process.stdout.write(`  needing a fallback         ${cjkTextCount - coveredByPrimary}\n`);
  process.stdout.write(`    with fallback registered ${withFallback}\n`);
  process.stdout.write(`    with fallback file on disk ${withFile}\n`);
  process.stdout.write(`  covered by primary+fallback ${coveredByChain}\n`);
  process.stdout.write(`  still uncovered            ${uncovered}\n`);
  process.stdout.write(`cjk block hits               ${blocks}\n\n`);
  // Which code point blocks each fallback is responsible for. They MUST be disjoint:
  // Slate picks the smallest matching range and never tries another sub-font once one
  // claims a code point, so two faces sharing a block would make the second unreachable.
  const attributed = [];
  for (const entry of byKey.values()) {
    const entryFallbacks = (entry.fallbacks || []).filter(Boolean);
    if (!entryFallbacks.length) continue;
    const row = { primary: `${entry.key} ${entry.family}`, items: [] };
    for (const fallback of entryFallbacks) {
      const coverage = Array.isArray(fallback.coverage) ? fallback.coverage : null;
      const owned = coverage
        ? CJK_BLOCKS.filter((b) => coverage.some(([first, last]) => first <= b.from && b.to <= last)).map((b) => b.id)
        : [];
      const points = coverage ? coverage.reduce((total, [first, last]) => total + (last - first + 1), 0) : 0;
      row.items.push({ family: fallback.family, source: fallback.source || '?', coverage, owned, points });
    }
    attributed.push(row);
  }
  if (attributed.length) {
    process.stdout.write('\nFallback coverage (block ownership, must be disjoint)\n');
    for (const row of attributed) {
      process.stdout.write(`  ${row.primary}\n`);
      for (const item of row.items) {
        process.stdout.write(
          `    ${item.family.padEnd(20)} ${item.source.padEnd(10)} blocks=${String(item.owned.length).padStart(2)} ` +
            `points=${String(item.points).padStart(6)} ${item.owned.join('+') || '-'}\n`
        );
        const ranges = item.coverage ? item.coverage.map(([first, last]) => `[${first},${last}]`).join(' ') : '(no coverage field)';
        process.stdout.write(`      ${ranges}\n`);
      }
    }
  }

  process.stdout.write('\nCJK fallback distribution\n');
  const distWidth = Math.max(...Array.from(distribution.keys()).map((k) => k.length), 20);
  process.stdout.write(`${'family (source)'.padEnd(distWidth)} texts\n`);
  process.stdout.write(`${'-'.repeat(distWidth + 6)}\n`);
  const ordered = Array.from(distribution.entries()).sort((a, b) => b[1] - a[1]);
  for (const [label, count] of ordered) {
    process.stdout.write(`${label.padEnd(distWidth)} ${String(count).padStart(4)}\n`);
  }
  return uncovered === 0 ? 0 : 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
