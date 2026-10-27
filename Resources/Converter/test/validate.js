#!/usr/bin/env node
// Copyright (c) 2026 FPVSkyline. MIT License.
//
// Contract validator for Html2UMG layout JSON.
// Checks everything the importer is allowed to assume:
//   * document fields, contractVersion, viewport, assets
//   * node name legality + global uniqueness
//   * class is a known UMG widget class
//   * every number is finite (no NaN/Infinity)
//   * slot keys exist on the slot class implied by the *parent* container
//   * enum values, colour ranges, brush/slot shape sanity
//   * Fill slots never carry a zero weight (they would collapse in Slate)
//
// Usage:
//   node test/validate.js <layout.json> [...]
//   node test/validate.js                # validates test/out/*.json if present
'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = 1;

const KNOWN_CLASSES = new Set([
  'VerticalBox', 'HorizontalBox', 'WrapBox', 'GridPanel', 'UniformGridPanel', 'CanvasPanel',
  'Overlay', 'Border', 'SizeBox', 'ScaleBox', 'ScrollBox', 'TextBlock', 'Image', 'Button',
  'EditableTextBox', 'ComboBoxString', 'ProgressBar', 'CheckBox', 'Slider', 'Spacer',
  'RichTextBlock', 'NamedSlot', 'RetainerBox', 'SafeZone', 'ExpandableArea', 'ListView',
  'StackBox', 'WidgetSwitcher', 'Throbber', 'CircularThrottle',
  // Added for the effects round: backdrop-filter maps onto UMG's BackgroundBlur.
  'BackgroundBlur',
]);

/** Slot class implied by the *parent* container. */
const SLOT_KEYS = {
  VerticalBox: ['Padding', 'Size', 'HorizontalAlignment', 'VerticalAlignment'],
  HorizontalBox: ['Padding', 'Size', 'HorizontalAlignment', 'VerticalAlignment'],
  WrapBox: ['Padding', 'HorizontalAlignment', 'VerticalAlignment', 'FillSpanWhenLessThan', 'bFillEmptySpace', 'bForceNewLine'],
  CanvasPanel: ['LayoutData', 'bAutoSize', 'ZOrder'],
  GridPanel: ['Padding', 'Row', 'RowSpan', 'Column', 'ColumnSpan', 'Layer', 'HorizontalAlignment', 'VerticalAlignment'],
  UniformGridPanel: ['Row', 'Column', 'HorizontalAlignment', 'VerticalAlignment'],
  Border: ['Padding', 'HorizontalAlignment', 'VerticalAlignment'],
  SizeBox: ['Padding', 'HorizontalAlignment', 'VerticalAlignment'],
  ScaleBox: ['HorizontalAlignment', 'VerticalAlignment'],
  ScrollBox: ['Padding', 'Size', 'HorizontalAlignment', 'VerticalAlignment'],
  Button: ['Padding', 'HorizontalAlignment', 'VerticalAlignment'],
  Overlay: ['Padding', 'HorizontalAlignment', 'VerticalAlignment'],
  BackgroundBlur: ['Padding', 'HorizontalAlignment', 'VerticalAlignment'],
};

/** Slot class name used in messages. */
const SLOT_CLASS = {
  VerticalBox: 'VerticalBoxSlot', HorizontalBox: 'HorizontalBoxSlot', WrapBox: 'WrapBoxSlot',
  CanvasPanel: 'CanvasPanelSlot', GridPanel: 'GridSlot', UniformGridPanel: 'UniformGridSlot',
  Border: 'BorderSlot', SizeBox: 'SizeBoxSlot', ScaleBox: 'ScaleBoxSlot', ScrollBox: 'ScrollBoxSlot',
  Button: 'ButtonSlot', Overlay: 'OverlaySlot',
  // UBackgroundBlur is a UContentWidget with its own UBackgroundBlurSlot.
  BackgroundBlur: 'BackgroundBlurSlot',
};

/** Widgets that can hold at most one child / no children at all. */
const MAX_CHILDREN = {
  Border: 1, SizeBox: 1, ScaleBox: 1, ScrollBox: 1, Button: 1, RetainerBox: 1, SafeZone: 1, BackgroundBlur: 1,
  TextBlock: 0, Image: 0, ProgressBar: 0, EditableTextBox: 0, ComboBoxString: 0,
  CheckBox: 0, Slider: 0, Spacer: 0, Throbber: 0,
};

