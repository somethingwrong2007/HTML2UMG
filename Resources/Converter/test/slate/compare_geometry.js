#!/usr/bin/env node
'use strict';

/**
 * Compares the geometry Slate actually produced with the layout rects the design measured.
 *
 *   node test/slate/compare_geometry.js <layout.json> <render.png.geom.json>
 *
 * Both sides are walked in document order and paired by widget class, which is what makes the result
 * readable: "4 text blocks, worst position error 3px" is a finding, "8.3% of pixels differ" is not.
 */

const fs = require('fs');

const PAIRS = {
  STextBlock: 'TextBlock',
  SProgressBar: 'ProgressBar',
  SSlider: 'Slider',
  SCheckBox: 'CheckBox',
  SEditableTextBox: 'EditableTextBox',
  SSpinBox: 'SpinBox',
  SComboBox: 'ComboBoxString',
  SImage: 'Image',
};

function jsonNodes(layout) {
  const byClass = {};
  (function walk(n) {
    if (!n) return;
    const cls = String(n.class || '');
    const isSwitcher = /Switcher/.test(cls);
    if (Array.isArray(n.rect) && n.rect.length >= 4) {
      (byClass[cls] = byClass[cls] || []).push({ rect: n.rect, name: n.name });
    }
    // SWidgetSwitcher::GetChildren() returns only the ACTIVE page (the engine returns a proxy that
    // filters to the child being shown), so the rendered tree can only ever contain that page. Compare
    // against the same page instead of reporting every hidden page as missing.
    if (isSwitcher) {
      const index = Number((n.properties || {}).ActiveWidgetIndex) || 0;
      const kid = (n.children || [])[index];
      if (kid) walk(kid);
      return;
    }
    (n.children || []).forEach(walk);
  })(layout.root);
  return byClass;
}

function slateNodes(geom) {
  // Slate reports templated widgets as "SSpinBox<float>" / "SComboBox<...>", so match on the prefix
  // rather than on an exact type name - an exact match silently reported "slate=0" for widgets that
  // were right there in the tree.
  const byType = {};
  for (const w of geom.widgets || []) {
    const type = String(w.type || '').replace(/<.*$/, '');
    (byType[type] = byType[type] || []).push(w);
  }
  return byType;
}

function main() {
  const [layoutFile, geomFile] = process.argv.slice(2);
  if (!layoutFile || !geomFile) {
    console.log('usage: node test/slate/compare_geometry.js <layout.json> <render.png.geom.json>');
    process.exit(1);
  }
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  const geom = JSON.parse(fs.readFileSync(geomFile, 'utf8'));
  const want = jsonNodes(layout);
  const got = slateNodes(geom);

  console.log(geom.widget + ': ' + (geom.widgets || []).length + ' Slate widget(s), viewport ' + geom.width + 'x' + geom.height);
  let worstPos = 0;
  let worstSize = 0;
  let compared = 0;
  for (const [slateType, jsonClass] of Object.entries(PAIRS)) {
    const list = got[slateType] || [];
    const refs = want[jsonClass] || [];
    if (!list.length && !refs.length) continue;
    // Nearest-match rather than by index: Slate widgets of one class include their own internal text
    // (SComboBox and SSpinBox contain an STextBlock), and pairing by index quietly compared a design
    // label against a combo box's inner text and reported a 170px error that did not exist.
    let maxPos = 0;
    let maxSize = 0;
    const used = new Set();
    let n = 0;
    for (const ref of refs) {
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < list.length; i += 1) {
        if (used.has(i)) continue;
        const w = list[i];
        const d = Math.abs(w.absX - ref.rect[0]) + Math.abs(w.absY - ref.rect[1]) +
          Math.abs(w.localW - ref.rect[2]) + Math.abs(w.localH - ref.rect[3]);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best === null || bestD > 400) continue;
      used.add(best);
      const w = list[best];
      maxPos = Math.max(maxPos, Math.abs(w.absX - ref.rect[0]), Math.abs(w.absY - ref.rect[1]));
      // A text widget is content-sized in Slate (and in UMG): the design rect is the element's BLOCK
      // width, the widget is as wide as its glyphs and aligned inside the slot. Comparing those widths
      // reports a huge "error" that is not a layout error, so text is compared on position only.
      if (slateType !== 'STextBlock') {
        maxSize = Math.max(maxSize, Math.abs(w.localW - ref.rect[2]), Math.abs(w.localH - ref.rect[3]));
      }
      compared += 1;
      n += 1;
    }
    worstPos = Math.max(worstPos, maxPos);
    worstSize = Math.max(worstSize, maxSize);
    const flag = maxPos > 2 || maxSize > 2 ? '  <<<' : '';
    console.log('  ' + slateType.padEnd(18) + ' slate=' + String(list.length).padStart(2) +
      ' reference=' + String(refs.length).padStart(2) +
      ' paired=' + String(n).padStart(2) +
      '  worst |dpos|=' + maxPos.toFixed(1).padStart(6) +
      '  worst |dsize|=' + maxSize.toFixed(1).padStart(6) + flag);
  }
  console.log('  ---- compared ' + compared + ' widget(s); worst position ' + worstPos.toFixed(1) +
    'px, worst size ' + worstSize.toFixed(1) + 'px');
  process.exit(worstPos > 2 || worstSize > 2 ? 1 : 0);
}

main();