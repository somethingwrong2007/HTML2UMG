#!/usr/bin/env node
'use strict';

/**
 * html2slate-pack - several layout JSONs -> one set of generated Slate widgets plus a registry.
 *
 * The engine-side test harness needs to render a generated widget by NAME, and SWidget is not a
 * UObject, so there is nothing to look up at runtime. This emits a tiny factory that maps a name to
 * SNew(<Class>), which is what lets one build serve every fixture.
 *
 *   node cli/html2slate-pack.js fixtures/a.json fixtures/b.json -o <dir>
 */

const fs = require('fs');
const path = require('path');
const { emitSlate } = require('../src/slate/emitter');

function classNameFor(file) {
  const base = path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9]/g, '_');
  return 'FH2U' + base.charAt(0).toUpperCase() + base.slice(1);
}

function main() {
  const argv = process.argv.slice(2);
  let dir = '.';
  const inputs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-o' || argv[i] === '--out') { dir = argv[i + 1]; i += 1; }
    else if (argv[i] === '--asset-root') { dir = dir; i += 1; }
    else inputs.push(argv[i]);
  }
  if (!inputs.length) {
    console.log('usage: node cli/html2slate-pack.js <layout.json...> -o <dir>');
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const classes = [];
  let helperWritten = false;
  let warnings = 0;
  for (const file of inputs) {
    const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
    const className = classNameFor(file);
    const result = emitSlate(layout, { className: className, assetRoot: '/Game/Html2UMG' });
    fs.writeFileSync(path.join(dir, className + '.h'), result.header, 'utf8');
    fs.writeFileSync(path.join(dir, className + '.cpp'), result.source, 'utf8');
    if (!helperWritten) { fs.writeFileSync(path.join(dir, 'H2USlate.h'), result.helper + '\n', 'utf8'); helperWritten = true; }
    classes.push(className);
    warnings += result.warnings.length;
    console.log('  ' + className + '  <- ' + path.basename(file) + '  (' + result.warnings.length + ' warning(s))');
  }

  const header = ['#pragma once', '', '#include "CoreMinimal.h"', '',
    '/** Factory over the generated widgets: the engine-side harness renders one by name. */',
    'TSharedPtr<SWidget> H2USlateMakeGenerated(const FString& Name);', ''].join('\n');
  const source = [];
  source.push('#include "H2USlateGenerated.h"');
  source.push('');
  for (const cls of classes) source.push('#include "' + cls + '.h"');
  source.push('');
  source.push('TSharedPtr<SWidget> H2USlateMakeGenerated(const FString& Name)');
  source.push('{');
  for (const cls of classes) {
    source.push('    if (Name == TEXT("' + cls + '")) return SNew(' + cls + ');');
  }
  source.push('    return nullptr;');
  source.push('}');
  source.push('');
  fs.writeFileSync(path.join(dir, 'H2USlateGenerated.h'), header, 'utf8');
  fs.writeFileSync(path.join(dir, 'H2USlateGenerated.cpp'), source.join('\n'), 'utf8');
  console.log('pack: ' + classes.length + ' widget(s) + registry -> ' + dir + (warnings ? '  (' + warnings + ' warning(s))' : ''));
}

main();