const H_ALIGN = new Set(['Left', 'Center', 'Right', 'Fill']);
const V_ALIGN = new Set(['Top', 'Center', 'Bottom', 'Fill']);
const SIZE_RULE = new Set(['Automatic', 'Fill']);
const BRUSH_DRAW = new Set(['NoDrawType', 'Box', 'Border', 'Image', 'RoundedBox']);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Report {
  constructor(file) {
    this.file = file;
    this.errors = [];
    this.warnings = [];
    this.stats = { nodes: 0, classes: new Map(), maxDepth: 0, names: 0 };
  }

  error(where, message) {
    this.errors.push(`${where}: ${message}`);
  }

  warn(where, message) {
    this.warnings.push(`${where}: ${message}`);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Deep walk: every number must be finite. */
function checkNumbers(value, where, report) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) report.error(where, `non-finite number (${value})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNumbers(item, `${where}[${index}]`, report));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) checkNumbers(value[key], `${where}.${key}`, report);
  }
}

function checkColor(value, where, report, optional) {
  if (value === undefined) {
    if (!optional) report.error(where, 'missing colour');
    return;
  }
  if (!Array.isArray(value) || value.length !== 4) {
    report.error(where, `expected [r,g,b,a], got ${JSON.stringify(value)}`);
    return;
  }
  for (let i = 0; i < 4; i += 1) {
    if (!isFiniteNumber(value[i])) {
      report.error(where, `component ${i} is not a finite number`);
      return;
    }
    if (value[i] < 0 || value[i] > 1) {
      report.error(where, `component ${i} = ${value[i]} is outside [0,1]`);
      return;
    }
  }
}

function checkMargin(value, where, report) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) {
    report.error(where, `expected [left,top,right,bottom] of finite numbers, got ${JSON.stringify(value)}`);
  }
}

function normalizeClass(name) {
  const text = String(name || '');
  return text.indexOf('.') >= 0 ? text.split('.').pop() : text;
}

/** `/Game/UI/WBP_Card` — a widget blueprint instance (contract §10), not a UMG class. */
function isAssetClass(name) {
  return /^\//.test(String(name || ''));
}

function checkSlot(parentClass, slot, where, report) {
  const allowed = SLOT_KEYS[parentClass];
  if (!allowed) {
    // Unknown/custom container: the importer cannot know the slot class, so any
    // slot payload is a guess. Flag it instead of silently accepting.
    report.warn(where, `container "${parentClass}" has no known slot class but a slot was emitted`);
    return;
  }
  const slotClass = SLOT_CLASS[parentClass] || `${parentClass}Slot`;
  if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) {
    report.error(where, `${slotClass} must be an object`);
    return;
  }
  for (const key of Object.keys(slot)) {
    if (!allowed.includes(key)) {
      report.error(where, `'${key}' is not a property of ${slotClass}`);
    }
  }
  if (slot.Padding !== undefined) checkMargin(slot.Padding, `${where}.Padding`, report);
  if (slot.HorizontalAlignment !== undefined && !H_ALIGN.has(slot.HorizontalAlignment)) {
    report.error(where, `HorizontalAlignment "${slot.HorizontalAlignment}" is not a valid EHorizontalAlignment`);
  }
  if (slot.VerticalAlignment !== undefined && !V_ALIGN.has(slot.VerticalAlignment)) {
    report.error(where, `VerticalAlignment "${slot.VerticalAlignment}" is not a valid EVerticalAlignment`);
  }
  if (slot.Size !== undefined) {
    if (!slot.Size || typeof slot.Size !== 'object') {
      report.error(where, 'Size must be an object');
    } else {
      if (!SIZE_RULE.has(slot.Size.SizeRule)) {
        report.error(where, `Size.SizeRule "${slot.Size.SizeRule}" must be Automatic or Fill`);
      }
      // Regression guard: a Fill slot with weight 0 gets zero space in Slate.
      if (slot.Size.SizeRule === 'Fill' && !(isFiniteNumber(slot.Size.Value) && slot.Size.Value > 0)) {
        report.error(where, `Size.SizeRule is Fill but Value is ${slot.Size.Value} (would collapse to 0 in Slate)`);
      }
      if (slot.Size.SizeRule === 'Automatic' && slot.Size.Value !== undefined && slot.Size.Value !== 0) {
        report.warn(where, `Size.SizeRule is Automatic but Value is ${slot.Size.Value} (ignored by UMG)`);
      }
    }
  }
  if (parentClass === 'CanvasPanel') {
    const data = slot.LayoutData;
    if (!data || typeof data !== 'object') {
      report.error(where, 'CanvasPanelSlot requires LayoutData');
    } else {
      const anchors = data.Anchors;
      if (!anchors || !Array.isArray(anchors.Minimum) || !Array.isArray(anchors.Maximum)) {
        report.error(where, 'LayoutData.Anchors needs Minimum and Maximum');
      } else {
        for (const key of ['Minimum', 'Maximum']) {
          const pair = anchors[key];
          if (pair.length !== 2 || !pair.every(isFiniteNumber)) {
            report.error(where, `Anchors.${key} must be [x,y]`);
          } else if (pair.some((v) => v < 0 || v > 1)) {
            report.warn(where, `Anchors.${key} outside [0,1]: ${JSON.stringify(pair)}`);
          }
        }
      }
      const offsets = data.Offsets;
      if (!offsets || typeof offsets !== 'object') {
        report.error(where, 'LayoutData.Offsets needs {Left,Top,Right,Bottom}');
      } else {
        for (const key of ['Left', 'Top', 'Right', 'Bottom']) {
          if (!isFiniteNumber(offsets[key])) report.error(where, `LayoutData.Offsets.${key} must be a finite number`);
        }
      }
      if (data.Alignment !== undefined && (!Array.isArray(data.Alignment) || data.Alignment.length !== 2)) {
        report.error(where, 'LayoutData.Alignment must be [x,y]');
      }
    }
  }
  if (parentClass === 'GridPanel' || parentClass === 'UniformGridPanel') {
    for (const key of ['Row', 'Column']) {
      if (!isFiniteNumber(slot[key]) || slot[key] < 0) report.error(where, `${key} must be a non-negative integer`);
    }
  }
}

function checkBrush(brush, where, report, assetKeys) {
  if (brush === undefined) return;
  if (!brush || typeof brush !== 'object' || Array.isArray(brush)) {
    report.error(where, 'brush must be an object');
    return;
  }
  if (brush.drawAs !== undefined && !BRUSH_DRAW.has(brush.drawAs)) {
    report.error(where, `brush.drawAs "${brush.drawAs}" is not an ESlateBrushDrawType`);
  }
  if (brush.tint !== undefined) checkColor(brush.tint, `${where}.tint`, report);
  if (brush.outlineColor !== undefined) checkColor(brush.outlineColor, `${where}.outlineColor`, report);
  if (brush.cornerRadii !== undefined) {
    if (!Array.isArray(brush.cornerRadii) || brush.cornerRadii.length !== 4 || !brush.cornerRadii.every(isFiniteNumber)) {
      report.error(where, 'brush.cornerRadii must be [TL,TR,BR,BL] of finite numbers');
    }
  }
  if (brush.texture !== undefined) {
    const ref = String(brush.texture);
    if (ref.startsWith('@') && !assetKeys.textures.has(ref.slice(1))) {
      report.error(where, `brush.texture "${ref}" does not match an entry in assets.textures`);
    }
  }
  if (brush.outlineWidth !== undefined && !isFiniteNumber(brush.outlineWidth)) {
    report.error(where, 'brush.outlineWidth must be a finite number');
  }
}

function checkNode(node, parentClass, where, report, assetKeys) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    report.error(where, 'node must be an object');
    return;
  }
  report.stats.nodes += 1;

  const name = node.name;
  if (typeof name !== 'string' || !name) {
    report.error(where, 'missing "name"');
  } else {
    report.stats.names += 1;
    if (!IDENT_RE.test(name)) {
      report.error(where, `name "${name}" is not a legal identifier`);
    }
    if (assetKeys.names.has(name)) {
      report.error(where, `duplicate name "${name}" (first at ${assetKeys.names.get(name)})`);
    } else {
      assetKeys.names.set(name, where);
    }
  }

  const cls = node.class;
  if (typeof cls !== 'string' || !cls) {
    report.error(where, 'missing "class"');
  } else if (isAssetClass(cls)) {
    // Contract §10: a widget-blueprint instance, not a UMG class.
    report.stats.classes.set('WBP-instance', (report.stats.classes.get('WBP-instance') || 0) + 1);
    if (node.children !== undefined) {
      const slotless = (node.children || []).filter((child) => !child || !child.namedSlot);
      if (slotless.length) {
        report.error(where, `instance "${cls}" may only have children carrying "namedSlot" (${slotless.length} without it)`);
      }
    }
  } else {
    const short = normalizeClass(cls);
    if (!KNOWN_CLASSES.has(short)) {
      report.error(where, `class "${cls}" is not a known UMG widget class`);
    }
    report.stats.classes.set(short, (report.stats.classes.get(short) || 0) + 1);
  }

  if (node.namedSlot !== undefined) {
    if (typeof node.namedSlot !== 'string' || !node.namedSlot) {
      report.error(where, '"namedSlot" must be a non-empty string');
    }
    if (node.slot !== undefined) {
      report.error(where, 'a named-slot child must not carry its own "slot" (layout comes from the reused widget)');
    }
  }

  if (node.variable !== undefined && typeof node.variable !== 'boolean') {
    report.error(where, '"variable" must be a boolean');
  }
  if (node.source !== undefined && typeof node.source !== 'string') {
    report.error(where, '"source" must be a string');
  }
  if (node.properties !== undefined && (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties))) {
    report.error(where, '"properties" must be an object');
  }
  checkNumbers(node.properties, `${where}.properties`, report);
  checkNumbers(node.slot, `${where}.slot`, report);

  if (parentClass !== null) {
    // A child of a widget instance is named-slot content, not a laid-out slot.
    if (typeof parentClass === 'string' && isAssetClass(parentClass)) {
      if (node.namedSlot === undefined) {
        report.error(where, `missing "namedSlot" (parent "${parentClass}" is a widget instance)`);
      }
    } else if (node.slot === undefined) {
      report.error(where, `missing slot (parent is ${parentClass})`);
    } else {
      checkSlot(parentClass, node.slot, `${where}.slot`, report);
    }
  } else if (node.slot !== undefined) {
    report.warn(where, 'the root node should not carry a slot');
  }

  checkBrush(node.brush, `${where}.brush`, report, assetKeys);

  const children = node.children;
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      report.error(where, '"children" must be an array');
    } else {
      const short = normalizeClass(cls);
      const max = MAX_CHILDREN[short];
      if (max !== undefined && children.length > max) {
        report.error(where, `"${short}" accepts at most ${max} child(ren), got ${children.length}`);
      }
      children.forEach((child, index) => {
        checkNode(child, normalizeClass(cls), `${where}.${node.name || '?'}[${index}]`, report, assetKeys);
      });
    }
  }
}

function validate(file) {
  const report = new Report(file);
  let layout;
  try {
    layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    report.error('file', `cannot read/parse: ${err.message}`);
    return report;
  }

  const assetKeys = { textures: new Set(), fonts: new Set(), names: new Map() };

  if (layout.contractVersion !== CONTRACT_VERSION) {
    report.error('contractVersion', `expected ${CONTRACT_VERSION}, got ${JSON.stringify(layout.contractVersion)}`);
  }
  if (typeof layout.generator !== 'string' || !layout.generator) {
    report.error('generator', 'missing generator string');
  }
  if (typeof layout.source !== 'string' || !layout.source) {
    report.error('source', 'missing source path');
  }
  if (typeof layout.blueprint !== 'string' || !layout.blueprint.startsWith('/')) {
    report.error('blueprint', `expected a package path like /Game/UI/WBP_Design, got ${JSON.stringify(layout.blueprint)}`);
  }
  if (!layout.viewport || !isFiniteNumber(layout.viewport.width) || !isFiniteNumber(layout.viewport.height)) {
    report.error('viewport', 'needs finite width/height');
  } else if (layout.viewport.width <= 0 || layout.viewport.height <= 0) {
    report.error('viewport', 'must be positive');
  }
  if (!Array.isArray(layout.warnings) || !layout.warnings.every((w) => typeof w === 'string')) {
    report.error('warnings', 'must be an array of strings');
  }

  const assets = layout.assets || {};
  const baseDir = path.dirname(path.resolve(file));
  const checkAssetList = (list, kind, keySet) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      report.error(`assets.${kind}`, 'must be an array');
      return;
    }
    for (const entry of list) {
      const where = `assets.${kind}[${entry && entry.key}]`;
      if (!entry || typeof entry.key !== 'string' || !entry.key) {
        report.error(where, 'missing key');
        continue;
      }
      if (kind === 'textures' && !/^tex_/.test(entry.key)) report.warn(where, 'texture key does not start with tex_');
      if (kind === 'fonts' && !/^font_/.test(entry.key)) report.warn(where, 'font key does not start with font_');
      if (keySet.has(entry.key)) report.error(where, 'duplicate key');
      keySet.add(entry.key);
      if (entry.file !== undefined && typeof entry.file !== 'string') {
        report.error(where, 'file must be a string');
      } else if (entry.file) {
        const abs = path.isAbsolute(entry.file) ? entry.file : path.join(baseDir, entry.file);
        if (!fs.existsSync(abs)) report.error(where, `file not found: ${entry.file}`);
      } else if (kind === 'textures') {
        report.error(where, 'texture entries must reference a file');
      }
      if (kind === 'fonts') {
        if (typeof entry.family !== 'string' || !entry.family) report.error(where, 'missing family');
        if (!isFiniteNumber(entry.weight)) report.error(where, 'missing numeric weight');
        if (typeof entry.italic !== 'boolean') report.error(where, 'italic must be a boolean');
      }
    }
  };
  checkAssetList(assets.textures, 'textures', assetKeys.textures);
  checkAssetList(assets.fonts, 'fonts', assetKeys.fonts);

  if (!layout.root) {
    report.error('root', 'missing root node');
    return report;
  }
  checkNode(layout.root, null, 'root', report, assetKeys);
  checkNumbers(layout.root, 'root', report);

  if (report.stats.nodes === 0) report.error('root', 'no widgets in the tree');
  return report;
}

function summarizeFile(report) {
  const classes = Array.from(report.stats.classes.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join('  ');
  return { classes, nodes: report.stats.nodes };
}

const CONVERT_HINT = [
  'Produce the json first (this step needs the browser):',
  '  node cli/convert.js test/01-flex.html      -o test/out/01-flex.json',
  '  node cli/convert.js test/02-absolute.html  -o test/out/02-absolute.json',
  '  node cli/convert.js test/03-dashboard.html -o test/out/03-dashboard.json',
  '  node cli/convert.js test/04-form.html      -o test/out/04-form.json',
  'then:',
  '  node test/validate.js test/out        (a directory validates every *.json in it)',
  '  node test/validate.js test/out/03-dashboard.json',
].join('\n');

function main(argv) {
  let inputs = argv.filter((arg) => !arg.startsWith('-'));
  const quiet = argv.includes('-q') || argv.includes('--quiet');

  if (!inputs.length) {
    const defaultDir = path.join(__dirname, 'out');
    if (fs.existsSync(defaultDir)) inputs = [defaultDir];
    if (!inputs.length) {
      process.stderr.write(`usage: node test/validate.js <file.json | directory> [...]\n\n${CONVERT_HINT}\n`);
      return 1;
    }
  }

  // Expand directories, and fail loudly (with the command to fix it) when a path
  // does not exist — silently validating nothing is worse than an error.
  const files = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      process.stderr.write(`error: no such file or directory: ${input}\n\n${CONVERT_HINT}\n`);
      return 1;
    }
    if (fs.statSync(input).isDirectory()) {
      const found = fs
        .readdirSync(input)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(input, name));
      if (!found.length) {
        process.stderr.write(`error: ${input} contains no *.json\n\n${CONVERT_HINT}\n`);
        return 1;
      }
      files.push(...found);
    } else {
      files.push(input);
    }
  }

  let failures = 0;
  let totalWarnings = 0;
  for (const file of files) {
    const report = validate(file);
    const summary = summarizeFile(report);
    const status = report.errors.length ? 'FAIL' : 'ok  ';
    if (report.errors.length) failures += 1;
    totalWarnings += report.warnings.length;
    if (!quiet || report.errors.length) {
      process.stdout.write(`${status} ${path.relative(process.cwd(), file) || file}  ${summary.nodes} widgets\n`);
      if (!quiet) process.stdout.write(`       ${summary.classes}\n`);
    }
    for (const error of report.errors) process.stdout.write(`  ✗ ${error}\n`);
    if (report.warnings.length) {
      for (const warning of report.warnings.slice(0, quiet ? 3 : 10)) process.stdout.write(`  ! ${warning}\n`);
      if (report.warnings.length > 10) process.stdout.write(`  ! ... ${report.warnings.length - 10} more\n`);
    }
  }
  process.stdout.write(
    `\n${files.length} file(s): ${files.length - failures} passed, ${failures} failed, ${totalWarnings} warning(s)\n`
  );
  return failures ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { validate, KNOWN_CLASSES, SLOT_KEYS, SLOT_CLASS };
