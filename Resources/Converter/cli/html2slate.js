#!/usr/bin/env node
'use strict';

/**
 * html2slate - layout.json -> Slate C++ (SCompoundWidget).
 *
 *   node cli/html2slate.js layout.json -o <dir> [--class FH2UPage] [--asset-root /Game/Html2UMG]
 *
 * Writes <Class>.h, <Class>.cpp and H2USlate.h (once per output directory). Colours, corner radii and
 * outlines become FSlateBrush values in code; nothing is baked. Textures referenced by the layout are
 * loaded from their UObject path at construction time.
 */

const fs = require('fs');
const path = require('path');
const { emitSlate } = require('../src/slate/emitter');

function parseArgs(argv) {
  const out = { input: null, dir: null, className: null, assetRoot: '/Game/Html2UMG' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-o' || a === '--out') { out.dir = argv[i + 1]; i += 1; }
    else if (a === '--class') { out.className = argv[i + 1]; i += 1; }
    else if (a === '--asset-root') { out.assetRoot = argv[i + 1]; i += 1; }
    else if (a === '-h' || a === '--help') { out.help = true; }
    else rest.push(a);
  }
  out.input = rest[0] || null;
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.input) {
    console.log('usage: node cli/html2slate.js <layout.json> -o <outDir> [--class FH2UPage] [--asset-root /Game/Html2UMG]');
    process.exit(opts.help ? 0 : 1);
  }
  const layout = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
  const base = path.basename(opts.input).replace(/\.json$/i, '');
  const className = opts.className || 'FH2U' + base.replace(/[^A-Za-z0-9]/g, '_');
  const result = emitSlate(layout, { className: className, assetRoot: opts.assetRoot });

  const dir = opts.dir || path.dirname(opts.input);
  fs.mkdirSync(dir, { recursive: true });
  const headerPath = path.join(dir, className + '.h');
  const sourcePath = path.join(dir, className + '.cpp');
  const helperPath = path.join(dir, 'H2USlate.h');
  fs.writeFileSync(headerPath, result.header, 'utf8');
  fs.writeFileSync(sourcePath, result.source, 'utf8');
  if (!fs.existsSync(helperPath)) fs.writeFileSync(helperPath, result.helper + '\n', 'utf8');

  const nodes = (result.source.match(/SNew\(/g) || []).length;
  console.log('html2slate: ' + opts.input + ' -> ' + dir);
  console.log('  ' + path.basename(headerPath) + ', ' + path.basename(sourcePath) + ', H2USlate.h');
  console.log('  ' + nodes + ' widget expression(s)');
  if (result.warnings.length) {
    console.log('  ' + result.warnings.length + ' warning(s):');
    for (const w of result.warnings.slice(0, 12)) console.log('    ! ' + w);
  }
}

main();
