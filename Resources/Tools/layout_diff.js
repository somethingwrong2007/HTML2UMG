#!/usr/bin/env node
'use strict';

/**
 * layout_diff - compare two layout JSONs that describe the same widget tree.
 *
 * It understands both shapes the pipeline produces:
 *   Html2UMG.ExportLayout  flat dotted properties, brush as Background.* keys
 *   cli/convert.js         nested properties, brush as a `brush` object, slot objects
 * so it can answer the round-trip question: WBP -> JSON -> HTML -> JSON, did anything move?
 *
 *   node Resources/Tools/layout_diff.js a.json b.json [--tolerance 1] [--verbose]
 *
 * Exit code 1 when a structural difference or an out-of-tolerance numeric difference is found.
 */

const fs = require('fs');

const NL = String.fromCharCode(10);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function flat(node) {
  return node.properties || {};
}

function brushOf(node) {
  const pr = flat(node);
  // UImage spells its brush "Brush", UBorder "Background"; read whichever is present.
  const prefix = pr['Background.DrawAs'] !== undefined || pr['Background.TintColor'] !== undefined
    ? 'Background'
    : (pr['Brush.DrawAs'] !== undefined || pr['Brush.TintColor'] !== undefined ? 'Brush' : 'Background');
  if (node.brush) {
    return {
      drawAs: node.brush.drawAs === undefined ? null : node.brush.drawAs,
      tint: node.brush.tint === undefined ? null : node.brush.tint,
      radii: node.brush.cornerRadii === undefined ? null : node.brush.cornerRadii,
      outlineWidth: num(node.brush.outlineWidth) || 0,
      outlineColor: node.brush.outlineColor === undefined ? null : node.brush.outlineColor,
    };
  }
  const at = (key) => (pr[prefix + '.' + key] === undefined ? null : pr[prefix + '.' + key]);
  return {
    drawAs: at('DrawAs'),
    tint: at('TintColor'),
    radii: at('OutlineSettings.CornerRadii'),
    outlineWidth: num(pr[prefix + '.OutlineSettings.Width']) || 0,
    outlineColor: at('OutlineSettings.Color'),
  };
}

function normalize(node) {
  const pr = flat(node);
  const f = brushOf(node);
  // The export writes dotted keys (Font.Size); the converter writes nested objects (Font: {Size}).
  const font = pr.Font || {};
  const fontSize = font.Size === undefined ? num(pr['Font.Size']) : num(font.Size);
  return {
    class: node.class,
    name: node.name,
    slot: node.slot || null,
    width: pr.bOverride_WidthOverride ? num(pr.WidthOverride) : null,
    height: pr.bOverride_HeightOverride ? num(pr.HeightOverride) : null,
    minWidth: pr.bOverride_MinDesiredWidth ? num(pr.MinDesiredWidth) : null,
    maxWidth: pr.bOverride_MaxDesiredWidth ? num(pr.MaxDesiredWidth) : null,
    padding: Array.isArray(pr.Padding) ? pr.Padding.map(num) : null,
    paddingFromBrush: null,
    // "Inherit" is the export spelling of "not set"; the converter omits it.
    clipping: pr.Clipping === undefined || pr.Clipping === 'Inherit' ? null : pr.Clipping,
    drawAs: f.drawAs,
    tint: f.tint,
    radii: f.radii,
    outlineWidth: f.outlineWidth,
    text: pr.Text === undefined ? null : pr.Text,
    fontSize,
    color: pr.ColorAndOpacity === undefined ? null : pr.ColorAndOpacity,
    justification: pr.Justification === undefined ? null : pr.Justification,
    autoWrap: pr.AutoWrapText === undefined ? null : pr.AutoWrapText,
    namedSlot: node.namedSlot === undefined ? null : node.namedSlot,
    hidden: node.wasHidden === undefined ? null : node.wasHidden,
  };
}

function walk(node, path, out, parentClass, parentName) {
  if (!node) return;
  out.push({ path, parentClass: parentClass || null, parentName: parentName || null, data: normalize(node) });
  (node.children || []).forEach((c, i) => walk(c, path + '/' + i, out, node.class, node.name));
}

