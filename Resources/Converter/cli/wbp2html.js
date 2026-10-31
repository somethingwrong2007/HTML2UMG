#!/usr/bin/env node
'use strict';

/**
 * wbp2html - turn a widget-blueprint layout export back into HTML/CSS.
 *
 *   UnrealEditor-Cmd.exe <proj> -ExecCmds="Html2UMG.ExportLayout /Game/UI/WBP_X --json=out/x.json --assets=out/x_assets --viewport=1920x400, QUIT_EDITOR"
 *   node cli/wbp2html.js out/x.json -o out/x.html
 *
 * The HTML is a faithful starting point, not a screenshot: everything CSS can express is
 * converted (geometry from the slot objects, colours back through the linear->sRGB step, type
 * through the pt->px step), and everything it cannot keeps a data-ue-* marker so that
 * re-converting it reproduces the same widget classes and names.
 */

const fs = require('fs');
const path = require('path');
const { toHtml } = require('../src/tohtml');

function usage() {
  console.log('usage: node cli/wbp2html.js <layout.json> [-o out.html] [--assets-root <dir>] [--strict]');
  console.log('');
  console.log('  <layout.json>      written by Html2UMG.ExportLayout');
  console.log('  -o, --out          output html (default: the json path with .html)');
  console.log('  --assets-root      directory the json asset paths resolve against (default: the json directory)');
  console.log('  --strict           exit 2 when any warning was produced');
}

function main(argv) {
  const args = argv.slice();
  let input = null;
  let out = null;
  let assetRoot = null;
  let strict = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-o' || arg === '--out') out = args[++i];
    else if (arg.indexOf('--out=') === 0) out = arg.slice(6);
    else if (arg === '--assets-root') assetRoot = args[++i];
    else if (arg.indexOf('--assets-root=') === 0) assetRoot = arg.slice(14);
    else if (arg === '--strict') strict = true;
    else if (arg === '-h' || arg === '--help') { usage(); return 0; }
    else if (!input) input = arg;
    else { console.error('unexpected argument: ' + arg); usage(); return 1; }
  }

  if (!input) { usage(); return 1; }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error('layout json not found: ' + inputPath);
    return 1;
  }

  let layout;
  try {
    layout = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    console.error('cannot parse ' + inputPath + ': ' + err.message);
    return 1;
  }
  if (!layout || !layout.root) {
    console.error('this json has no root widget; export it with Html2UMG.ExportLayout');
    return 1;
  }

  const root = assetRoot ? path.resolve(assetRoot) : path.dirname(inputPath);
  const outPath = path.resolve(out || inputPath.replace(/\.json$/i, '') + '.html');

  const result = toHtml(layout, { assetRoot: root });
  fs.writeFileSync(outPath, result.html, 'utf8');

  console.log('wbp2html: ' + inputPath);
  console.log('  -> ' + outPath + '  (' + (result.html.length / 1024).toFixed(1) + ' KB)');
  const names = [];
  (function collect(n) { if (!n) return; names.push(n.name); (n.children || []).forEach(collect); })(layout.root);
  console.log('  widgets ' + names.length + ', viewport ' + (layout.viewport ? layout.viewport.width + 'x' + layout.viewport.height : 'unknown'));
  if (result.warnings.length) {
    console.log('  warnings ' + result.warnings.length + ':');
    for (const w of result.warnings) console.log('    ! ' + w);
  }
  return strict && result.warnings.length ? 2 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };