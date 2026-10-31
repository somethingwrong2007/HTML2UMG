'use strict';

/**
 * WBP layout JSON -> HTML/CSS.
 *
 * The reverse of src/mapper.js for everything CSS can express, plus a marker attribute for
 * everything it cannot (data-ue-class / data-ue-widget / data-ue-named-slot / data-ue-switcher),
 * so a round trip WBP -> JSON -> HTML -> JSON -> WBP keeps the widget classes and names.
 *
 * Input is what Html2UMG.ExportLayout writes: contract shape (nested tree, slot objects, flat
 * dotted properties, assets[] with the exported png/ttf). Output is one self-contained .html
 * written next to those assets.
 *
 * Two conversions have to be undone exactly or the result drifts:
 *   colours   FSlateColor is LINEAR in the JSON, CSS is sRGB
 *   font size Slate points = CSS px * 72/96, so CSS px = Size * 4/3
 * and line height needs the font's own metrics, which is why the exporter copies the ttf.
 */

const path = require('path');
const FM = require('./fontmetrics');
const { toIdentifier } = require('./names');

/** Plain newline, so this file never needs an escaped one inside a string literal. */
const NL = String.fromCharCode(10);

/** Role suffixes the builder appends to generated wrappers (src/names.js ROLE_SUFFIX). */
const ROLE_SUFFIXES = ['_Box', '_Inner', '_BG', '_Pad', '_Scroll', '_Blur', '_Rel', '_Flow', '_Row', '_Text'];

/** Widget classes CSS cannot draw; kept via data-ue-class so re-import rebuilds the widget. */
const CSS_BOX_CLASSES = new Set([
  'Button', 'CheckBox', 'Slider', 'ProgressBar', 'ComboBoxString', 'EditableTextBox', 'SpinBox',
  'RetainerBox', 'ListView', 'TileView', 'SafeZone', 'ExpandableArea', 'Throbber',
  'CircularThrottle', 'ScaleBox', 'BackgroundBlur', 'StackBox',
]);

/**
 * Containers that produce no CSS signal of their own. Absorbing one into its wrapper element is fine
 * while it has children (they carry the signal), but an EMPTY one would vanish: measured on a bare
 * class page, an empty Overlay came back as nothing and its wrapper lost a child.
 */
const EMPTY_SURVIVOR = new Set([
  'Overlay', 'CanvasPanel', 'VerticalBox', 'HorizontalBox', 'WrapBox', 'GridPanel',
  'UniformGridPanel', 'NamedSlot', 'ScrollBox', 'ScaleBox', 'BackgroundBlur',
]);

const SWITCHER_SUFFIX = 'Switcher';

function isSwitcherClass(cls) {
  const s = String(cls || '');
  return s.length > SWITCHER_SUFFIX.length && s.endsWith(SWITCHER_SUFFIX);
}

function round(v, d) {
  const f = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(Number(v) * f) / f;
}

function px(v) {
  return round(Number(v), 2) + 'px';
}

/** `calc(<pct>% + <px>)`, collapsed to whichever term is needed, with a signed offset. */
function calc(pct, offsetPx) {
  const o = round(offsetPx, 2);
  const p = round(pct, 4);
  if (!o) return p ? p + '%' : '0';
  const sign = o < 0 ? '-' : '+';
  if (!p) return px(o);
  return 'calc(' + p + '% ' + sign + ' ' + px(Math.abs(o)) + ')';
}

/** linear [0..1] -> sRGB [0..1] */
function linearToSrgb(c) {
  const v = c < 0 ? 0 : c > 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** [r,g,b,a] in LINEAR space (what the JSON holds) -> a CSS colour. */
function cssColor(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const r = Math.round(linearToSrgb(Number(arr[0])) * 255);
  const g = Math.round(linearToSrgb(Number(arr[1])) * 255);
  const b = Math.round(linearToSrgb(Number(arr[2])) * 255);
  const a = arr.length > 3 ? Number(arr[3]) : 1;
  const hex = (n) => n.toString(16).padStart(2, '0');
  if (a >= 0.999) return '#' + hex(r) + hex(g) + hex(b);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + round(a, 3) + ')';
}

function isTransparentColor(arr) {
  return Array.isArray(arr) && arr.length > 3 && Number(arr[3]) <= 0.004;
}

function isRoleName(name) {
  return ROLE_SUFFIXES.some((s) => String(name).endsWith(s));
}

function stripRole(name) {
  let out = String(name);
  for (const s of ROLE_SUFFIXES) if (out.endsWith(s)) out = out.slice(0, -s.length);
  return out;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class Generator {
  constructor(layout, options) {
    this.layout = layout;
    this.opts = options || {};
    this.warnings = [];
    this.rules = new Map();
    this.usedClassNames = new Set();
    this.assetFile = new Map();
    this.fontFamily = new Map();
    this.faceCss = [];
    this.metrics = new Map();
    for (const t of (layout.assets && layout.assets.textures) || []) {
      if (t && t.source && t.file) this.assetFile.set(t.source, t.file);
    }
    for (const f of (layout.assets && layout.assets.fonts) || []) {
      if (!f) continue;
      if (f.source && f.file) this.assetFile.set(f.source, f.file);
      if (f.source) this.fontFamily.set(f.source, f.family || 'UIFont');
    }
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Font metrics for a Font.FontObject reference, read from the exported ttf when present. */
  metricsFor(fontObject) {
    if (!fontObject) return null;
    if (this.metrics.has(fontObject)) return this.metrics.get(fontObject);
    let out = null;
    const file = this.assetFile.get(fontObject);
    if (file && this.opts.assetRoot) {
      try {
        out = FM.readFontFile(path.join(this.opts.assetRoot, file));
      } catch (err) {
        out = null;
      }
    }
    this.metrics.set(fontObject, out);
    return out;
  }

  className(baseName) {
    const clean = String(baseName || 'Widget').replace(/[^A-Za-z0-9_-]/g, '_');
    let name = clean;
    let n = 1;
    while (this.usedClassNames.has(name)) name = clean + '_' + n++;
    this.usedClassNames.add(name);
    return name;
  }

  rule(name) {
    if (!this.rules.has(name)) this.rules.set(name, []);
    return this.rules.get(name);
  }

  // ---------------------------------------------------------------- geometry

  /**
   * CanvasPanel slot -> CSS. Undoes mapper.axisPlacement():
   *   point   size = (Offsets.Right, Offsets.Bottom); pos = anchor*parent + Left - size*Align
   *   stretch pos  = anchor.min*parent + Left;     right inset = (1-anchor.max)*parent + Right
   */
  canvasSlotCss(slot, out) {
    const ld = slot && slot.LayoutData;
    if (!ld) return;
    const anchors = ld.Anchors || { Minimum: [0, 0], Maximum: [0, 0] };
    const offs = ld.Offsets || { Left: 0, Top: 0, Right: 0, Bottom: 0 };
    const align = ld.Alignment || [0, 0];
    const autoSize = slot.bAutoSize === true;
    const axis = (min, max, off, offEnd, size, al, lead, sizeProp, inset) => {
      const isPoint = Math.abs(min - max) < 1e-6;
      if (isPoint) {
        const offset = round(off - size * al, 2);
        if (Math.abs(offset) < 0.005) out.push(lead + ': 0');
        else if (Math.abs(min) < 1e-6) out.push(lead + ': ' + px(offset));
        else if (Math.abs(min - 1) < 1e-6) out.push(lead + ': ' + calc(100, offset));
        else out.push(lead + ': ' + calc(round(min * 100, 4), offset));
        if (!autoSize) out.push(sizeProp + ': ' + px(size));
        return;
      }
      const leadValue = Math.abs(min) < 1e-6 ? px(off) : calc(round(min * 100, 4), off);
      const tailPct = round((1 - max) * 100, 4);
      const tailValue = Math.abs(tailPct) < 1e-6 ? px(offEnd) : calc(tailPct, offEnd);
      out.push(lead + ': ' + leadValue);
      out.push(inset + ': ' + tailValue);
    };
    axis(anchors.Minimum[0], anchors.Maximum[0], Number(offs.Left) || 0, Number(offs.Right) || 0,
      Number(offs.Right) || 0, Number(align[0]) || 0, 'left', 'width', 'right');
    axis(anchors.Minimum[1], anchors.Maximum[1], Number(offs.Top) || 0, Number(offs.Bottom) || 0,
      Number(offs.Bottom) || 0, Number(align[1]) || 0, 'top', 'height', 'bottom');
  }

  /**
   * Single-child host (NamedSlot, Border, ScrollBox, ...): the CHILD's slot alignment becomes the
   * HOST's flex alignment. CSS keeps align-items/justify-content on the container while Slate puts the
   * pair on the slot, so the pair has to move up one level - otherwise a centred label loses its
   * centring (measured on a slider row's round trip: VerticalAlignment Center came back as Top).
   */
  singleChildLayout(parentCss, slot, childKind) {
    parentCss.push('display: flex');
    const h = (slot && slot.HorizontalAlignment) || 'Fill';
    const v = (slot && slot.VerticalAlignment) || 'Fill';
    const justify = h === 'Center' ? 'center' : h === 'Right' ? 'flex-end' : 'flex-start';
    const align = v === 'Center' ? 'center' : v === 'Bottom' ? 'flex-end' : v === 'Top' ? 'flex-start' : 'stretch';
    parentCss.push('justify-content: ' + justify, 'align-items: ' + align);
    if (childKind) childKind.fillX = h === 'Fill';
  }

  /** Box slot -> flex CSS on the item (the inverse of mapper.boxSlot()). */
  boxSlotCss(slot, vertical, out) {
    if (!slot) return;
    const size = slot.Size || {};
    if (size.SizeRule === 'Fill') out.push('flex: ' + round(Number(size.Value) || 1, 3) + ' 1 0%');
    else out.push('flex: 0 0 auto');
    const pad = Array.isArray(slot.Padding) ? slot.Padding : null;
    if (pad) {
      const mainPad = vertical ? Number(pad[1]) : Number(pad[0]);
      if (mainPad) out.push(vertical ? 'margin-top: ' + px(mainPad) : 'margin-left: ' + px(mainPad));
      const crossA = vertical ? Number(pad[0]) : Number(pad[1]);
      const crossB = vertical ? Number(pad[2]) : Number(pad[3]);
      if (crossA) out.push(vertical ? 'margin-left: ' + px(crossA) : 'margin-top: ' + px(crossA));
      if (crossB) out.push(vertical ? 'margin-right: ' + px(crossB) : 'margin-bottom: ' + px(crossB));
    }
    const cross = vertical ? slot.HorizontalAlignment : slot.VerticalAlignment;
    if (cross === 'Center') out.push('align-self: center');
    else if (cross === (vertical ? 'Right' : 'Bottom')) out.push('align-self: flex-end');
    else if (cross === (vertical ? 'Left' : 'Top')) out.push('align-self: flex-start');
    else if (cross === 'Fill') out.push('align-self: stretch');
  }

  // ---------------------------------------------------------------- visuals

  /** Background / border / radius from an FSlateBrush (the Background.* keys). */
  brushCss(props, out, label, keyPrefix) {
    // UBorder exposes its brush as "Background", UImage as "Brush"; the field set behind it is the
    // same FSlateBrush, so the reader is parameterised instead of hardcoded to one spelling (an
    // Image was coming out with no texture at all because every lookup asked for Background.*).
    const P = keyPrefix || 'Background';
    const drawAs = props[P + '.DrawAs'];
    const tint = props[P + '.TintColor'];
    const resource = props[P + '.ResourceObject'];
    const hasTexture = resource && resource !== 'None';
    const outlineWidth = Number(props[P + '.OutlineSettings.Width'] || 0);
    const radii = props[P + '.OutlineSettings.CornerRadii'];

    if (hasTexture) {
      const file = this.assetFile.get(resource);
      if (file) {
        out.push('background-image: url("' + file + '")');
        out.push('background-repeat: no-repeat');
        out.push('background-size: 100% 100%');
      } else {
        this.warn('texture ' + resource + ' on ' + label + ' has no exported file; the element renders without it');
      }
    } else if (tint && !isTransparentColor(tint) && drawAs && drawAs !== 'NoDrawType') {
      const c = cssColor(tint);
      if (c) out.push('background-color: ' + c);
    }

    if (outlineWidth > 0) {
      const oc = cssColor(props[P + '.OutlineSettings.Color'] || [0, 0, 0, 1]) || '#000';
      out.push('border: ' + px(outlineWidth) + ' solid ' + oc);
      out.push('box-sizing: border-box');
    }

    if (Array.isArray(radii) && radii.some((v) => Number(v) > 0.01)) {
      const uniform = radii.every((v) => Math.abs(Number(v) - Number(radii[0])) < 0.01);
      const list = radii.map((v) => px(Math.max(0, Number(v)))).join(' ');
      out.push('border-radius: ' + (uniform ? px(radii[0]) : list));
    }

    const margin = props[P + '.Margin'];
    if (drawAs === 'Box' && Array.isArray(margin) && margin.some((v) => Number(v) > 0.01)) {
      this.warn('9-slice brush on ' + label + ' (Margin ' + margin.join(',') + ') is drawn as one stretched image; CSS cannot sample the edges the same way');
    }
    if (props[P + '.Tiling'] && props[P + '.Tiling'] !== 'NoTile') out.push('background-repeat: repeat');
    // Slate multiplies a texture by the brush tint; CSS draws the image over the colour instead.
    if (hasTexture && Array.isArray(tint) && !isTransparentColor(tint)) {
      const whiteish = Number(tint[0]) > 0.95 && Number(tint[1]) > 0.95 && Number(tint[2]) > 0.95;
      if (!whiteish) this.warn(label + ': the brush multiplies its texture by tint ' + cssColor(tint) + '; CSS draws the image without that multiply');
    }
  }

  /** SizeBox overrides -> CSS size. */
  sizeCss(props, out) {
    const set = (flag, value, prop) => {
      if (props[flag] && value !== undefined && value !== null) out.push(prop + ': ' + px(value));
    };
    set('bOverride_WidthOverride', props.WidthOverride, 'width');
    set('bOverride_HeightOverride', props.HeightOverride, 'height');
    set('bOverride_MinDesiredWidth', props.MinDesiredWidth, 'min-width');
    set('bOverride_MaxDesiredWidth', props.MaxDesiredWidth, 'max-width');
    set('bOverride_MinDesiredHeight', props.MinDesiredHeight, 'min-height');
    set('bOverride_MaxDesiredHeight', props.MaxDesiredHeight, 'max-height');
  }

  /** TextBlock properties -> CSS. */
  textCss(props, out, label) {
    out.push('font-size: ' + px((Number(props['Font.Size']) || 0) * 4 / 3));
    const color = cssColor(props.ColorAndOpacity);
    if (color) out.push('color: ' + color);
    const fontObject = props['Font.FontObject'];
    let family = null;
    if (fontObject && fontObject !== 'None') {
      family = this.fontFamily.get(fontObject) || this.faceFamily(fontObject);
      if (family) out.push('font-family: "' + family + '"');
      const face = props['Font.TypefaceFontName'];
      if (face === 'Bold') out.push('font-weight: 700');
      if (face === 'Italic') out.push('font-style: italic');
    }
    const spacing = Number(props['Font.LetterSpacing'] || 0);
    if (spacing) out.push('letter-spacing: ' + round(spacing, 3) + 'px');
    const j = props.Justification;
    if (j === 'Center') out.push('text-align: center');
    else if (j === 'Right') out.push('text-align: right');
    out.push(props.AutoWrapText === false ? 'white-space: nowrap' : 'white-space: normal');

    // line-height is stored as cssBox / slateBox, so it only converts back with the font metrics.
    const lhp = Number(props.LineHeightPercentage || 0);
    if (lhp > 0) {
      const cssPx2 = (Number(props['Font.Size']) || 0) * 4 / 3;
      const metrics = this.metricsFor(fontObject);
      const slateBox = metrics ? FM.slateLineBox(metrics, cssPx2, { shadowOffsetY: 0 }) : null;
      if (slateBox > 0) out.push('line-height: ' + px(lhp * slateBox));
      else {
        out.push('line-height: normal');
        this.warn('line-height on ' + label + ' could not be converted (no metrics for ' + (fontObject || 'the default font') + '); exported as normal');
      }
    }
  }

  /** @font-face for a referenced font, so the preview uses the real face. */
  faceFamily(fontObject) {
    const file = this.assetFile.get(fontObject);
    if (!file) return null;
    const parts = String(fontObject).split('/');
    const family = (parts[parts.length - 1] || 'UIFont').split('.')[0] || 'UIFont';
    if (!this.faceCss.some((c) => c.indexOf(file) >= 0)) {
      this.faceCss.push('@font-face { font-family: "' + family + '"; src: url("' + file + '"); }');
    }
    return family;
  }

  // ---------------------------------------------------------------- tree

  /** Wrapper chain (SizeBox/Border) folded into one element, plus the content node. */
  fold(node) {
    const chain = [];
    let cur = node;
    // Absorb every SizeBox/Border in the chain - including one with NO children, which IS the
    // element (a 1px divider Border is exactly that). Stopping at "has 1 child" dropped that node's
    // brush entirely: the generated div had no background and the re-import deleted it.
    while (cur && (cur.class === 'SizeBox' || cur.class === 'Border')) {
      chain.push(cur);
      const kids = cur.children || [];
      if (kids.length !== 1) {
        cur = null;
        break;
      }
      cur = kids[0];
    }
    return { chain, content: cur };
  }

  /** The element's own name: the first name in the chain that is not a generated wrapper. */
  baseName(chain, content) {
    const all = chain.concat(content ? [content] : []);
    for (const n of all) if (n && n.name && !isRoleName(n.name)) return n.name;
    return stripRole((chain[0] || content || {}).name || 'Widget');
  }

  emit(node, ctx, info) {
    if (!node) return '';
    const folded = this.fold(node);
    const chain = folded.chain;
    const content = folded.content;
    const outer = chain.length ? chain[0] : node;
    const base = this.baseName(chain, content);
    const cls = this.className(base);
    const css = this.rule(cls);
    const depth = info.depth || 0;
    const pad = '  '.repeat(depth);

    const attrs = ['class="' + cls + '"'];
    if (base) {
      attrs.push('data-ue-name="' + esc(base) + '"');
      // The converter PascalCases data-ue-name, which would turn a generated unique name like "Pg_1"
      // into "Pg1" and break the round trip. Ask for the name verbatim whenever the transform would
      // actually change it.
      if (toIdentifier(base) !== base) attrs.push('data-ue-name-verbatim');
    }
    if (info.instanceSlot) attrs.push('data-ue-slot="' + esc(info.instanceSlot) + '"');
    // A hidden switcher page is spelled the way the converter reads it back: display:none. It has to
    // be appended AFTER the content has added its own "display: flex", or the page shows up visible.
    // (The snapshot's revealSwitcherPages() then lays it out temporarily for measurement and marks it
    // wasHidden, which is what sets ActiveWidgetIndex again on the re-import.)
    if (info.isRoot) attrs.push('data-ue-blueprint="' + esc(this.layout.blueprint || '') + '"');
    if (node.variable === false && chain.length === 0) attrs.push('data-ue-variable="false"');

    // A slot that places the element absolutely also makes it the containing block for its own
    // absolutely positioned children, so the content must NOT add a second `position` later.
    let positioned = false;
    if (info.isRoot) {
      css.push('width: ' + px(ctx.viewport.width), 'height: ' + px(ctx.viewport.height));
    } else if (info.kind === 'canvas') {
      css.push('position: absolute');
      positioned = true;
      this.canvasSlotCss(outer.slot, css);
      if (Number(outer.slot && outer.slot.ZOrder)) css.push('z-index: ' + outer.slot.ZOrder);
    } else if (info.kind === 'overlay') {
      css.push('position: absolute');
      positioned = true;
      const h = (outer.slot && outer.slot.HorizontalAlignment) || 'Fill';
      const v = (outer.slot && outer.slot.VerticalAlignment) || 'Fill';
      if (h === 'Fill' && v === 'Fill') css.push('inset: 0');
      else {
        const shifts = [];
        if (h === 'Left') css.push('left: 0');
        else if (h === 'Right') css.push('right: 0');
        else if (h === 'Center') { css.push('left: 50%'); shifts.push('translateX(-50%)'); }
        if (v === 'Top') css.push('top: 0');
        else if (v === 'Bottom') css.push('bottom: 0');
        else if (v === 'Center') { css.push('top: 50%'); shifts.push('translateY(-50%)'); }
        if (shifts.length) css.push('transform: ' + shifts.join(' '));
      }
    } else if (info.kind === 'box') {
      this.boxSlotCss(outer.slot, info.vertical === true, css);
    } else if (info.kind === 'single') {
      // The host put justify/align-items on itself (singleChildLayout); the child only has to grow
      // along the main axis when the slot asked for Fill.
      if (info.fillX) css.push('flex: 1 1 auto');
    }

    for (const n of chain) {
      const pr = n.properties || {};
      if (n.class === 'SizeBox') this.sizeCss(pr, css);
      else if (n.class === 'Border') {
        this.brushCss(pr, css, base);
        const padding = Array.isArray(pr.Padding) ? pr.Padding : null;
        if (padding && padding.some((v) => Number(v) > 0.01)) {
          css.push('padding: ' + padding.map((v) => px(v)).join(' '));
        }
        if (pr.Clipping === 'ClipToBounds') css.push('overflow: hidden');
      }
      if (pr.Visibility === 'Hidden') css.push('visibility: hidden');
      if (pr.Visibility === 'Collapsed') css.push('display: none');
    }

    const cp = (content && content.properties) || {};
    let innerHtml = null;
    let childKind = null;
    let imageTag = false;

    if (content && content.class === 'TextBlock') {
      const text = cp.Text === undefined ? '' : String(cp.Text);
      this.textCss(cp, css, base);
      if (Array.isArray(cp.ShadowColorAndOpacity) && !isTransparentColor(cp.ShadowColorAndOpacity)) {
        this.warn('text-shadow on ' + base + ' is not emitted (UMG draws it inside the glyph run)');
      }
      innerHtml = esc(text);
    } else if (content && content.class === 'NamedSlot') {
      attrs.push('data-ue-named-slot="' + esc(base) + '"');
      childKind = { kind: 'single' };
      this.singleChildLayout(css, (content.children || [])[0] && (content.children || [])[0].slot, childKind);
    } else if (content && chain.length && !((content.children || []).length) &&
      (EMPTY_SURVIVOR.has(content.class) || isSwitcherClass(content.class))) {
      // An empty container has no CSS signal at all: it draws nothing and sizes nothing, so there is
      // nothing for CSS to carry. Emitting it as a data-ue-class placeholder was tried and made it
      // worse - the converter split one div into a container plus the class node, adding a widget.
      // Absorb it and say so.
      this.warn(content.name + ' is an empty ' + content.class + ' with no children: it draws nothing, so CSS cannot carry it and the re-import will not recreate it');
      childKind = null;
    } else if (content && content.class === 'CanvasPanel') {
      if (!positioned) css.push('position: relative');
      childKind = { kind: 'canvas' };
    } else if (content && content.class === 'Overlay') {
      if (!positioned) css.push('position: relative');
      childKind = { kind: 'overlay' };
    } else if (content && (content.class === 'VerticalBox' || content.class === 'HorizontalBox')) {
      const vertical = content.class === 'VerticalBox';
      css.push('display: flex', 'flex-direction: ' + (vertical ? 'column' : 'row'));
      childKind = { kind: 'box', vertical };
    } else if (isSwitcherClass(content && content.class)) {
      attrs.push('data-ue-switcher', 'data-ue-class="' + esc(content.class) + '"');
      if (!positioned) css.push('position: relative');
      childKind = { kind: 'overlay', switcher: true };
    } else if (content && CSS_BOX_CLASSES.has(content.class)) {
      attrs.push('data-ue-class="' + esc(content.class) + '"');
      if (content.class === 'WrapBox') {
        css.push('display: flex', 'flex-wrap: wrap');
        const pad2 = Array.isArray(cp.InnerSlotPadding) ? cp.InnerSlotPadding : [0, 0];
        if (Number(pad2[0]) || Number(pad2[1])) {
          css.push('column-gap: ' + px(pad2[0]), 'row-gap: ' + px(pad2[1]));
        }
      }
      if (content.class === 'BackgroundBlur') {
        const strength = Number(cp.BlurStrength || 0);
        if (strength) css.push('backdrop-filter: blur(' + px(strength) + ')');
      }
      if (content.class === 'ScrollBox') css.push('overflow: auto');
      this.warn(base + ' is a ' + content.class + ': CSS has no equivalent, kept as data-ue-class with its geometry only');
      childKind = { kind: 'single' };
    } else if (content && String(content.class).startsWith('/')) {
      attrs.push('data-ue-widget="' + esc(content.class) + '"');
      if (!positioned) css.push('position: relative');
      childKind = { kind: 'overlay', instance: true };
    } else if (content && content.class === 'Image') {
      // A UImage is reached as <img> by the converter (a background-image on a div becomes a Border),
      // so the reverse has to use the tag, not a CSS background.
      const imageFile = this.assetFile.get(cp['Brush.ResourceObject']);
      if (imageFile) {
        imageTag = true;
        attrs.push('src="' + esc(imageFile) + '"');
        css.push('object-fit: fill');
      } else {
        attrs.push('data-ue-class="Image"');
        this.warn(base + ' is an Image with no exported texture; kept as data-ue-class with its geometry only');
      }
      childKind = null;
    } else {
      if (!positioned) css.push('position: relative');
      childKind = { kind: 'canvas' };
    }

    if (innerHtml === null) {
      const kids = (content && content.children) || [];
      const parts = [];
      const isSwitcher = !!(childKind && childKind.switcher);
      const activeIndex = Number(cp.ActiveWidgetIndex || 0);
      if (childKind && kids.length) {
        let index = 0;
        for (const kid of kids) {
          const childInfo = Object.assign({}, childKind, {
            depth: depth + 1,
            instanceSlot: childKind.instance ? kid.namedSlot : null,
            hidden: isSwitcher && index !== activeIndex,
          });
          parts.push(this.emit(kid, ctx, childInfo));
          index += 1;
        }
      }
      innerHtml = parts.length ? NL + parts.join(NL) + NL + pad : '';
    }

    if (info.hidden) {
      // Keep the page's real display in a marker: hiding it needs display:none, and the converter's
      // reveal would otherwise put it back as a plain block, turning a flex page into a VerticalBox.
      if (childKind && childKind.kind === 'box') attrs.push('data-ue-display="flex"');
      css.push('display: none');
    }

    // The WBP root IS the body element. Wrapping it in a body would add one node the widget tree does
    // not have, and re-importing then produces a root plus a "Root" child (measured: a slider row came
    // back with an extra Root_1 level and lost its Divider to a name collision).
    const tag = info.asBody ? 'body' : imageTag ? 'img' : 'div';
    return pad + '<' + tag + ' ' + attrs.join(' ') + '>' + innerHtml + '</' + tag + '>';
  }

  render() {
    const viewport = this.layout.viewport || { width: 1920, height: 1080 };
    const ctx = { viewport };
    const body = this.emit(this.layout.root, ctx, { isRoot: true, asBody: true, depth: 1 });

    const cssLines = [];
    for (const face of this.faceCss) cssLines.push(face);
    cssLines.push('html, body { margin: 0; padding: 0; background: transparent; }');
    cssLines.push('body { position: relative; width: ' + px(viewport.width) + '; height: ' + px(viewport.height) + '; }');
    cssLines.push('div { box-sizing: border-box; }');
    for (const entry of this.rules) {
      if (!entry[1].length) continue;
      cssLines.push('.' + entry[0] + ' { ' + entry[1].join('; ') + '; }');
    }

    const html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>' + esc(this.layout.blueprint || 'Widget') + '</title>',
      '<style>',
      cssLines.join(NL),
      '</style>',
      '</head>',
      body,
      '</html>',
      '',
    ].join(NL);
    return html;
  }
}

function toHtml(layout, options) {
  const gen = new Generator(layout, options);
  const html = gen.render();
  return { html, warnings: gen.warnings };
}

module.exports = { toHtml, Generator, cssColor, linearToSrgb, isRoleName, stripRole };