function nearlyEqual(a, b, tol) {
  const la = a === undefined ? null : a;
  const lb = b === undefined ? null : b;
  if (la === null && lb === null) return true;
  if (la === null || lb === null) return false;
  const na = num(a);
  const nb = num(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= tol;
}

const NUMERIC_SLOT_KEYS = ['Left', 'Top', 'Right', 'Bottom'];

/** An all-zero Padding and no Padding at all are the same thing. */
function normPadding(padding) {
  if (!Array.isArray(padding)) return null;
  const nums = padding.map((v) => num(v) || 0);
  return nums.some((v) => Math.abs(v) > 0.01) ? nums : null;
}

/** UMG spells an unset alignment as absent; the converter writes 'Fill'. */
function align(v) {
  return v === undefined || v === null || v === '' ? 'Fill' : v;
}

/** For a box slot only the CROSS axis is meaningful: the main axis is carried by Padding. */
function crossAxisOf(parentClass) {
  if (parentClass === 'VerticalBox') return 'HorizontalAlignment';
  if (parentClass === 'HorizontalBox') return 'VerticalAlignment';
  return null;
}

function compareSlots(a, b, tol, notes, path, parentClass, hasNamedSlot) {
  // A NamedSlot's children carry no layout of their own (the slot decides it), and the converter
  // does not emit a slot for them at all.
  if (hasNamedSlot) return;
  if (!a && !b) return;
  if (!a || !b) {
    const only = a || b;
    const keys = Object.keys(only || {}).filter((k) => k !== 'bAutoSize' && k !== 'slotClass');
    if (keys.length === 0) return;
    notes.push('slot ' + path + ': one side has a slot, the other has ' + (only ? JSON.stringify(only).slice(0, 60) : 'none'));
    return;
  }
  const ldA = a.LayoutData || null;
  const ldB = b.LayoutData || null;
  if (ldA || ldB) {
    if (!ldA || !ldB) { notes.push('slot ' + path + ': one side is a canvas slot, the other is not'); return; }
    for (const key of NUMERIC_SLOT_KEYS) {
      const va = num((ldA.Offsets || {})[key]);
      const vb = num((ldB.Offsets || {})[key]);
      if (!nearlyEqual(va === null ? null : va, vb === null ? null : vb, tol)) {
        notes.push('slot ' + path + ': Offsets.' + key + ' ' + va + ' vs ' + vb + ' (>' + tol + ')');
      }
    }
    for (const key of ['Minimum', 'Maximum', 'Alignment']) {
      const va = (ldA.Anchors && ldA.Anchors[key]) || (key === 'Alignment' ? ldA.Alignment : null);
      const vb = (ldB.Anchors && ldB.Anchors[key]) || (key === 'Alignment' ? ldB.Alignment : null);
      if (JSON.stringify(va) !== JSON.stringify(vb)) notes.push('slot ' + path + ': ' + key + ' ' + JSON.stringify(va) + ' vs ' + JSON.stringify(vb));
    }
    return;
  }
  const sa = a.Size || {};
  const sb = b.Size || {};
  if (sa.SizeRule !== sb.SizeRule) notes.push('slot ' + path + ': SizeRule ' + sa.SizeRule + ' vs ' + sb.SizeRule);
  else if (sa.SizeRule === 'Fill' && !nearlyEqual(sa.Value, sb.Value, 0.01)) {
    notes.push('slot ' + path + ': fill weight ' + sa.Value + ' vs ' + sb.Value);
  }
  const pa = Array.isArray(a.Padding) ? a.Padding : [0, 0, 0, 0];
  const pb = Array.isArray(b.Padding) ? b.Padding : [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    if (!nearlyEqual(num(pa[i]) || 0, num(pb[i]) || 0, tol)) {
      notes.push('slot ' + path + ': Padding[' + i + '] ' + pa[i] + ' vs ' + pb[i] + ' (>' + tol + ')');
    }
  }
  const cross = crossAxisOf(parentClass);
  if (cross && align(a[cross]) !== align(b[cross])) {
    notes.push('slot ' + path + ': cross alignment ' + cross + ' ' + align(a[cross]) + ' vs ' + align(b[cross]));
  }
}

function main(argv) {
  const files = [];
  let tol = 1;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tolerance') tol = Number(argv[++i]);
    else if (a.indexOf('--tolerance=') === 0) tol = Number(a.slice(12));
    else if (a === '--verbose') verbose = true;
    else files.push(a);
  }
  if (files.length < 2) {
    console.log('usage: node layout_diff.js <a.json> <b.json> [--tolerance 1] [--verbose]');
    return 1;
  }
  const A = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const B = JSON.parse(fs.readFileSync(files[1], 'utf8'));
  const listA = [];
  const listB = [];
  walk(A.root, '', listA, null, null);
  walk(B.root, '', listB, null, null);

  const notes = [];
  const byNameA = new Map();
  for (const e of listA) byNameA.set(e.data.name, e);
  const byNameB = new Map();
  for (const e of listB) byNameB.set(e.data.name, e);
  // Folding: the reverse generator merges a redundant SizeBox/Border into the element it wrapped, so
  // a child that sat inside such a wrapper directly carries the wrapper's slot in B. That is the
  // intended difference, not a regression, so a node whose A-side parent vanished is not compared.

  const onlyA = [...byNameA.keys()].filter((n) => !byNameB.has(n));
  const onlyB = [...byNameB.keys()].filter((n) => !byNameA.has(n));
  if (onlyA.length) notes.push('only in ' + files[0] + ': ' + onlyA.join(', '));
  if (onlyB.length) notes.push('only in ' + files[1] + ': ' + onlyB.join(', '));

  for (const [name, ea] of byNameA) {
    const eb = byNameB.get(name);
    if (!eb) continue;
    const a = ea.data;
    const b = eb.data;
    if (a.class !== b.class) notes.push(name + ': class ' + a.class + ' vs ' + b.class);
    // A node whose A-side parent was a wrapper that got folded away now owns the wrapper's slot.
    const parentFolded = ea.parentName !== null && !byNameB.has(ea.parentName);
    compareSlots(a.slot, b.slot, tol, notes, name, eb.parentClass,
      a.namedSlot !== null || b.namedSlot !== null || parentFolded);
    for (const key of ['width', 'height', 'minWidth', 'maxWidth']) {
      if (!nearlyEqual(a[key], b[key], tol)) notes.push(name + ': ' + key + ' ' + a[key] + ' vs ' + b[key]);
    }
    for (const key of ['drawAs', 'justification', 'autoWrap', 'clipping', 'text', 'namedSlot']) {
      if ((a[key] || null) !== (b[key] || null)) notes.push(name + ': ' + key + ' ' + JSON.stringify(a[key]) + ' vs ' + JSON.stringify(b[key]));
    }
    if (!nearlyEqual(a.fontSize, b.fontSize, 0.01)) notes.push(name + ': font-size ' + a.fontSize + ' vs ' + b.fontSize);
    const pa = normPadding(a.padding);
    const pb = normPadding(b.padding);
    if (JSON.stringify(pa) !== JSON.stringify(pb)) notes.push(name + ': padding ' + JSON.stringify(pa) + ' vs ' + JSON.stringify(pb));
    const tintA = Array.isArray(a.tint) ? a.tint.slice(0, 3) : null;
    const tintB = Array.isArray(b.tint) ? b.tint.slice(0, 3) : null;
    if (tintA && tintB) {
      for (let i = 0; i < 3; i++) {
        if (Math.abs(Number(tintA[i]) - Number(tintB[i])) > 0.02) {
          notes.push(name + ': colour channel ' + i + ' ' + tintA[i] + ' vs ' + tintB[i]);
          break;
        }
      }
    }
    const rA = Array.isArray(a.radii) ? a.radii : null;
    const rB = Array.isArray(b.radii) ? b.radii : null;
    if (rA && rB) {
      for (let i = 0; i < Math.min(rA.length, rB.length); i++) {
        if (Math.abs(Number(rA[i]) - Number(rB[i])) > tol) {
          notes.push(name + ': corner radius ' + i + ' ' + rA[i] + ' vs ' + rB[i]);
          break;
        }
      }
    }
    if (!nearlyEqual(a.outlineWidth, b.outlineWidth, 0.05)) notes.push(name + ': outline width ' + a.outlineWidth + ' vs ' + b.outlineWidth);
  }

  console.log('layout_diff: ' + files[0] + ' (' + listA.length + ' widgets) vs ' + files[1] + ' (' + listB.length + ' widgets)');
  if (!notes.length) {
    console.log('  no differences beyond tolerance ' + tol);
    return 0;
  }
  for (const n of notes.slice(0, verbose ? notes.length : 40)) console.log('  ! ' + n);
  if (!verbose && notes.length > 40) console.log('  ... ' + (notes.length - 40) + ' more');
  console.log('  ' + notes.length + ' difference(s)');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };