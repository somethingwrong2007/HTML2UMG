#!/usr/bin/env node
'use strict';

/**
 * Slate output test suite (fast tier - no engine needed).
 *
 * For every fixture: HTML -> layout.json (converter) -> Slate C++ (html2slate), then assert the things
 * that can be checked without compiling:
 *
 *   - the conversion succeeds and every node carries the measured rect (Slate pins sizes from it)
 *   - the emitted widget classes are the expected ones
 *   - no class was silently dropped ("no Slate mapping" is a failure, not a warning)
 *   - the emitter is deterministic: two runs produce identical source
 *
 * usage: node test/slate/run_slate_tests.js [--keep] [--filter <substr>]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONVERTER = path.resolve(__dirname, '../..');
const OUT = path.resolve(CONVERTER, '../../.dsh-scratch/slate-tests');

const FIXTURES = [
  {
    name: '23-slate-canvas',
    viewport: '640x400',
    expect: [
      ['SConstraintCanvas', 1],
      ['SBorder', 3],
      ['STextBlock', 2],
    ],
    // far-edge anchored box must keep its px anchor, not a measured ratio
    expectSource: [/right: |\.Anchors\(FAnchors\(1\.0f, 1\.0f/],
    allowWarnings: [],
  },
  {
    name: '24-slate-controls',
    viewport: '520x420',
    expect: [
      ['SCheckBox', 1],
      ['SSlider', 1],
      ['SProgressBar', 1],
      ['SEditableTextBox', 1],
      ['SSpinBox', 1],
      ['SComboBox', 1],
    ],
    allowWarnings: [/FCheckBoxStyle|FSliderStyle|editable text box/],
  },
  {
    name: '25-slate-switcher',
    viewport: '480x200',
    expect: [
      ['SWidgetSwitcher', 1],
      ['SProgressBar', 2],
      ['STextBlock', 4],
    ],
    expectSource: [/PAGE A/, /PAGE B/],
    allowWarnings: [],
  },
];

function parse(argv) {
  const o = { keep: false, filter: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') o.keep = true;
    else if (argv[i] === '--filter') { o.filter = argv[i + 1]; i += 1; }
  }
  return o;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function checkFixture(fixture, opts) {
  const dir = path.join(OUT, fixture.name);
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(CONVERTER, 'test', fixture.name + '.html');
  const json = path.join(dir, 'layout.json');
  const slateDir = path.join(dir, 'slate');

  const failures = [];
  const notes = [];

  try {
    run(process.execPath, ['cli/convert.js', html, '-o', json, '--assets', path.join(dir, 'assets'),
      '--viewport', fixture.viewport, '--font-policy=engine', '--font-map=ignore'], CONVERTER);
  } catch (err) {
    failures.push('conversion failed: ' + (err.stderr || err.message).toString().slice(0, 300));
    return { failures, notes };
  }

  const layout = JSON.parse(fs.readFileSync(json, 'utf8'));
  let nodes = 0;
  let withoutRect = 0;
  (function walk(n) {
    if (!n) return;
    nodes += 1;
    if (!Array.isArray(n.rect) || n.rect.length < 4) withoutRect += 1;
    (n.children || []).forEach(walk);
  })(layout.root);
  if (withoutRect > 0) failures.push(withoutRect + '/' + nodes + ' node(s) carry no measured rect');
  notes.push(nodes + ' node(s)');

  const emitOnce = () => {
    if (fs.existsSync(slateDir)) fs.rmSync(slateDir, { recursive: true, force: true });
    run(process.execPath, ['cli/html2slate.js', json, '-o', slateDir, '--class', 'FH2UTest',
      '--asset-root', '/Game/Html2UMG'], CONVERTER);
    return {
      header: fs.readFileSync(path.join(slateDir, 'FH2UTest.h'), 'utf8'),
      source: fs.readFileSync(path.join(slateDir, 'FH2UTest.cpp'), 'utf8'),
      helper: fs.readFileSync(path.join(slateDir, 'H2USlate.h'), 'utf8'),
    };
  };

  const first = emitOnce();
  const second = emitOnce();
  if (first.source !== second.source || first.header !== second.header) {
    failures.push('emitter is not deterministic (two runs differ)');
  }

  for (const [klass, want] of fixture.expect) {
    const got = (first.source.match(new RegExp('SNew\\(' + klass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (got < want) failures.push(klass + ': expected at least ' + want + ', got ' + got);
  }

  for (const re of fixture.expectSource || []) {
    const target = re.source.indexOf('Anchors') >= 0 || re.source.indexOf('right: ') >= 0 ? first.source + first.source : first.source;
    if (!re.test(target) && !re.test(first.helper)) {
      failures.push('source does not match ' + re);
    }
  }

  // Every warning is printed by the emitter; a missing mapping is a hard failure.
  try {
    const out = run(process.execPath, ['cli/html2slate.js', json, '-o', slateDir, '--class', 'FH2UTest',
      '--asset-root', '/Game/Html2UMG'], CONVERTER);
    const warned = (out.match(/^\s+! (.+)$/gm) || []).map((l) => l.replace(/^\s+! /, ''));
    for (const w of warned) {
      if (/no Slate mapping/.test(w)) failures.push('unmapped class: ' + w);
      const allowed = (fixture.allowWarnings || []).some((re) => re.test(w));
      if (!allowed) notes.push('warning: ' + w);
    }
  } catch (err) {
    failures.push('second emit failed: ' + (err.stderr || err.message).toString().slice(0, 200));
  }

  if (!opts.keep) {
    fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
  }
  return { failures, notes };
}

function main() {
  const opts = parse(process.argv.slice(2));
  const fixtures = FIXTURES.filter((f) => !opts.filter || f.name.indexOf(opts.filter) >= 0);
  let failed = 0;
  for (const fixture of fixtures) {
    const { failures, notes } = checkFixture(fixture, opts);
    const status = failures.length ? 'FAIL' : 'ok  ';
    console.log(status + '  ' + fixture.name + (notes.length ? '  (' + notes.join('; ') + ')' : ''));
    for (const f of failures) console.log('        ! ' + f);
    if (failures.length) failed += 1;
  }
  console.log('');
  console.log(fixtures.length + ' fixture(s): ' + (fixtures.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main();
