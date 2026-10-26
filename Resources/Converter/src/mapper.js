// Copyright (c) 2026 FPVSkyline. MIT License.
// Mapper: DOM snapshot (src/snapshot.js) -> Html2UMG contract node tree.
// Rules live in Docs/Html2UMG_LayoutContract.md §6; field names come from that
// contract and from real UMG reflection names (see README "engine facts").
'use strict';

const V = require('./values');
const { baseName, NameRegistry } = require('./names');

/** UMG class names emitted by the converter. */
const CLASS = {
  VERTICAL: 'VerticalBox',
  HORIZONTAL: 'HorizontalBox',
  WRAP: 'WrapBox',
  GRID: 'GridPanel',
  UNIFORM_GRID: 'UniformGridPanel',
  CANVAS: 'CanvasPanel',
  OVERLAY: 'Overlay',
  BORDER: 'Border',
  SIZE_BOX: 'SizeBox',
  SCALE_BOX: 'ScaleBox',
  SCROLL_BOX: 'ScrollBox',
  TEXT: 'TextBlock',
  IMAGE: 'Image',
  BUTTON: 'Button',
  EDITABLE: 'EditableTextBox',
  COMBO: 'ComboBoxString',
  PROGRESS: 'ProgressBar',
  CHECK_BOX: 'CheckBox',
  SLIDER: 'Slider',
};

/** Container class -> box orientation ('v' | 'h' | 'w' for WrapBox). */
const BOX_SLOTS = {
  [CLASS.VERTICAL]: 'v',
  [CLASS.HORIZONTAL]: 'h',
  [CLASS.WRAP]: 'w',
};

const UNSUPPORTED_TAGS = {
  video: 1, audio: 1, canvas: 1, iframe: 1, object: 1, embed: 1,
  map: 1, area: 1, track: 1, frame: 1, frameset: 1,
};

/**
 * Replaced / interactive elements: they render a box of their own, so inline text
 * merging must break around them instead of swallowing them.
 */
const REPLACED_TAGS = {
  input: 1, select: 1, textarea: 1, button: 1, progress: 1, meter: 1,
  img: 1, svg: 1, canvas: 1, video: 1, audio: 1, iframe: 1, object: 1, embed: 1,
};

/**
 * Kinds whose payload is a single leaf widget. Leaves keep the element's name
 * even when a Border wraps them (a designer binds the TextBlock/Image, not the
 * decoration), while containers hand their name to the Border instead.
 */
const LEAF_KINDS = new Set([
  'text', 'image', 'button', 'textinput', 'combobox', 'progress', 'checkbox', 'slider', 'placeholder',
]);

class Mapper {
  constructor(options) {
    this.snapshot = options.snapshot;
    this.probes = options.probes || [];
    this.assets = options.assets || null;
    this.opts = options.options || {};
    // Baked native-control textures, keyed by snapshot record index (src/bake.js).
    this.baked = this.opts.baked || new Map();
    this.names = new NameRegistry();
    this.warnings = [];
    this._warned = new Set();
    this.byIndex = new Map();
    for (const rec of this.snapshot.elements) this.byIndex.set(rec.i, rec);
    this.meta = new Map();
    this.samples = new Map();
    this._buildSamples();
  }

  warn(message) {
    if (this._warned.has(message)) return;
    this._warned.add(message);
    this.warnings.push(message);
  }

  // ---------------------------------------------------------------- geometry
  _buildSamples() {
    const primary = this.snapshot;
    const aligned = [];
    for (const probe of this.probes) {
      if (!probe || !Array.isArray(probe.elements)) continue;
      if (probe.elements.length !== primary.elements.length) {
        const size = probe.viewport ? `${probe.viewport.width}x${probe.viewport.height}` : '?';
        this.warn(
          `probe ${size}: DOM changed between viewports (${probe.elements.length} vs ${primary.elements.length} elements); ignored for anchor inference`
        );
        continue;
      }
      aligned.push(probe);
    }
    const all = [primary].concat(aligned);
    for (const rec of primary.elements) {
      const x = [];
      const y = [];
      for (const snap of all) {
        const other = snap.elements[rec.i];
        if (!other) continue;
        x.push({ pos: other.rect[0] - other.prect[0], size: other.rect[2], parentSize: other.prect[2] });
        y.push({ pos: other.rect[1] - other.prect[1], size: other.rect[3], parentSize: other.prect[3] });
      }
      this.samples.set(rec.i, { x, y });
    }
  }

  // ------------------------------------------------------------------- style
  readStyle(rec) {
    const cs = rec.cs || {};
    const decl = rec.decl || {};
    const px = (value) => V.parsePx(value);
    const declPx = (name) => {
      const raw = decl[name];
      if (raw === undefined) return null;
      const s = String(raw).trim();
      if (!s || s === 'auto' || s === 'none' || s === 'normal') return null;
      if (s.endsWith('%')) return null; // handled separately as a proportion
      return px(s);
    };
    const declPercent = (name) => {
      const raw = decl[name];
      if (raw === undefined) return null;
      const s = String(raw).trim();
      if (!s.endsWith('%')) return null;
      const value = parseFloat(s);
      return Number.isFinite(value) ? value / 100 : null;
    };

    const style = {
      display: cs.display || 'block',
      position: cs.position || 'static',
      flexDirection: cs.flexDirection || 'row',
      flexWrap: cs.flexWrap || 'nowrap',
      justify: cs.justifyContent || 'normal',
      alignItems: cs.alignItems || 'normal',
      alignSelf: cs.alignSelf || 'auto',
      order: cs.order !== undefined ? Number(cs.order) || 0 : 0,
      flexGrow: cs.flexGrow !== undefined ? Number(cs.flexGrow) || 0 : 0,
      flexShrink: cs.flexShrink !== undefined ? Number(cs.flexShrink) : 1,
      rowGap: px(cs.rowGap) || 0,
      columnGap: px(cs.columnGap) || 0,
      margin: [px(cs.marginLeft) || 0, px(cs.marginTop) || 0, px(cs.marginRight) || 0, px(cs.marginBottom) || 0],
      padding: [px(cs.paddingLeft) || 0, px(cs.paddingTop) || 0, px(cs.paddingRight) || 0, px(cs.paddingBottom) || 0],
      borderWidth: [
        px(cs.borderLeftWidth) || 0,
        px(cs.borderTopWidth) || 0,
        px(cs.borderRightWidth) || 0,
        px(cs.borderBottomWidth) || 0,
      ],
      borderRadius: V.parseBorderRadius(
        [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
          .map((r) => r || '0')
          .join(' ')
      ),
      borderColor: V.colorToLinear(cs.borderTopColor) || [0, 0, 0, 0],
      // Per-side colours/styles so a single-side border can be reported instead of
      // silently averaged away.
      borderColors: [
        V.colorToLinear(cs.borderLeftColor) || [0, 0, 0, 0],
        V.colorToLinear(cs.borderTopColor) || [0, 0, 0, 0],
        V.colorToLinear(cs.borderRightColor) || [0, 0, 0, 0],
        V.colorToLinear(cs.borderBottomColor) || [0, 0, 0, 0],
      ],
      borderStyles: [
        cs.borderLeftStyle || 'none',
        cs.borderTopStyle || 'none',
        cs.borderRightStyle || 'none',
        cs.borderBottomStyle || 'none',
      ],
      backgroundColor: V.colorToLinear(cs.backgroundColor),
      overflowX: cs.overflowX || 'visible',
      overflowY: cs.overflowY || 'visible',
      zIndex: cs.zIndex !== undefined ? Number(cs.zIndex) || 0 : 0,
      opacity: cs.opacity !== undefined ? Number(cs.opacity) : 1,
      visibility: cs.visibility || 'visible',
      fixedWidth: declPx('width'),
      fixedHeight: declPx('height'),
      percentWidth: declPercent('width'),
      percentHeight: declPercent('height'),
      minWidth: declPx('min-width'),
      maxWidth: declPx('max-width'),
      minHeight: declPx('min-height'),
      maxHeight: declPx('max-height'),
      display: cs.display || 'block',
      // Text
      fontFamily: cs.fontFamily || 'Segoe UI',
      fontSize: px(cs.fontSize) || 14,
      fontWeight: V.parseFontWeight(cs.fontWeight),
      fontItalic: /italic|oblique/.test(cs.fontStyle || 'normal'),
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: V.colorToLinear(cs.color) || [1, 1, 1, 1],
      textAlign: (cs.textAlign || 'start').toLowerCase(),
      textTransform: (cs.textTransform || 'none').toLowerCase(),
      textDecoration: cs.textDecorationLine || 'none',
      whiteSpace: cs.whiteSpace || 'normal',
      textOverflow: cs.textOverflow || 'clip',
      textShadow: cs.textShadow || 'none',
      gridColumns: V.parseGridTracks(cs.gridTemplateColumns),
      gridRows: V.parseGridTracks(cs.gridTemplateRows),
      gridFrColumns: V.parseGridTracks(decl['grid-template-columns']).map((t) => t.fr).filter((v) => v !== undefined),
      gridColumnStart: cs.gridColumnStart,
      gridRowStart: cs.gridRowStart,
    };

    style.bgImage = V.parseBackgroundImage(cs.backgroundImage);
    style.bgSize = V.parseBackgroundSize(cs.backgroundSize);
    // CSS px sizes honour box-sizing; a UMG SizeBox always sizes the border box,
    // so content-box declarations must absorb their own padding and border.
    style.boxSizing = cs.boxSizing || 'content-box';
    if (style.boxSizing !== 'border-box') {
      const padX = style.padding[0] + style.padding[2];
      const padY = style.padding[1] + style.padding[3];
      const borX = style.borderWidth[0] + style.borderWidth[2];
      const borY = style.borderWidth[1] + style.borderWidth[3];
      if (style.fixedWidth !== null) style.fixedWidth = V.round(style.fixedWidth + padX + borX, 2);
      if (style.fixedHeight !== null) style.fixedHeight = V.round(style.fixedHeight + padY + borY, 2);
      if (style.minWidth !== null) style.minWidth = V.round(style.minWidth + padX + borX, 2);
      if (style.maxWidth !== null) style.maxWidth = V.round(style.maxWidth + padX + borX, 2);
      if (style.minHeight !== null) style.minHeight = V.round(style.minHeight + padY + borY, 2);
      if (style.maxHeight !== null) style.maxHeight = V.round(style.maxHeight + padY + borY, 2);
    }
    style.isAbs = style.position === 'absolute' || style.position === 'fixed';
    style.isSticky = style.position === 'sticky';
    style.hasVisualBox =
      (style.backgroundColor && style.backgroundColor[3] > 0.002) ||
      style.borderWidth.some((w) => w > 0) ||
      style.borderRadius.some((r) => r > 0) ||
      style.bgImage.urls.length > 0;
    style.hasPadding = style.padding.some((p) => p > 0);
    return style;
  }

  // ---------------------------------------------------------- unsupported CSS
  checkUnsupported(rec) {
    const cs = rec.cs || {};
    const label = this.label(rec);
    if (cs.boxShadow) this.warn(`unsupported: box-shadow on '${label}' dropped`);
    if (cs.filter) this.warn(`unsupported: filter on '${label}' dropped`);
    if (cs.backdropFilter) this.warn(`unsupported: backdrop-filter on '${label}' dropped`);
    if (cs.transform) this.warn(`unsupported: transform on '${label}' dropped (layout uses the untransformed box)`);
    if (cs.mixBlendMode) this.warn(`unsupported: mix-blend-mode on '${label}' dropped`);
    if (cs.clipPath) this.warn(`unsupported: clip-path on '${label}' dropped`);
    if (cs.maskImage) this.warn(`unsupported: mask-image on '${label}' dropped`);
    const bg = V.parseBackgroundImage(cs.backgroundImage);
    if (bg.gradients.length) this.warn(`unsupported: ${bg.gradients[0]} on '${label}' dropped (flat background used)`);
    if (rec.pseudo && (rec.pseudo.before || rec.pseudo.after)) {
      this.warn(`unsupported: ::before/::after content on '${label}' dropped`);
    }
    if (cs.position === 'sticky') this.warn(`unsupported: position:sticky on '${label}' treated as static`);
    // <svg>/<img> report overflow:hidden by user-agent default; that is not a
    // design decision and they are leaves anyway.
    if ((cs.overflowX === 'hidden' || cs.overflowY === 'hidden') && rec.tag !== 'svg' && rec.tag !== 'img') {
      this.warn(`unsupported: overflow:hidden clipping on '${label}' (children are not clipped)`);
    }
    if (cs.direction === 'rtl') this.warn(`unsupported: direction:rtl on '${label}' converted left-to-right`);
    if (rec.shadow) this.warn(`unsupported: shadow DOM inside '${label}' is not converted`);
  }

  label(rec) {
    if (!rec) return '?';
    let out = rec.tag || '?';
    if (rec.id) out += `#${rec.id}`;
    if (rec.cls && rec.cls.length) {
      const semantic = rec.cls.filter((c) => !/^(is-|has-)/.test(c))[0] || rec.cls[0];
      out += `.${semantic}`;
    }
    return out;
  }

  // ---------------------------------------------------------------- document
  map() {
    const body = this.snapshot.elements.find((rec) => rec.tag === 'body');
    if (!body) throw new Error('mapper: the snapshot has no <body> element');
    const bodyStyle = this.snapshot.bodyStyle;
    if (bodyStyle && bodyStyle.margin && !/^0(px)?( 0(px)?){0,3}$/.test(String(bodyStyle.margin).trim())) {
      this.warn(`note: <body> has margin ${bodyStyle.margin}; the UMG root starts at 0,0`);
    }

    let root = this.mapElement(body, { fontMap: new Map(), depth: 0, isRoot: true, forceName: rootPreferredName(body) });
    if (!root) throw new Error('mapper: <body> produced no widget');

    if (this.opts.scaleBox) {
      const name = this.names.unique(`${root.name}_ScaleBox`);
      const wrapper = {
        name,
        class: CLASS.SCALE_BOX,
        source: 'cli:--scale-box',
        variable: false,
        properties: { Stretch: this.opts.scaleBox.stretch, StretchDirection: 'Both' },
        children: [root],
      };
      this.meta.set(wrapper, { synthetic: true, style: null, rec: null, kind: 'scalebox' });
      root = wrapper;
    }
    this.assignSlots(root);
    return root;
  }

  assignSlots(parent) {
    const children = parent.children || [];
    if (!children.length) return;
    const pmeta = this.meta.get(parent) || {};
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const cmeta = this.meta.get(child);
      const slot = this.makeSlot(parent, pmeta, child, cmeta, i, children.length);
      if (slot) child.slot = slot;
      this.assignSlots(child);
    }
  }

  makeSlot(parent, pmeta, child, cmeta, index, count) {
    const slot = this.rawSlot(parent, pmeta, child, cmeta, index, count);
    // CSS centres a single line with `line-height == box height`. UMG's TextBlock
    // has no vertical content alignment, so the *slot* has to centre the widget.
    // Only where that slot means "vertical position inside a box": for a box slot
    // (border/sizebox/…) or for a row's cross axis. On a VerticalBox the vertical
    // alignment is the flow axis, so applying it there would re-centre something
    // the flex layout already placed.
    if (slot && cmeta && cmeta.textVerticalCenter && Object.prototype.hasOwnProperty.call(slot, 'VerticalAlignment')) {
      const parentClass = parent.class;
      const verticalIsCrossAxis = parentClass === CLASS.HORIZONTAL || parentClass === CLASS.WRAP;
      const isBoxSlot =
        parentClass === CLASS.BORDER ||
        parentClass === CLASS.SIZE_BOX ||
        parentClass === CLASS.SCROLL_BOX ||
        parentClass === CLASS.BUTTON ||
        parentClass === CLASS.OVERLAY;
      // An explicit cross-axis alignment in CSS wins over the line-height trick.
      const parentAlign = (pmeta && pmeta.style && pmeta.style.alignItems) || 'normal';
      const parentAlreadyAligns = parentAlign !== 'normal' && parentAlign !== 'stretch';
      if (isBoxSlot || (verticalIsCrossAxis && !parentAlreadyAligns)) {
        slot.VerticalAlignment = 'Center';
      }
    }
    return slot;
  }

  rawSlot(parent, pmeta, child, cmeta, index, count) {
    const orientation = BOX_SLOTS[parent.class];
    if (orientation) return this.boxSlot(pmeta, cmeta, index, orientation);
    switch (parent.class) {
      case CLASS.CANVAS:
        return this.canvasSlot(cmeta);
      case CLASS.GRID:
        return this.gridSlot(pmeta, cmeta, index);
      case CLASS.UNIFORM_GRID:
        return this.uniformSlot(pmeta, index);
      case CLASS.BORDER:
      case CLASS.SIZE_BOX:
      case CLASS.SCROLL_BOX:
      case CLASS.BUTTON:
      case CLASS.OVERLAY:
        // Single-child wrapper slots: padding is always handled by the wrapper
        // itself, so only the alignment members are emitted (they exist on every
        // one of these slot classes).
        return { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
      case CLASS.SCALE_BOX:
        // UScaleBoxSlot has no Padding (only the deprecated field), so only the
        // alignment members are legal here.
        return { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------- slots
  boxSlot(pmeta, cmeta, index, orientation) {
    const pstyle = (pmeta && pmeta.style) || {};
    const style = (cmeta && cmeta.style) || {};
    const vertical = orientation === 'v';
    const out = {};
    const margin = style.margin || [0, 0, 0, 0];

    const measured = pstyle.measuredMainGaps;
    let usedMainGap = 0;
    if (measured) {
      // justify-content: space-* — the measured inter-child gaps reproduce the
      // distribution at the design size (documented approximation).
      const mainGap = measured[index] || 0;
      usedMainGap = mainGap;
      out.Padding = vertical
        ? [V.round(margin[0], 2), V.round(mainGap, 2), V.round(margin[2], 2), 0]
        : [V.round(mainGap, 2), V.round(margin[1], 2), 0, V.round(margin[3], 2)];
    } else {
      // The gap only exists *between* children and only on the main axis:
      // column-like boxes grow downward (Top), row-like boxes rightward (Left).
      const mainGap = index > 0 ? (vertical ? pstyle.rowGap || 0 : pstyle.columnGap || 0) : 0;
      usedMainGap = mainGap;
      out.Padding = vertical
        ? [V.round(margin[0], 2), V.round(margin[1] + mainGap, 2), V.round(margin[2], 2), V.round(margin[3], 2)]
        : [V.round(margin[0] + mainGap, 2), V.round(margin[1], 2), V.round(margin[2], 2), V.round(margin[3], 2)];
    }

    // Size on the main axis, in priority order:
    //   1. flex-grow > 0          -> Fill weight (CSS flex distribution)
    //   2. main-axis percentage    -> Fill weight (CSS % of the parent)
    //   3. otherwise               -> Automatic (desired size)
    // A Fill slot with Value 0 collapses to zero in Slate (SBoxPanel skips
    // distribution when the total stretch coefficient is 0), so never emit that.
    const grow = style.flexGrow || 0;
    const mainPercent = vertical ? style.percentHeight : style.percentWidth;
    if (orientation !== 'w') {
      if (grow > 0) {
        out.Size = { Value: V.round(grow, 3), SizeRule: 'Fill' };
      } else if (mainPercent !== null && mainPercent !== undefined && mainPercent > 0) {
        out.Size = { Value: V.round(Math.min(mainPercent, 4), 3), SizeRule: 'Fill' };
      } else {
        out.Size = { SizeRule: 'Automatic' };
      }
    }

    const justify = pstyle.justify || 'normal';
    const alignItems = pstyle.alignItems || 'normal';
    const alignSelf = style.alignSelf || 'auto';
    const cross = alignSelf !== 'auto' ? alignSelf : alignItems;
    const mainAlign = mapJustify(justify, vertical);
    const crossAlign = mapAlign(cross, vertical);
    if (vertical) {
      out.HorizontalAlignment = crossAlign;
      out.VerticalAlignment = mainAlign;
    } else {
      out.HorizontalAlignment = mainAlign;
      out.VerticalAlignment = crossAlign;
    }
    // A text run that followed an inline widget carries its separating space, but
    // only when no explicit gap already separates them.
    const inlineSpace = (cmeta && cmeta.inlineSpace) || 0;
    if (inlineSpace && !usedMainGap) {
      out.Padding[vertical ? 1 : 0] = V.round(out.Padding[vertical ? 1 : 0] + inlineSpace, 2);
    }
    return out;
  }

  canvasSlot(cmeta) {
    const rec = cmeta && cmeta.rec;
    const style = (cmeta && cmeta.style) || null;

    if (cmeta && cmeta.isFlowGroup) {
      return {
        LayoutData: {
          Anchors: { Minimum: [0, 0], Maximum: [1, 1] },
          Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
          Alignment: [0, 0],
        },
        // UCanvasPanelSlot's reflected bool keeps its b-prefix (the UPROPERTY is
        // literally `bAutoSize`), so that is the key a reflection importer needs.
        bAutoSize: false,
      };
    }

    const samples = rec ? this.samples.get(rec.i) : null;
    const insets = rec ? this.declaredInsets(rec) : null;
    const xAxis = this.axisPlacement('x', insets, style, samples, rec);
    const yAxis = this.axisPlacement('y', insets, style, samples, rec);

    const slot = {
      LayoutData: {
        Anchors: { Minimum: [xAxis.min, yAxis.min], Maximum: [xAxis.max, yAxis.max] },
        Offsets: { Left: xAxis.offset, Top: yAxis.offset, Right: xAxis.offsetEnd, Bottom: yAxis.offsetEnd },
        Alignment: [0, 0],
      },
      bAutoSize: xAxis.min === xAxis.max && yAxis.min === yAxis.max && xAxis.auto && yAxis.auto,
    };
    const z = style ? style.zIndex : 0;
    if (z) slot.ZOrder = z;
    return slot;
  }

  /**
   * Declared CSS edge constraints of an absolutely positioned element.
   * Anchors are derived from these, **not** from measured ratios: a px inset is an
   * edge pin (anchor 0 or 1), while only a percentage inset is a proportional
   * anchor. Measuring ratios made the design size look right and every other
   * resolution wrong.
   */
  declaredInsets(rec) {
    const decl = (rec && rec.decl) || {};
    const read = (name) => {
      const raw = decl[name];
      if (raw === undefined || raw === null) return null;
      const text = String(raw).trim().toLowerCase();
      if (!text || text === 'auto' || text === 'initial' || text === 'unset' || text === 'inherit') return null;
      const percent = /^(-?[\d.]+)%$/.exec(text);
      if (percent) return { kind: 'pct', value: parseFloat(percent[1]) / 100 };
      const px = /^(-?[\d.]+)px$/.exec(text);
      if (px) return { kind: 'px', value: parseFloat(px[1]) };
      if (/^-?[\d.]+$/.test(text)) return { kind: 'px', value: parseFloat(text) };
      return null; // calc()/var(): fall back to measurement
    };
    return { left: read('left'), right: read('right'), top: read('top'), bottom: read('bottom') };
  }

  /** translate percentages of an element (used to detect "centred by transform"). */
  transformShift(rec) {
    const text = String((rec && rec.cs && rec.cs.transform) || '').toLowerCase();
    if (!text || text === 'none') return null;
    const out = { x: null, y: null };
    const both = /translate(?:3d)?\(\s*(-?[\d.]+)%\s*(?:,\s*(-?[\d.]+)%)?/.exec(text);
    if (both) {
      out.x = parseFloat(both[1]) / 100;
      if (both[2] !== undefined) out.y = parseFloat(both[2]) / 100;
    }
    const onlyX = /translatex\(\s*(-?[\d.]+)%/.exec(text);
    if (onlyX) out.x = parseFloat(onlyX[1]) / 100;
    const onlyY = /translatey\(\s*(-?[\d.]+)%/.exec(text);
    if (onlyY) out.y = parseFloat(onlyY[1]) / 100;
    return out;
  }

  /**
   * One canvas axis, decided by the CSS constraint (SConstraintCanvas semantics):
   *   both insets + auto size -> stretch, offsets are the two insets
   *   one inset               -> point anchor on that edge (0/1 for px, ratio for %)
   *   no inset                -> centred, else inferred from the probes
   */
  axisPlacement(axis, insets, style, samples, rec) {
    const isX = axis === 'x';
    // samples is {x: [...], y: [...]} — one entry per measured viewport.
    const series = samples ? samples[axis] : null;
    const base = series && series[0];
    if (!base) return { min: 0, max: 0, offset: 0, offsetEnd: 0, auto: true };
    const safeInsets = insets || { left: null, right: null, top: null, bottom: null };
    const near = isX ? safeInsets.left : safeInsets.top;
    const far = isX ? safeInsets.right : safeInsets.bottom;
    const fixed = isX ? style.fixedWidth : style.fixedHeight;
    const percent = isX ? style.percentWidth : style.percentHeight;
    const maxSize = isX ? style.maxWidth : style.maxHeight;
    const hasDeclaredSize = fixed !== null || maxSize !== null || percent !== null;
    const size = fixed !== null
      ? fixed
      : maxSize !== null
        ? maxSize
        : percent !== null
          ? percent * base.parentSize
          : base.size;

    // 0. A declared percentage *size* must stay proportional: express it as a
    //    stretch that spans that fraction of the parent (a frozen px width would
    //    stop scaling at other resolutions). max-width still wins, because it is a
    //    real clamp rather than a proportion.
    if (percent !== null && fixed === null && maxSize === null) {
      const span = V.clamp(percent, 0, 1);
      let start;
      if (near && near.kind === 'pct') start = V.clamp(near.value, 0, 1);
      else if (far && far.kind === 'pct') start = V.clamp(1 - far.value - span, 0, 1);
      else start = V.clamp(base.parentSize ? base.pos / base.parentSize : 0, 0, 1);
      const end = V.clamp(start + span, 0, 1);
      return {
        min: V.round(start, 4),
        max: V.round(end, 4),
        offset: V.round(base.pos - start * base.parentSize, 2),
        offsetEnd: V.round(base.parentSize - base.pos - base.size - (1 - end) * base.parentSize, 2),
        auto: false,
      };
    }

    // 1. Opposing insets with an auto size: stretch between them.
    if (near && far && !hasDeclaredSize) {
      const min = near.kind === 'pct' ? V.clamp(near.value, 0, 1) : 0;
      const max = far.kind === 'pct' ? 1 - V.clamp(far.value, 0, 1) : 1;
      return {
        min: V.round(min, 4),
        max: V.round(max, 4),
        offset: V.round(base.pos - min * base.parentSize, 2),
        offsetEnd: V.round(base.parentSize - base.pos - base.size - (1 - max) * base.parentSize, 2),
        auto: false,
      };
    }

    // 2. A single inset: pin to that edge. px means the edge itself (0 or 1).
    if (near || far) {
      const raw = near
        ? (near.kind === 'pct' ? near.value : 0)
        : (far.kind === 'pct' ? 1 - far.value : 1);
      const anchor = V.clamp(raw, 0, 1);
      return {
        min: V.round(anchor, 4),
        max: V.round(anchor, 4),
        // Deriving the offset from the measurement keeps the design viewport exact
        // even when a transform shifts the element (translate(-50%) etc.).
        offset: V.round(base.pos - anchor * base.parentSize, 2),
        offsetEnd: V.round(size, 2),
        auto: !hasDeclaredSize,
      };
    }

    // 3. No inset: a centred element anchors at 0.5 (transform or measurement).
    const shift = this.transformShift(rec);
    const shifted = shift && ((isX && shift.x === -0.5) || (!isX && shift.y === -0.5));
    const centreRatio = base.parentSize ? (base.pos + base.size / 2) / base.parentSize : 0;
    if (shifted || Math.abs(centreRatio - 0.5) < 0.01) {
      return {
        min: 0.5,
        max: 0.5,
        offset: V.round(base.pos - 0.5 * base.parentSize, 2),
        offsetEnd: V.round(size, 2),
        auto: !hasDeclaredSize,
      };
    }

    // 4. Fall back to the multi-probe ratio inference.
    return this.applyFixedAxis(this._inferAxis(series), hasDeclaredSize ? size : null, series);
  }

  /**
   * Infer one canvas axis from the per-viewport samples: does the element stay
   * pinned to the left, to the right, to the centre, or does it stretch?
   * This is the whole point of --probe: a single viewport cannot tell
   * "left:24px" from "right:24px".
   */
  _inferAxis(samples) {
    if (!samples || !samples.length) {
      return { min: 0, max: 0, offset: 0, offsetEnd: 0, auto: true };
    }
    const base = samples[0];
    const p = base.parentSize || 1;
    const spread = (arr) => Math.max.apply(null, arr) - Math.min.apply(null, arr);

    if (samples.length === 1) {
      const rightGap = p - base.pos - base.size;
      if (Math.abs(base.pos) < 1 && Math.abs(base.size - p) < 1.5) {
        return { min: 0, max: 1, offset: 0, offsetEnd: 0, auto: false };
      }
      if (rightGap <= 8 && base.pos > p * 0.5) {
        return { min: 1, max: 1, offset: V.round(base.pos - p, 2), offsetEnd: V.round(base.size, 2), auto: false };
      }
      if (Math.abs(base.pos + base.size / 2 - p / 2) < p * 0.02) {
        return { min: 0.5, max: 0.5, offset: V.round(base.pos - p / 2, 2), offsetEnd: V.round(base.size, 2), auto: true };
      }
      return { min: 0, max: 0, offset: V.round(base.pos, 2), offsetEnd: V.round(base.size, 2), auto: true };
    }

    const leftRatios = samples.map((s) => (s.parentSize ? s.pos / s.parentSize : 0));
    const rightRatios = samples.map((s) => (s.parentSize ? (s.parentSize - s.pos - s.size) / s.parentSize : 0));
    const sizes = samples.map((s) => s.size);
    const centers = samples.map((s) => (s.parentSize ? (s.pos + s.size / 2) / s.parentSize : 0));
    const sizeConst = spread(sizes) < 1.5;
    const leftConst = spread(leftRatios) < 0.02;
    const rightConst = spread(rightRatios) < 0.02;

    const fullBleed =
      leftConst && rightConst && Math.abs(leftRatios[0]) < 0.005 && Math.abs(rightRatios[0]) < 0.005;
    if (fullBleed) {
      return { min: 0, max: 1, offset: 0, offsetEnd: 0, auto: false };
    }
    if (leftConst && rightConst && !sizeConst) {
      const min = V.clamp(leftRatios[0], 0, 1);
      const max = 1 - V.clamp(rightRatios[0], 0, 1);
      return {
        min: V.round(min, 4),
        max: V.round(max, 4),
        offset: V.round(base.pos - min * p, 2),
        offsetEnd: V.round(p - base.pos - base.size - (1 - max) * p, 2),
        auto: false,
      };
    }
    // Centred content (left:50% + negative margin, margin:0 auto, ...): both edge
    // ratios drift while the centre stays put. Only valid when neither edge is
    // pinned, otherwise a scaled left-anchored box would look "centred".
    if (!leftConst && !rightConst && spread(centers) < 0.02) {
      const anchor = 0.5;
      return {
        min: anchor,
        max: anchor,
        offset: V.round(base.pos - anchor * p, 2),
        offsetEnd: V.round(base.size, 2),
        auto: true,
      };
    }
    // Pin to whichever edge is closer (a right:24px pill must not drift).
    if (rightConst && (!leftConst || rightRatios[0] < leftRatios[0])) {
      const anchor = V.clamp(1 - rightRatios[0], 0, 1);
      return {
        min: V.round(anchor, 4),
        max: V.round(anchor, 4),
        offset: V.round(base.pos - anchor * p, 2),
        offsetEnd: V.round(base.size, 2),
        auto: true,
      };
    }
    const anchor = V.clamp(leftRatios[0], 0, 1);
    return {
      min: V.round(anchor, 4),
      max: V.round(anchor, 4),
      offset: V.round(base.pos - anchor * p, 2),
      offsetEnd: V.round(base.size, 2),
      auto: true,
    };
  }

  /** A CSS-declared px size always wins over the measured one on a flat axis. */
  applyFixedAxis(axis, fixed, samples) {
    if (fixed === null || fixed === undefined) return axis;
    if (axis.min === axis.max) {
      return Object.assign({}, axis, { offsetEnd: V.round(fixed, 2), auto: false });
    }
    // Stretch anchors conflict with a declared size: collapse to the leading anchor.
    const base = samples && samples[0];
    if (!base) return Object.assign({}, axis, { max: axis.min, offsetEnd: V.round(fixed, 2), auto: false });
    const p = base.parentSize || 1;
    const anchor = axis.min;
    return {
      min: anchor,
      max: anchor,
      offset: V.round(base.pos - anchor * p, 2),
      offsetEnd: V.round(fixed, 2),
      auto: false,
    };
  }

  gridSlot(pmeta, cmeta, index) {
    const pstyle = (pmeta && pmeta.style) || {};
    const style = (cmeta && cmeta.style) || {};
    const columns = Math.max(1, (pstyle.gridColumns || []).length);
    const explicitCol = style.gridColumnStart !== undefined ? parseInt(style.gridColumnStart, 10) : NaN;
    const explicitRow = style.gridRowStart !== undefined ? parseInt(style.gridRowStart, 10) : NaN;
    let row;
    let column;
    if (Number.isFinite(explicitCol) && explicitCol > 0) {
      column = explicitCol - 1;
      row = Number.isFinite(explicitRow) && explicitRow > 0 ? explicitRow - 1 : Math.floor(index / columns);
    } else {
      row = Math.floor(index / columns);
      column = index % columns;
    }
    const margin = style.margin || [0, 0, 0, 0];
    const halfGapX = (pstyle.columnGap || 0) / 2;
    const halfGapY = (pstyle.rowGap || 0) / 2;
    return {
      Row: row,
      Column: column,
      RowSpan: 1,
      ColumnSpan: 1,
      Layer: 0,
      Padding: [
        V.round(margin[0] + halfGapX, 2),
        V.round(margin[1] + halfGapY, 2),
        V.round(margin[2] + halfGapX, 2),
        V.round(margin[3] + halfGapY, 2),
      ],
      HorizontalAlignment: 'Fill',
      VerticalAlignment: 'Fill',
    };
  }

  uniformSlot(pmeta, index) {
    const pstyle = (pmeta && pmeta.style) || {};
    const columns = Math.max(1, (pstyle.gridColumns || []).length);
    return {
      Row: Math.floor(index / columns),
      Column: index % columns,
      HorizontalAlignment: 'Fill',
      VerticalAlignment: 'Fill',
    };
  }

  // --------------------------------------------------------------- traversal
  mapElement(rec, ctx) {
    if (!rec) return null;
    const ue = rec.ue || {};
    if (String(ue.ignore || '').toLowerCase() === 'true') return null;
    if (rec.tag === 'br') return null;
    if (ctx.depth > 200) {
      this.warn(`snapshot: tree deeper than 200 at '${this.label(rec)}'; subtree skipped`);
      return null;
    }

    const style = this.readStyle(rec);
    if (style.visibility === 'hidden') {
      this.warn(`note: '${this.label(rec)}' is visibility:hidden and was skipped`);
      return null;
    }
    this.checkUnsupported(rec);
    const fontMap = this.fontMapFor(rec, ctx.fontMap);
    return this.buildElement(rec, style, {
      fontMap,
      depth: ctx.depth + 1,
      orientation: ctx.orientation || null,
      isRoot: !!ctx.isRoot,
      forceName: ctx.forceName || null,
    });
  }

  fontMapFor(rec, inherited) {
    const raw = (rec.ue || {})['font-map'];
    if (!raw) return inherited;
    const map = new Map(inherited || []);
    const text = String(raw).trim();
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        for (const key of Object.keys(parsed)) map.set(key.toLowerCase(), String(parsed[key]));
        return map;
      } catch (err) {
        this.warn(`data-ue-font-map on '${this.label(rec)}' is not valid JSON; ignored`);
        return map;
      }
    }
    for (const pair of text.split(/[;,]/)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const family = pair.slice(0, eq).trim().toLowerCase();
      const target = pair.slice(eq + 1).trim();
      if (family && target) map.set(family, target);
    }
    return map;
  }

  /**
   * One DOM element can become a chain (outer -> inner):
   *   SizeBox -> Border -> [ScrollBox] -> content
   * The element's own name always lands on the outermost widget, because that is
   * the widget a BindWidget property on the base class will match.
   */
  buildElement(rec, style, ctx) {
    // Reuse of an already imported widget (contract §10): the element becomes one
    // instance node, its subtree is not expanded.
    const ue = rec.ue || {};
    const widgetPath = this.widgetPathOf(ue);
    if (widgetPath) {
      return this.buildWidgetInstance(rec, style, ctx, this.names.unique(ctx.forceName || baseName(rec)), widgetPath);
    }
    if (ue.component) {
      this.warn(
        `note: data-ue-component="${ue.component}" on '${this.label(rec)}' has no component registry; expanded inline (use data-ue-widget for asset reuse)`
      );
    }
    const kind = this.classify(rec, style);
    if (kind === 'skip') return null;

    const wantsScroll = this.wantsScroll(style, kind);
    const wantsBorder = style.hasVisualBox || style.hasPadding;
    const crossPercent = this.crossAxisPercentPx(rec, style, ctx.orientation);
    const wantsSize =
      !ctx.isRoot &&
      (style.fixedWidth !== null ||
        style.fixedHeight !== null ||
        style.minWidth !== null ||
        style.maxWidth !== null ||
        style.minHeight !== null ||
        style.maxHeight !== null ||
        crossPercent !== null);

    // Reserve names outer -> inner. The element's own name lands on the widget a
    // designer would actually bind (border, scroll box or the content widget);
    // only the pure SizeBox wrapper is demoted to a `_Size` suffix.
    const rootName = this.names.unique(ctx.forceName || baseName(rec));
    const plan = [];
    if (wantsSize) plan.push('size');
    if (wantsBorder) plan.push('border');
    if (wantsScroll) plan.push('scroll');
    plan.push('content');
    const primaryKey = LEAF_KINDS.has(kind) ? 'content' : wantsBorder ? 'border' : wantsScroll ? 'scroll' : 'content';
    const suffixFor = (key) => {
      if (key === 'size') return '_Size';
      if (key === 'border') return style.hasVisualBox ? '_BG' : '_Pad';
      if (key === 'scroll') return '_Scroll';
      return '_Content';
    };
    const nodeName = {};
    for (const key of plan) {
      nodeName[key] = key === primaryKey ? rootName : this.names.unique(`${rootName}${suffixFor(key)}`);
    }

    let node = this.buildContent(rec, style, kind, ctx, nodeName.content);
    // A decoration with no content is legitimate (Border/SizeBox with no children),
    // but an empty SizeBox alone is noise: bail out when nothing else is wanted.
    if (!node && !wantsBorder) return null;
    // Only the widget that carries the element's name becomes a blueprint variable.
    if (node && primaryKey !== 'content') node.variable = false;

    if (wantsScroll) {
      const scroll = this.makeNode(nodeName.scroll, CLASS.SCROLL_BOX, rec, primaryKey !== 'scroll');
      const vertical = style.overflowY !== 'visible';
      scroll.properties = { Orientation: vertical ? 'Orient_Vertical' : 'Orient_Horizontal' };
      if (node) scroll.children = [node];
      this.meta.set(scroll, { rec, style, kind: 'scroll' });
      node = scroll;
    }

    if (wantsBorder) {
      const border = this.makeNode(nodeName.border, CLASS.BORDER, rec, primaryKey !== 'border');
      const policy = this.outlinePolicy(this.sidesFromStyle(style), this.label(rec), 'border');
      border.brush = this.borderBrush(style, rec, policy);
      const inset = [0, 1, 2, 3].map((i) =>
        V.round((style.padding[i] || 0) + (style.borderWidth[i] || 0) + (policy.extra[i] || 0), 2)
      );
      if (inset.some((v) => v !== 0)) border.properties = { Padding: inset };
      if (node) border.children = [node];
      this.meta.set(border, { rec, style, kind: 'border' });
      node = border;
    }

    if (wantsSize) {
      const box = this.makeNode(nodeName.size, CLASS.SIZE_BOX, rec, true);
      box.properties = this.sizeBoxProperties(style, crossPercent);
      if (node) box.children = [node];
      this.meta.set(box, { rec, style, kind: 'sizebox' });
      node = box;
    }

    if (!node) return null;
    if (style.opacity < 0.999) {
      node.properties = node.properties || {};
      node.properties.RenderOpacity = V.round(style.opacity, 3);
    }
    if (String((rec.ue || {}).variable || '').toLowerCase() === 'false') node.variable = false;
    return node;
  }

  /**
   * CSS percentages on the *cross* axis of a box container have no UMG
   * equivalent (a box slot only weights the main axis), so they are pinned to the
   * measured size — never left as Automatic, which would collapse to zero.
   * Percentages on the main axis become Fill weights in boxSlot().
   */
  crossAxisPercentPx(rec, style, orientation) {
    if (orientation !== 'v' && orientation !== 'h' && orientation !== 'w') return null;
    const out = {};
    const label = this.label(rec);
    const widthIsMain = orientation === 'h';
    const heightIsMain = orientation === 'v';
    if (style.percentWidth !== null && !widthIsMain && style.percentWidth < 0.995) {
      out.width = V.round(rec.rect[2], 2);
      this.warn(
        `approximated: width:${Math.round(style.percentWidth * 100)}% on '${label}' pinned to ${out.width}px — UMG box slots have no cross-axis weight`
      );
    }
    if (style.percentHeight !== null && !heightIsMain && style.percentHeight < 0.995) {
      out.height = V.round(rec.rect[3], 2);
      this.warn(
        `approximated: height:${Math.round(style.percentHeight * 100)}% on '${label}' pinned to ${out.height}px — UMG box slots have no cross-axis weight`
      );
    }
    return Object.keys(out).length ? out : null;
  }

  /** `data-ue-widget`, or `data-ue-class` holding an asset path. Null when inlining. */
  widgetPathOf(ue) {
    if (!ue) return null;
    const hasInline = Object.prototype.hasOwnProperty.call(ue, 'inline');
    const raw = ue.widget || (ue.class && /^[A-Za-z0-9_]*\/|^\//.test(String(ue.class)) ? ue.class : null);
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value) return null;
    if (hasInline) return null; // data-ue-inline: expand normally
    return value;
  }

  /**
   * A single widget node standing for a reused Widget Blueprint. Only children
   * explicitly tagged with `data-ue-slot` are emitted, each carrying `namedSlot`.
   */
  buildWidgetInstance(rec, style, ctx, name, widgetPath) {
    const node = this.makeNode(name, widgetPath, rec);
    const slotChildren = [];
    for (const item of this.childItems(rec)) {
      if (item.kind !== 'el') {
        if (item.kind === 'text' && String(item.text || '').trim()) {
          this.warn(`note: bare text inside data-ue-widget '${this.label(rec)}' is ignored`);
        }
        continue;
      }
      const childUe = item.rec.ue || {};
      if (!childUe.slot) {
        this.warn(
          `note: '${this.label(item.rec)}' inside data-ue-widget '${this.label(rec)}' has no data-ue-slot; children of an instance are not expanded`
        );
        continue;
      }
      const childNode = this.mapElement(item.rec, Object.assign({}, ctx, { isRoot: false, forceName: null }));
      if (!childNode) continue;
      // §10.2: a slot child has no layout of its own; the reused WBP decides it.
      childNode.namedSlot = String(childUe.slot);
      slotChildren.push(childNode);
    }
    if (slotChildren.length) node.children = slotChildren;
    if (String((rec.ue || {}).variable || '').toLowerCase() === 'false') node.variable = false;
    this.meta.set(node, { rec, style, kind: 'widget-instance' });

    // A declared CSS box still sizes the instance like any other element.
    if (style && (style.fixedWidth !== null || style.fixedHeight !== null)) {
      const box = {
        name: this.names.unique(`${name}_Size`),
        class: CLASS.SIZE_BOX,
        source: this.label(rec),
        variable: false,
        properties: this.sizeBoxProperties(style, null),
        children: [node],
      };
      this.meta.set(box, { rec, style, kind: 'sizebox' });
      return box;
    }
    return node;
  }

  sizeBoxProperties(style, cross) {
    const props = {};
    const set = (valueProp, overrideProp, value) => {
      if (value === null || value === undefined) return;
      props[valueProp] = V.round(value, 2);
      // SizeBox members are gated by bOverride_* bitfields; both are emitted so
      // a name-driven reflection setter reproduces the size without special cases.
      props[overrideProp] = true;
    };
    const extra = cross || {};
    set('WidthOverride', 'bOverride_WidthOverride', style.fixedWidth !== null ? style.fixedWidth : extra.width);
    set('HeightOverride', 'bOverride_HeightOverride', style.fixedHeight !== null ? style.fixedHeight : extra.height);
    set('MinDesiredWidth', 'bOverride_MinDesiredWidth', style.minWidth);
    set('MaxDesiredWidth', 'bOverride_MaxDesiredWidth', style.maxWidth);
    set('MinDesiredHeight', 'bOverride_MinDesiredHeight', style.minHeight);
    set('MaxDesiredHeight', 'bOverride_MaxDesiredHeight', style.maxHeight);
    return props;
  }

  wantsScroll(style, kind) {
    if (kind === 'text' || kind === 'image') return false;
    return (
      style.overflowY === 'auto' ||
      style.overflowY === 'scroll' ||
      style.overflowX === 'auto' ||
      style.overflowX === 'scroll'
    );
  }

  makeNode(name, cls, rec, synthetic) {
    const node = { name, class: cls };
    if (rec) node.source = this.label(rec);
    if (synthetic) node.variable = false;
    return node;
  }

  // -------------------------------------------------------------- classifier
  classify(rec, style) {
    const ue = rec.ue || {};
    if (ue.class) return 'custom';
    // data-ue-control promotes a hand-rolled div into a real UMG control.
    if (ue.control || ue.options) {
      const forced = this.forcedControlKind(ue.control);
      if (forced) return forced;
      if (ue.options) return 'combobox';
      this.warn(
        `data-ue-control="${ue.control}" on '${this.label(rec)}' is not a known control (combobox|checkbox|slider|progress|textbox|button); kept as layout`
      );
    }
    const tag = rec.tag;
    if (UNSUPPORTED_TAGS[tag]) return 'placeholder';
    if (tag === 'img' || tag === 'svg' || tag === 'picture') return 'image';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'progress') return 'progress';
    if (tag === 'textarea') return 'textinput';
    if (tag === 'input') return this.classifyInput(rec);
    if (this.isTextOnly(rec)) return 'text';
    if (style.display === 'grid' || style.display === 'inline-grid') return 'grid';
    if (style.display === 'flex' || style.display === 'inline-flex') return 'flex';
    if (this.absChildCount(rec) > 0) return 'canvas';
    return 'block';
  }

  /** data-ue-control value -> mapper kind (contract §6 extension). */
  forcedControlKind(raw) {
    const key = String(raw || '').trim().toLowerCase();
    const table = {
      combobox: 'combobox', combo: 'combobox', select: 'combobox', dropdown: 'combobox', listbox: 'combobox',
      checkbox: 'checkbox', check: 'checkbox', switch: 'checkbox', toggle: 'checkbox',
      radio: 'radio',
      slider: 'range', range: 'range', track: 'range',
      progress: 'progress', progressbar: 'progress', bar: 'progress', meter: 'progress',
      textbox: 'textinput', text: 'textinput', input: 'textinput', edit: 'textinput', field: 'textinput',
      button: 'button', btn: 'button', submit: 'button',
    };
    return table[key] || null;
  }

  classifyInput(rec) {    const type = ((rec.form && rec.form.type) || 'text').toLowerCase();
    switch (type) {
      case 'checkbox':
      case 'radio':
        return type;
      case 'range':
        return 'range';
      case 'submit':
      case 'button':
      case 'reset':
        return 'button';
      case 'hidden':
        return 'skip';
      case 'password':
      case 'email':
      case 'search':
      case 'tel':
      case 'url':
      case 'number':
      case 'text':
        return 'textinput';
      default:
        this.warn(`unsupported: <input type="${type}"> on '${this.label(rec)}' rendered as a text box`);
        return 'textinput';
    }
  }

  isTextOnly(rec) {
    if (rec.elemKids === 0) return !!rec.text;
    if (rec.blockKids > 0) return false;
    // A replaced / painted inline child cannot be merged into a text run: it is a
    // widget of its own (<label><input type=checkbox> Caption</label>).
    if (this.hasBarrierChild(rec)) return false;
    return this.mergedText(rec).text.length > 0;
  }

  hasBarrierChild(rec) {
    for (const index of rec.k || []) {
      const child = this.byIndex.get(index);
      if (!child) continue;
      if (this.isBarrierEl(child)) return true;
    }
    return false;
  }

  /**
   * Is this element a self-contained object rather than a piece of text? Only the
   * computed style and the element role are consulted, never a hard-coded tag list
   * of "things that look like buttons".
   */
  isBarrierEl(rec) {
    if (!rec) return false;
    if (REPLACED_TAGS[rec.tag]) return true;
    const ue = rec.ue || {};
    if (ue.control || ue.options) return true;
    const cs = rec.cs || {};
    const display = cs.display || 'inline';
    const painted =
      (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
      /[1-9]/.test(cs.borderTopWidth || '0px') ||
      /[1-9]/.test(cs.borderLeftWidth || '0px');
    if (display === 'inline-block' || display === 'inline-flex' || display === 'inline-grid' || display === 'inline-table') {
      // Unstyled inline-block text spans stay merged (same pixels, smaller tree);
      // painted or interactive ones become their own widget.
      return painted || !!rec.text ? painted : false;
    }
    return false;
  }

  absChildCount(rec) {
    let count = 0;
    for (const index of rec.k || []) {
      const child = this.byIndex.get(index);
      if (!child) continue;
      const pos = (child.cs && child.cs.position) || 'static';
      if (pos === 'absolute' || pos === 'fixed') count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------- text
  mergedText(rec) {
    const parts = [];
    const styles = new Set();
    const pile = (r, depth) => {
      if (depth > 12) return;
      for (const run of r.runs || []) {
        if (typeof run === 'string') {
          parts.push(run);
          continue;
        }
        const child = this.byIndex.get((r.k || [])[run.r]);
        if (!child) continue;
        if (child.tag === 'br') {
          parts.push('\u0000');
          continue;
        }
        if (child.text) {
          styles.add(textSignature(child));
          parts.push(child.text);
        } else {
          pile(child, depth + 1);
        }
      }
    };
    pile(rec, 0);
    let text = parts.join('');
    const preserve = /^pre/.test(String((rec.cs || {}).whiteSpace || 'normal'));
    if (!preserve) text = text.replace(/[ \t\r\n\f]+/g, ' ');
    text = text.replace(/ ?\u0000 ?/g, '\n').trim();
    return { text, styles };
  }

  firstTextRecord(rec) {
    if (rec.text) return rec;
    for (const run of rec.runs || []) {
      if (typeof run === 'string') continue;
      const child = this.byIndex.get((rec.k || [])[run.r]);
      if (!child) continue;
      if (child.text) return child;
      const inner = this.firstTextRecord(child);
      if (inner) return inner;
    }
    return null;
  }

  buildText(rec, style, ctx, name) {
    const merged = this.mergedText(rec);
    if (merged.styles.size > 1) {
      this.warn(`approximated: inline styling inside '${this.label(rec)}' collapsed into one TextBlock`);
    }
    const textRec = this.firstTextRecord(rec) || rec;
    const textStyle = textRec === rec ? style : this.readStyle(textRec);

    let text = merged.text;
    if (style.textTransform === 'uppercase') text = text.toUpperCase();
    else if (style.textTransform === 'lowercase') text = text.toLowerCase();
    else if (style.textTransform === 'capitalize') {
      text = text.replace(/(^|\s)(\S)/g, (m, space, ch) => space + ch.toUpperCase());
    }

    const node = this.makeNode(name, CLASS.TEXT, rec);
    const props = {
      Text: text,
      Font: this.fontProperties(textRec, textStyle, ctx.fontMap),
      ColorAndOpacity: textStyle.color,
      Justification: mapJustifyText(style.textAlign),
      AutoWrapText: !/^nowrap/.test(style.whiteSpace),
    };
    // `line-height` means two different things and they must not be mixed:
    //   * line-height == box height on a single line -> the author wanted vertical
    //     centring; UMG cannot centre inside a TextBlock, so the slot does it.
    //   * otherwise it is line spacing -> TextBlock.LineHeightPercentage.
    const lineHeightPx = V.parsePx(textStyle.lineHeight);
    const verticalPadding = (style.padding ? style.padding[1] + style.padding[3] : 0);
    const boxHeight = rec && rec.rect ? rec.rect[3] - verticalPadding : 0;
    const singleLine = text.indexOf('\n') < 0;
    const fillsBox = lineHeightPx !== null && boxHeight > 1 && lineHeightPx >= boxHeight * 0.9;
    // Only a genuinely single-run leaf text: a paragraph with inline children is a
    // wrapping block whose box the line-height did not fill.
    const centreSingleLine = singleLine && fillsBox && rec.elemKids === 0;
    if (!centreSingleLine) {
      const lineHeight = V.lineHeightToPercent(textStyle.lineHeight, textStyle.fontSize);
      if (lineHeight && Math.abs(lineHeight - 100) > 4) props.LineHeightPercentage = lineHeight;
    }
    const shadow = parseTextShadow(textStyle.textShadow);
    if (shadow) {
      props.ShadowOffset = shadow.offset;
      props.ShadowColorAndOpacity = shadow.color;
    }
    if (style.textDecoration.indexOf('underline') >= 0) {
      this.warn(`unsupported: text-decoration:underline on '${this.label(rec)}' dropped`);
    }
    if (style.textOverflow === 'ellipsis') props.TextOverflowPolicy = 'Ellipsis';
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'text', textVerticalCenter: centreSingleLine });
    return node;
  }

  /**
   * A bare text run inside a container that also holds real widgets: build a
   * TextBlock that inherits the container's typography, keeping document order.
   */
  buildRunText(rec, style, ctx, text, name) {
    const node = this.makeNode(name, CLASS.TEXT, rec || undefined);
    if (!style) {
      // No owner style available: fall back to a plain default TextBlock.
      node.properties = { Text: text };
      this.meta.set(node, { rec, style: null, kind: 'text' });
      return node;
    }
    let out = text;
    if (style.textTransform === 'uppercase') out = out.toUpperCase();
    else if (style.textTransform === 'lowercase') out = out.toLowerCase();
    else if (style.textTransform === 'capitalize') {
      out = out.replace(/(^|\s)(\S)/g, (match, space, ch) => space + ch.toUpperCase());
    }
    out = out.replace(/\s+/g, ' ').trim();
    node.properties = {
      Text: out,
      Font: this.fontProperties(rec, style, ctx.fontMap),
      ColorAndOpacity: style.color,
      Justification: mapJustifyText(style.textAlign),
      AutoWrapText: !/^nowrap/.test(style.whiteSpace),
    };
    // The run has no box of its own: the owner's margins must not leak into its slot.
    this.meta.set(node, { rec, style: Object.assign({}, style, { margin: [0, 0, 0, 0] }), kind: 'text' });
    return node;
  }

  fontProperties(rec, style, fontMap) {
    const font = {
      Size: V.round(style.fontSize, 2),
      TypefaceFontName: typefaceName(style.fontWeight, style.fontItalic),
    };
    const spacing = V.letterSpacingToSlate(style.letterSpacing, style.fontSize);
    if (spacing) font.LetterSpacing = Math.round(spacing);

    const families = String(style.fontFamily || '')
      .split(',')
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    const primary = families.length ? families[0] : 'Segoe UI';

    const mapped = fontMap && fontMap.get(primary.toLowerCase());
    if (mapped) {
      font.FontObject = mapped;
      return font;
    }
    if (this.assets) {
      const faces = (this.snapshot.fontFaces || [])
        .filter((face) => face.family.toLowerCase() === primary.toLowerCase())
        .map((face) => face.src)
        .filter(Boolean);
      const registered = this.assets.addFont(style.fontFamily, style.fontWeight, style.fontItalic, faces);
      if (registered && registered.hasFile) font.FontObject = `@${registered.key}`;
    }
    return font;
  }

  // ----------------------------------------------------------------- content
  buildContent(rec, style, kind, ctx, name) {
    switch (kind) {
      case 'placeholder':
        return this.buildPlaceholder(rec, style, name);
      case 'text':
        return this.buildText(rec, style, ctx, name);
      case 'image':
        return this.buildImage(rec, style, name);
      case 'button':
        return this.buildButton(rec, style, ctx, name);
      case 'textinput':
        return this.buildTextInput(rec, style, name);
      case 'combobox':
        return this.buildComboBox(rec, style, name);
      case 'progress':
        return this.buildProgress(rec, style, name);
      case 'checkbox':
        return this.buildCheckBox(rec, style, name, false);
      case 'radio':
        return this.buildCheckBox(rec, style, name, true);
      case 'range':
        return this.buildSlider(rec, style, name);
      default:
        return this.buildContainer(rec, style, kind, ctx, name);
    }
  }

  buildPlaceholder(rec, style, name) {
    this.warn(`unsupported: <${rec.tag}> on '${this.label(rec)}' replaced with an empty container`);
    const node = this.makeNode(name, CLASS.VERTICAL, rec);
    this.meta.set(node, { rec, style, kind: 'placeholder' });
    return node;
  }

  buildImage(rec, style, name) {
    const node = this.makeNode(name, CLASS.IMAGE, rec);
    const brush = { drawAs: 'Image', tiling: 'NoTile' };
    let texture = null;

    if (rec.tag === 'svg') {
      texture = this.assets && this.assets.seededFor(rec.i);
      if (!texture) this.warn(`asset: inline <svg> on '${this.label(rec)}' could not be rasterised`);
      const box = rec.rect;
      if (box) brush.imageSize = [V.round(box[2], 1), V.round(box[3], 1)];
    } else if (rec.img) {
      const src = rec.img.currentSrc || rec.img.src;
      if (src && this.assets) texture = this.assets.addFromUrl(src, { label: `img on '${this.label(rec)}'` });
      if (rec.img.naturalWidth && rec.img.naturalHeight) {
        brush.imageSize = [rec.img.naturalWidth, rec.img.naturalHeight];
      }
      const objectFit = (rec.cs && rec.cs.objectFit) || 'fill';
      if (objectFit === 'contain' || objectFit === 'cover') {
        this.warn(`approximated: object-fit:${objectFit} on '${this.label(rec)}' drawn as stretch`);
      }
    }

    if (texture) {
      brush.texture = `@${texture.key}`;
      delete brush.drawAs;
      brush.drawAs = 'Image';
    } else {
      brush.drawAs = 'NoDrawType';
      this.warn(`asset: no texture for image '${this.label(rec)}' (empty Image widget)`);
    }
    node.brush = brush;
    if (style.borderRadius.some((r) => r > 0)) {
      this.warn(`unsupported: rounded corners on image '${this.label(rec)}' dropped`);
    }
    this.meta.set(node, { rec, style, kind: 'image' });
    return node;
  }

  // -------------------------------------------------- control skin translation
  /** [left, top, right, bottom] side description from a CSS style record. */
  sidesFromStyle(style) {
    return {
      widths: style.borderWidth,
      colors: style.borderColors || [style.borderColor, style.borderColor, style.borderColor, style.borderColor],
      styles: style.borderStyles || ['solid', 'solid', 'solid', 'solid'],
    };
  }

  /** Same, from a resolved (computed) visual produced by the snapshot probe. */
  sidesFromVisual(visual) {
    const w = (v) => {
      const n = V.parsePx(v);
      return n === null ? 0 : n;
    };
    const c = (v) => V.colorToLinear(v) || [0, 0, 0, 0];
    return {
      widths: [w(visual.borderLeftWidth), w(visual.borderTopWidth), w(visual.borderRightWidth), w(visual.borderBottomWidth)],
      colors: [c(visual.borderLeftColor), c(visual.borderTopColor), c(visual.borderRightColor), c(visual.borderBottomColor)],
      styles: [
        visual.borderLeftStyle || 'solid',
        visual.borderTopStyle || 'solid',
        visual.borderRightStyle || 'solid',
        visual.borderBottomStyle || 'solid',
      ],
    };
  }

  /**
   * A Slate brush has exactly one outline, so four-sided CSS borders must be
   * collapsed to one. Every degradation is reported, and the returned `extra`
   * padding compensates the edges that gained an outline so text never collides
   * with it.
   */
  outlinePolicy(sides, label, where) {
    const what = where || 'border';
    const widths = sides.widths.map((value) => (Number.isFinite(value) ? value : 0));
    const maxWidth = Math.max.apply(null, widths);
    const extra = [0, 0, 0, 0];
    if (!(maxWidth > 0.01)) return { width: 0, color: null, extra, sides };
    const names = ['left', 'top', 'right', 'bottom'];
    let index = 0;
    for (let i = 1; i < 4; i += 1) if (widths[i] > widths[index]) index = i;
    const color = sides.colors[index] || [0, 0, 0, 0];
    const present = widths.filter((value) => value > 0.01).length;
    const uniform = present === 4 && widths.every((value) => Math.abs(value - maxWidth) < 0.01);
    if (!uniform) {
      for (let i = 0; i < 4; i += 1) extra[i] = V.round(Math.max(0, maxWidth - widths[i]), 2);
      if (present === 1) {
        this.warn(
          `approximated: only the ${names[index]} ${what} is kept on '${label}' (Slate brushes have a single outline); other edges padded by ${V.round(maxWidth, 2)}px`
        );
      } else {
        this.warn(
          `approximated: ${what} widths ${JSON.stringify(widths.map((v) => V.round(v, 2)))} on '${label}' collapsed to the widest (${V.round(maxWidth, 2)}px, ${names[index]} colour)`
        );
      }
    }
    if (sides.styles.some((value) => /dashed|dotted|double|groove|ridge/.test(String(value)))) {
      this.warn(`approximated: ${what}-style ${sides.styles.join('/')} on '${label}' drawn solid`);
    }
    return { width: V.round(maxWidth, 2), color, extra, sides };
  }

  /**
   * Brush built from a resolved visual: background tint + corner radii + the
   * collapsed outline. Returns null when the visual paints nothing (unless
   * allowEmpty), so callers can fall back instead of emitting a blank brush.
   */
  visualBrush(visual, options) {
    if (!visual) return null;
    const opts = options || {};
    const radii = [
      V.parsePx(visual.borderTopLeftRadius) || 0,
      V.parsePx(visual.borderTopRightRadius) || 0,
      V.parsePx(visual.borderBottomRightRadius) || 0,
      V.parsePx(visual.borderBottomLeftRadius) || 0,
    ].map((value) => V.round(value, 2));
    const brush = {};
    const hasRadius = radii.some((value) => value > 0);
    brush.drawAs = hasRadius ? 'RoundedBox' : 'Box';
    if (hasRadius) brush.cornerRadii = radii;
    brush.tint = V.colorToLinear(visual.backgroundColor) || [0, 0, 0, 0];
    const policy = this.outlinePolicy(this.sidesFromVisual(visual), opts.label || 'control', opts.where);
    if (policy.width > 0) {
      brush.outlineWidth = policy.width;
      brush.outlineColor = policy.color;
    }
    if (opts.opacity !== undefined && opts.opacity < 0.999) {
      brush.tint[3] = V.round(brush.tint[3] * V.clamp(opts.opacity, 0, 1), 4);
    }
    if (brush.tint[3] <= 0.002 && !policy.width) return opts.allowEmpty ? brush : null;
    return brush;
  }

  paddingFromVisual(visual) {
    if (!visual) return null;
    const px = (value) => {
      const n = V.parsePx(value);
      return n === null ? 0 : n;
    };
    return [
      V.round(px(visual.paddingLeft), 2),
      V.round(px(visual.paddingTop), 2),
      V.round(px(visual.paddingRight), 2),
      V.round(px(visual.paddingBottom), 2),
    ];
  }

  /** CSS content inset (padding + border) plus collapsed-outline compensation. */
  controlInset(style, visual, label) {
    const pad = (visual && this.paddingFromVisual(visual)) || style.padding;
    let borderWidths = style.borderWidth;
    let extra = [0, 0, 0, 0];
    if (visual) {
      const sides = this.sidesFromVisual(visual);
      borderWidths = sides.widths;
      extra = this.outlinePolicy(sides, label, 'border').extra;
    }
    const out = [0, 1, 2, 3].map((i) => V.round((pad[i] || 0) + (borderWidths[i] || 0) + (extra[i] || 0), 2));
    return out.some((value) => value !== 0) ? out : null;
  }

  /** Brush referring to a baked control part; null when that part was not baked. */
  bakedBrush(part) {
    if (!part || !part.key) return null;
    const brush = { drawAs: 'Image', texture: `@${part.key}`, tiling: 'NoTile' };
    const width = V.round(part.designWidth || 0, 2);
    const height = V.round(part.designHeight || 0, 2);
    if (width > 0 && height > 0) brush.imageSize = [width, height];
    return brush;
  }

  /** Baked parts for a record, or null. */
  bakedFor(rec) {
    if (!rec) return null;
    const entry = this.baked.get(rec.i);
    return entry && entry.parts ? entry.parts : null;
  }

  colorOf(visual) {
    if (!visual) return null;
    const color = V.colorToLinear(visual.color);
    return color && color[3] > 0 ? color : null;
  }

  radiusOf(visual) {
    if (!visual) return [0, 0, 0, 0];
    return [
      V.parsePx(visual.borderTopLeftRadius) || 0,
      V.parsePx(visual.borderTopRightRadius) || 0,
      V.parsePx(visual.borderBottomRightRadius) || 0,
      V.parsePx(visual.borderBottomLeftRadius) || 0,
    ].map((value) => V.round(value, 2));
  }

  /** Solid brush of one colour, keeping the given corner radii. */
  solidBrush(color, radii) {
    const brush = { drawAs: 'Box', tint: color };
    if (radii && radii.some((value) => value > 0)) {
      brush.drawAs = 'RoundedBox';
      brush.cornerRadii = radii;
    }
    return brush;
  }

  /**
   * Normalised option/row description for a combobox, whatever HTML produced it:
   * a real <select> (rows come from <option> declarations) or a hand-rolled div
   * dropdown (rows come from CSS-only selectors).
   */
  comboOptions(rec, ctl, ue) {
    const info = { labels: [], selected: -1, row: null, source: 'none' };
    if (rec.tag === 'select' && ctl.options && ctl.options.length) {
      info.labels = ctl.options.map((option) => option.label || option.value);
      info.selected = ctl.options.findIndex((option) => option.selected);
      if (info.selected < 0) info.selected = 0;
      const first = ctl.options[0];
      const selected = ctl.options[info.selected] || first;
      const even = ctl.options.find((option) => option.parity === 'even');
      const odd = ctl.options.find((option) => option.parity === 'odd');
      const plain = (option) => (option ? option.baseNoParity || option.base : null);
      const anyFocus = (list) => {
        for (let i = 0; i < list.length; i += 1) if (list[i].focus) return list[i].focus;
        return null;
      };
      info.row = {
        // The un-zebraed row look goes into InactiveBrush; zebra lives in its own
        // even/odd brushes so the table keeps its pattern at runtime.
        base: plain(first),
        hover: first.hover,
        active: selected.checked || plain(selected),
        activeHover: selected.checkedHover || selected.checked || plain(selected),
        focus: selected.focus || anyFocus(ctl.options),
        even: even ? even.parityVisual : null,
        odd: odd ? odd.parityVisual : null,
        text: this.colorOf(plain(first)) || this.colorOf(first.base) || this.colorOf(first.hover),
        activeText: this.colorOf(selected.checked) || this.colorOf(plain(selected)),
        controlText: this.colorOf(ctl.box),
        padding: this.paddingFromVisual(plain(first)),
        // Fallback chain for the row background: row -> list container -> control.
        listBg: null,
        controlBg: ctl.box || null,
      };
      info.source = 'select';
      return info;
    }

    const forced = ue && ue.options ? String(ue.options) : '';
    if (forced) {
      info.labels = forced.split('|').map((label) => label.trim()).filter(Boolean);
      const raw = ue.selected !== undefined ? parseInt(ue.selected, 10) : 0;
      info.selected = Number.isFinite(raw) && raw >= 0 && raw < info.labels.length ? raw : 0;
    }
    if (ctl.row) {
      info.row = {
        base: ctl.row.base,
        hover: ctl.row.hover,
        active: ctl.row.selected || ctl.row.base,
        activeHover: ctl.row.selectedHover || ctl.row.selected || ctl.row.hover,
        focus: ctl.row.focus || null,
        even: null,
        odd: null,
        text: this.colorOf(ctl.row.base) || this.colorOf(ctl.row.hover),
        activeText: this.colorOf(ctl.row.selected),
        controlText: this.colorOf(ctl.box),
        padding: this.paddingFromVisual(ctl.row.base),
        // A hand-rolled dropdown keeps its panel colour on the list container.
        listBg: ctl.row.list || null,
        controlBg: ctl.box || null,
      };
      info.source = 'css-rows';
    } else if (info.labels.length) {
      info.source = 'attributes-only';
    }
    return info;
  }

  rowPadding(info) {
    if (info.row && info.row.padding) {
      const pad = info.row.padding;
      if (pad.some((value) => value !== 0)) return pad;
    }
    return null;
  }

  comboItemStyle(info, label) {
    const row = info.row;
    if (!row) return null;

    // FComboBoxStyle has no "menu panel" brush: the popup draws its rows with
    // FTableRowStyle, so a dark dropdown must carry the panel colour on the rows.
    // Chain: row background -> list container -> control itself.
    const painted = (visual, where) => {
      const brush = this.visualBrush(visual, { label: `${label} ${where}`, allowEmpty: true });
      if (!brush) return null;
      const opaque = Array.isArray(brush.tint) && brush.tint[3] > 0.002;
      return opaque || brush.outlineWidth ? brush : null;
    };
    // A container used as a row surface contributes only its colour: repeating its
    // border/radius on every row would draw a frame around each line.
    const surface = (visual, where) => {
      const brush = painted(visual, where);
      if (!brush) return null;
      delete brush.outlineWidth;
      delete brush.outlineColor;
      delete brush.cornerRadii;
      brush.drawAs = 'Box';
      return brush;
    };
    const chain = (visuals, where, useSurface) => {
      for (const visual of visuals) {
        const brush = useSurface ? surface(visual, where) : painted(visual, where);
        if (brush) return brush;
      }
      return null;
    };
    const clone = (brush) => JSON.parse(JSON.stringify(brush));

    const inactive =
      painted(row.base, 'row') ||
      chain([row.listBg, row.controlBg], 'row', true) ||
      this.solidBrush([0, 0, 0, 0], null);
    const out = {
      InactiveBrush: inactive,
      InactiveHoveredBrush: chain([row.hover], 'row:hover') || clone(inactive),
      ActiveBrush: chain([row.active], 'row:selected') || clone(inactive),
    };
    out.ActiveHoveredBrush = chain([row.activeHover], 'row:selected:hover') || clone(out.ActiveBrush);
    // Keyboard focus row. Without a rule, reuse the hover look: otherwise UMG draws
    // its own bright highlight bar over the design.
    out.SelectorFocusedBrush =
      chain([row.focus], 'row:focused') || chain([row.hover], 'row:focused') || clone(inactive);
    // Zebra rows fall back to the plain row surface so neither is ever left empty.
    out.EvenRowBackgroundBrush = chain([row.even], 'row:even') || clone(inactive);
    out.OddRowBackgroundBrush = chain([row.odd], 'row:odd') || clone(inactive);
    const textColor = row.text || row.controlText || [1, 1, 1, 1];
    out.TextColor = textColor;
    out.SelectedTextColor = row.activeText || textColor;
    return out;
  }

  buildButton(rec, style, ctx, name) {
    const node = this.makeNode(name, CLASS.BUTTON, rec);
    const props = { IsFocusable: true };
    const ctl = rec.control || {};
    const label = this.label(rec);
    const base = this.visualBrush(ctl.box, { label: `${label} button`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);

    // FButtonStyle is the single source of truth for a button's look. A `brush`
    // block on the node would be applied after WidgetStyle and flatten the hovered
    // / pressed / disabled states back to the normal brush, so it is not emitted.
    const stateBrush = (key, where) => {
      if (!ctl.states || !ctl.states[key]) return null;
      return this.visualBrush(ctl.states[key], { label: `${label} ${where}`, allowEmpty: true });
    };
    const hover = stateBrush('hover', ':hover');
    const pressed = stateBrush('active', ':active');
    const disabled = stateBrush('disabled', ':disabled');

    const clone = (brush) => JSON.parse(JSON.stringify(brush));
    const buttonStyle = {};
    if (base) {
      // Every state is filled explicitly so no engine default skin shows through.
      buttonStyle.Normal = base;
      buttonStyle.Hovered = hover || clone(base);
      buttonStyle.Pressed = pressed || clone(base);
      buttonStyle.Disabled = disabled || clone(base);
    } else {
      if (hover) buttonStyle.Hovered = hover;
      if (pressed) buttonStyle.Pressed = pressed;
      if (disabled) buttonStyle.Disabled = disabled;
    }
    const inset = this.controlInset(style, ctl.box, label);
    if (inset) {
      buttonStyle.NormalPadding = inset;
      // Same inset on press so the label does not shift.
      buttonStyle.PressedPadding = inset;
    }
    if (Object.keys(buttonStyle).length) props.WidgetStyle = buttonStyle;

    if (this.mergedText(rec).text.length) {
      const textNode = this.buildText(rec, style, ctx, this.names.unique(`${name}_Label`));
      if (textNode) node.children = [textNode];
    }
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'button' });
    return node;
  }

  buildTextInput(rec, style, name) {
    const node = this.makeNode(name, CLASS.EDITABLE, rec);
    const form = rec.form || {};
    const ctl = rec.control || {};
    const label = this.label(rec);
    const props = {};
    if (form.placeholder) props.HintText = form.placeholder;
    if (form.value) props.Text = form.value;

    const normal = this.visualBrush(ctl.box, { label: `${label} box`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    const hover = ctl.states && ctl.states.hover ? this.visualBrush(ctl.states.hover, { label: `${label}:hover`, allowEmpty: true }) : null;
    const focused = ctl.states && ctl.states.focus ? this.visualBrush(ctl.states.focus, { label: `${label}:focus`, allowEmpty: true }) : null;
    const textColor = this.colorOf(ctl.computed) || style.color;

    // UEditableTextBox keeps its font, colours and background inside the style struct.
    const widgetStyle = {
      TextStyle: {
        Font: this.fontProperties(rec, style, new Map()),
        ColorAndOpacity: textColor,
      },
    };
    if (normal) {
      widgetStyle.BackgroundImageNormal = normal;
      widgetStyle.BackgroundImageHovered = hover || normal;
      widgetStyle.BackgroundImageFocused = focused || hover || normal;
      widgetStyle.BackgroundImageReadOnly = normal;
    }
    const inset = this.controlInset(style, ctl.box, label);
    if (inset) widgetStyle.Padding = inset;
    widgetStyle.ForegroundColor = textColor;
    widgetStyle.FocusedForegroundColor = this.colorOf(ctl.states && ctl.states.focus) || textColor;
    props.WidgetStyle = widgetStyle;
    // UEditableTextBox has no top-level ForegroundColor UPROPERTY - the colour lives in
    // WidgetStyle.ForegroundColor (set above) and is exposed through a setter function only.
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'textinput' });
    return node;
  }

  buildComboBox(rec, style, name) {
    const node = this.makeNode(name, CLASS.COMBO, rec);
    const ctl = rec.control || {};
    const ue = rec.ue || {};
    const label = this.label(rec);
    const info = this.comboOptions(rec, ctl, ue);
    const props = {};
    const baked = this.bakedFor(rec);

    if (info.labels.length) props.DefaultOptions = info.labels;
    if (info.selected >= 0 && info.labels[info.selected] !== undefined) {
      props.SelectedOption = info.labels[info.selected];
    }
    if (info.source === 'attributes-only') {
      this.warn(`note: '${label}' has options from data-ue-options but no row styling; add data-ue-item-class or real row elements`);
    } else if (info.source === 'css-rows') {
      this.warn(`note: '${label}' row styling derived from CSS stem '${ctl.row.stem}' (set data-ue-item-class to be explicit)`);
    }

    const base = this.visualBrush(ctl.box, { label: `${label} closed`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    const buttonStyle = {};
    if (base) buttonStyle.Normal = base;
    const hover = ctl.states && ctl.states.hover ? this.visualBrush(ctl.states.hover, { label: `${label}:hover`, allowEmpty: true }) : null;
    if (hover) buttonStyle.Hovered = hover;
    const focus = ctl.states && ctl.states.focus ? this.visualBrush(ctl.states.focus, { label: `${label}:focus`, allowEmpty: true }) : null;
    if (focus) buttonStyle.Pressed = focus;
    const disabled = ctl.states && ctl.states.disabled ? this.visualBrush(ctl.states.disabled, { label: `${label}:disabled`, allowEmpty: true }) : null;
    if (disabled) buttonStyle.Disabled = disabled;

    const widgetStyle = {};
    if (Object.keys(buttonStyle).length) {
      // Fill the states CSS never mentioned so no engine default skin leaks in
      // when the user hovers or clicks the closed combobox.
      const clone = (brush) => JSON.parse(JSON.stringify(brush));
      if (buttonStyle.Normal) {
        if (!buttonStyle.Hovered) buttonStyle.Hovered = clone(buttonStyle.Normal);
        if (!buttonStyle.Pressed) buttonStyle.Pressed = clone(buttonStyle.Hovered);
        if (!buttonStyle.Disabled) buttonStyle.Disabled = clone(buttonStyle.Normal);
      }
      widgetStyle.ComboButtonStyle = { ButtonStyle: buttonStyle };
    }
    // Baked pixels win over the vector approximation: they carry the native arrow,
    // the focus ring and the exact shading the browser drew.
    if (baked) {
      const bakedNormal = this.bakedBrush(baked.normal);
      if (bakedNormal) {
        const cloneNormal = () => JSON.parse(JSON.stringify(bakedNormal));
        widgetStyle.ComboButtonStyle = widgetStyle.ComboButtonStyle || {};
        widgetStyle.ComboButtonStyle.ButtonStyle = {
          Normal: bakedNormal,
          Hovered: this.bakedBrush(baked.hovered) || cloneNormal(),
          Pressed: this.bakedBrush(baked.pressed) || cloneNormal(),
          Disabled: this.bakedBrush(baked.disabled) || cloneNormal(),
        };
      }
    }
    const inset = this.controlInset(style, ctl.box, label);
    if (inset) widgetStyle.ContentPadding = inset;
    if (ctl.row && ctl.row.list) {
      const menu = this.visualBrush(ctl.row.list, { label: `${label} menu`, allowEmpty: true });
      if (menu && widgetStyle.ComboButtonStyle) widgetStyle.ComboButtonStyle.MenuBorderBrush = menu;
    }
    const rowPad = this.rowPadding(info);
    if (rowPad) widgetStyle.MenuRowPadding = rowPad;
    // data-ue-row-height: ComboBoxString has no row-height property, so the row
    // height is expressed as symmetric vertical MenuRowPadding instead.
    const declaredRow = ue['row-height'] !== undefined ? parseFloat(ue['row-height']) : NaN;
    if (Number.isFinite(declaredRow) && declaredRow > 0) {
      const line = (style.fontSize || 14) * 1.3;
      const vpad = V.round(Math.max(0, (declaredRow - line) / 2), 2);
      widgetStyle.MenuRowPadding = [rowPad ? rowPad[0] : 0, vpad, rowPad ? rowPad[2] : 0, vpad];
    }
    if (ue['menu-max-height'] !== undefined) {
      this.warn(`note: data-ue-menu-max-height on '${label}' has no ComboBoxString equivalent; set the menu size in the widget style asset`);
    }
    if (Object.keys(widgetStyle).length) props.WidgetStyle = widgetStyle;

    const itemStyle = this.comboItemStyle(info, label);
    if (itemStyle) props.ItemStyle = itemStyle;

    const textColor = (info.row && (info.row.activeText || info.row.text)) || this.colorOf(ctl.computed) || style.color;
    props.ForegroundColor = textColor;
    if (!info.labels.length) this.warn(`note: '<select>' on '${label}' has no options`);
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'combobox' });
    return node;
  }

  buildProgress(rec, style, name) {
    const node = this.makeNode(name, CLASS.PROGRESS, rec);
    const ctl = rec.control || {};
    const label = this.label(rec);
    const form = rec.form || {};
    const max = Number(form.max) || 1;
    const percent = V.clamp((Number(form.value) || 0) / max, 0, 1);
    const accent = ctl.accent ? V.colorToLinear(ctl.accent) : null;

    const trackVisual = ctl.progressBar || ctl.box;
    const track = this.visualBrush(trackVisual, { label: `${label} track`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    const radii = this.radiusOf(trackVisual);

    let fill = this.visualBrush(ctl.progressValue, { label: `${label} fill`, allowEmpty: true });
    const fillColor = (ctl.progressValue && V.colorToLinear(ctl.progressValue.backgroundColor)) || accent;
    if (!fill && fillColor && fillColor[3] > 0) fill = this.solidBrush([1, 1, 1, 1], radii);
    if (fill) {
      // FillColorAndOpacity multiplies the brush tint: keep the brush white so the
      // authored colour is not applied twice.
      fill.tint = [1, 1, 1, 1];
    }

    const props = { Percent: V.round(percent, 3) };
    const widgetStyle = {};
    if (track) widgetStyle.BackgroundImage = track;
    if (fill) widgetStyle.FillImage = fill;
    if (Object.keys(widgetStyle).length) props.WidgetStyle = widgetStyle;
    if (fillColor && fillColor[3] > 0) props.FillColorAndOpacity = fillColor;
    else if (accent) props.FillColorAndOpacity = accent;
    // Baked: the track and the (100%-wide) fill already carry the authored colour,
    // so the tint multiplier must stay white.
    const bakedParts = this.bakedFor(rec);
    if (bakedParts) {
      const bakedTrack = this.bakedBrush(bakedParts.track);
      const bakedFill = this.bakedBrush(bakedParts.fill);
      if (bakedTrack || bakedFill) {
        props.WidgetStyle = props.WidgetStyle || {};
        if (bakedTrack) props.WidgetStyle.BackgroundImage = bakedTrack;
        if (bakedFill) {
          props.WidgetStyle.FillImage = bakedFill;
          props.FillColorAndOpacity = [1, 1, 1, 1];
        }
      }
    }
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'progress' });
    return node;
  }

  buildCheckBox(rec, style, name, isRadio) {
    const node = this.makeNode(name, CLASS.CHECK_BOX, rec);
    const ctl = rec.control || {};
    const label = this.label(rec);
    const props = { CheckedState: rec.form && rec.form.checked ? 'Checked' : 'Unchecked' };
    const accent = ctl.accent ? V.colorToLinear(ctl.accent) : null;
    const radii = this.radiusOf(ctl.box);

    // Only emit a brush when the author's CSS actually paints something: a fully
    // transparent brush would erase the engine's default checkbox art.
    const unchecked = this.visualBrush(ctl.box, { label: `${label} unchecked` });
    const hover = ctl.states && ctl.states.hover
      ? this.visualBrush(ctl.states.hover, { label: `${label}:hover` })
      : null;
    let checked = ctl.states && ctl.states.checked
      ? this.visualBrush(ctl.states.checked, { label: `${label}:checked` })
      : null;
    if (!checked && ctl.before) {
      checked = this.visualBrush(ctl.before, { label: `${label}::before` });
    }
    if (!checked && accent) {
      checked = this.solidBrush(accent, radii);
      if (unchecked && unchecked.outlineWidth) {
        checked.outlineWidth = unchecked.outlineWidth;
        checked.outlineColor = unchecked.outlineColor;
      }
    }
    const checkedHover = ctl.states && ctl.states.checkedHover
      ? this.visualBrush(ctl.states.checkedHover, { label: `${label}:checked:hover` })
      : null;

    const widgetStyle = { CheckBoxType: 'CheckBox' };
    if (unchecked) widgetStyle.UncheckedImage = unchecked;
    if (hover) widgetStyle.UncheckedHoveredImage = hover;
    if (checked) widgetStyle.CheckedImage = checked;
    if (checkedHover || (checked && hover)) widgetStyle.CheckedHoveredImage = checkedHover || checked;
    // Baked: the real tick / fill the browser drew for each state.
    const bakedParts = this.bakedFor(rec);
    if (bakedParts) {
      const bakedUnchecked = this.bakedBrush(bakedParts.unchecked);
      const bakedHovered = this.bakedBrush(bakedParts.uncheckedHovered);
      const bakedChecked = this.bakedBrush(bakedParts.checked);
      const bakedCheckedHover = this.bakedBrush(bakedParts.checkedHovered);
      const cloneOf = (brush) => (brush ? JSON.parse(JSON.stringify(brush)) : null);
      if (bakedUnchecked) {
        widgetStyle.UncheckedImage = bakedUnchecked;
        // No separate pressed capture: pressed looks like the base state, but the
        // field must be filled or UMG falls back to its own art.
        widgetStyle.UncheckedHoveredImage = bakedHovered || cloneOf(bakedUnchecked);
        widgetStyle.UncheckedPressedImage = bakedHovered || cloneOf(bakedUnchecked);
      } else if (unchecked) {
        widgetStyle.UncheckedPressedImage = hover || unchecked;
      }
      if (bakedChecked) {
        widgetStyle.CheckedImage = bakedChecked;
        widgetStyle.CheckedHoveredImage = bakedCheckedHover || cloneOf(bakedChecked);
        widgetStyle.CheckedPressedImage = bakedCheckedHover || cloneOf(bakedChecked);
      } else if (checked) {
        widgetStyle.CheckedPressedImage = checkedHover || checked;
      }
    }
    // FCheckBoxStyle.ForegroundColor tints the caption; derive it from the authored
    // context (the probe inherits it) rather than the UA's field-text colour.
    const textColor =
      V.colorToLinear(ctl.inheritedColor) || this.colorOf(ctl.box) || this.colorOf(ctl.computed) || style.color;
    widgetStyle.ForegroundColor = textColor;
    if (accent) widgetStyle.CheckedForeground = accent;
    props.WidgetStyle = widgetStyle;
    if (isRadio) this.warn(`approximated: radio input '${label}' mapped to CheckBox`);
    if (!accent && !checked && !ctl.before) {
      this.warn(`note: checkbox '${label}' has no accent-color, ::before paint or :checked rule; only its box can be styled`);
    }
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'checkbox' });
    return node;
  }

  buildSlider(rec, style, name) {
    const node = this.makeNode(name, CLASS.SLIDER, rec);
    const ctl = rec.control || {};
    const label = this.label(rec);
    const form = rec.form || {};
    const props = {};
    const min = Number(form.min);
    const max = Number(form.max);
    const value = Number(form.value);
    // USlider keeps the raw value; MinValue/MaxValue define the range.
    if (Number.isFinite(min)) props.MinValue = min;
    if (Number.isFinite(max)) props.MaxValue = max;
    if (Number.isFinite(value)) props.Value = value;

    const accent = ctl.accent ? V.colorToLinear(ctl.accent) : null;
    const trackVisual = ctl.box;
    const track = this.visualBrush(trackVisual, { label: `${label} track`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    const radii = this.radiusOf(trackVisual);
    const barColor = (trackVisual && V.colorToLinear(trackVisual.backgroundColor)) || null;

    if (accent) props.SliderHandleColor = accent;
    if (barColor && barColor[3] > 0) props.SliderBarColor = barColor;
    const widgetStyle = {};
    if (track) widgetStyle.NormalBarImage = track;
    const hoverTrack = ctl.states && ctl.states.hover
      ? this.visualBrush(ctl.states.hover, { label: `${label}:hover`, allowEmpty: true })
      : null;
    if (hoverTrack) widgetStyle.HoveredBarImage = hoverTrack;
    if (accent) {
      // The thumb is drawn from the brush, so give it the accent as a solid disc.
      const thumbRadius = [radii[0] || 9, radii[1] || 9, radii[2] || 9, radii[3] || 9];
      widgetStyle.NormalThumbImage = this.solidBrush(accent, thumbRadius);
      widgetStyle.HoveredThumbImage = widgetStyle.NormalThumbImage;
    }
    if (style.fixedHeight !== null) widgetStyle.BarThickness = V.round(style.fixedHeight, 2);
    else if (rec.rect) widgetStyle.BarThickness = V.round(rec.rect[3], 2);
    // Baked: the real track and the real thumb silhouette.
    const bakedParts = this.bakedFor(rec);
    if (bakedParts) {
      const bakedTrack = this.bakedBrush(bakedParts.track);
      const bakedThumb = this.bakedBrush(bakedParts.thumb);
      if (bakedTrack) {
        widgetStyle.NormalBarImage = bakedTrack;
        widgetStyle.HoveredBarImage = bakedTrack;
        widgetStyle.DisabledBarImage = bakedTrack;
        if (bakedParts.track.designHeight) widgetStyle.BarThickness = V.round(bakedParts.track.designHeight, 2);
      }
      if (bakedThumb) {
        // imageSize is the thumb's own box (bakedBrush reads it from the part), so
        // UMG draws the thumb at thumb size instead of stretching it to the track.
        widgetStyle.NormalThumbImage = bakedThumb;
        widgetStyle.HoveredThumbImage = bakedThumb;
        widgetStyle.DisabledThumbImage = bakedThumb;
      }
    }
    if (Object.keys(widgetStyle).length) props.WidgetStyle = widgetStyle;
    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'slider' });
    return node;
  }

  // -------------------------------------------------------------- containers
  /**
   * Ordered children of a container: element records *and* bare text runs, so a
   * caption sitting next to an inline control survives as its own TextBlock.
   */
  childItems(rec) {
    const items = [];
    const runs = rec.runs && rec.runs.length ? rec.runs : (rec.k || []).map((_, index) => ({ r: index }));
    for (const run of runs) {
      if (typeof run === 'string') {
        if (run.trim()) items.push({ kind: 'text', text: run, leadingSpace: /^\s/.test(run) });
        continue;
      }
      const childRec = this.byIndex.get((rec.k || [])[run.r]);
      if (!childRec) continue;
      items.push({ kind: 'el', rec: childRec, style: this.readStyle(childRec) });
    }
    return items;
  }

  buildContainer(rec, style, kind, ctx, name) {
    const items = this.childItems(rec);
    // Text runs inherit their owner's typography: remember it on the item.
    for (const item of items) {
      if (item.kind === 'text') {
        item.parentRec = rec;
        item.parentStyle = style;
      }
    }
    const flow = [];
    const absolute = [];
    for (const item of items) {
      if (item.kind === 'text') flow.push(item);
      else if (item.style && item.style.isAbs) absolute.push(item);
      else flow.push(item);
    }

    const forceClass = (rec.ue || {}).class;
    if (forceClass) {
      const node = this.makeNode(name, forceClass, rec);
      node.children = this.mapChildren(flow.concat(absolute), ctx, null, name);
      this.meta.set(node, { rec, style, kind: 'custom' });
      return node;
    }

    if (absolute.length && flow.length) {
      // Flow children keep their flow container, absolutely positioned ones are
      // placed on a CanvasPanel sibling layer (CSS stacking inside one box).
      const canvas = this.makeNode(name, CLASS.CANVAS, rec);
      const flowNode = this.buildFlowContainer(rec, style, kind, flow, ctx, this.names.unique(`${name}_Flow`));
      const canvasChildren = [];
      if (flowNode) {
        const fmeta = this.meta.get(flowNode);
        if (fmeta) fmeta.isFlowGroup = true;
        // The flow group is a synthetic stand-in for the element's own box, not a
        // node derived from a DOM element: claiming a `source` would make tooling
        // compare it against the parent element's rect.
        delete flowNode.source;
        canvasChildren.push(flowNode);
      }
      canvasChildren.push.apply(canvasChildren, this.mapChildren(absolute, ctx, 'canvas', name));
      if (!canvasChildren.length) return null;
      canvas.children = canvasChildren;
      this.meta.set(canvas, { rec, style, kind: 'canvas' });
      return canvas;
    }

    if (absolute.length) {
      const canvas = this.makeNode(name, CLASS.CANVAS, rec);
      canvas.children = this.mapChildren(absolute, ctx, 'canvas', name);
      if (!canvas.children.length) return null;
      this.meta.set(canvas, { rec, style, kind: 'canvas' });
      return canvas;
    }

    return this.buildFlowContainer(rec, style, kind, flow, ctx, name);
  }

  buildFlowContainer(rec, style, kind, items, ctx, name) {
    let cls = CLASS.VERTICAL;
    let nodeKind = 'block';
    let orientation = 'v';

    if (kind === 'grid') {
      const tracks = style.gridColumns || [];
      const first = tracks.length ? tracks[0].px : undefined;
      const uniform =
        tracks.length >= 2 &&
        first !== undefined &&
        tracks.every((t) => t.px !== undefined && Math.abs(t.px - first) < 1);
      cls = uniform ? CLASS.UNIFORM_GRID : CLASS.GRID;
      nodeKind = uniform ? 'uniform-grid' : 'grid';
      orientation = 'grid';
    } else if (kind === 'flex') {
      if (style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse') {
        cls = CLASS.WRAP;
        nodeKind = 'wrap';
        orientation = 'w';
      } else if (style.flexDirection === 'column' || style.flexDirection === 'column-reverse') {
        cls = CLASS.VERTICAL;
        nodeKind = 'vbox';
        orientation = 'v';
      } else {
        cls = CLASS.HORIZONTAL;
        nodeKind = 'hbox';
        orientation = 'h';
      }
      if (style.flexDirection.endsWith('reverse')) {
        this.warn(`unsupported: flex-direction:${style.flexDirection} on '${this.label(rec)}' laid out forward`);
      }
    } else if (kind === 'canvas') {
      cls = CLASS.CANVAS;
      nodeKind = 'canvas';
      orientation = 'canvas';
    }
    // A block container whose children are all inline-level renders them on one
    // line (e.g. <label><input type=checkbox> Caption</label> where a higher
    // specificity rule forced display:block). HorizontalBox is the faithful
    // equivalent once the control breaks the text flow.
    if (cls === CLASS.VERTICAL && rec && rec.blockKids === 0 && rec.inlineKids > 0) {
      cls = CLASS.HORIZONTAL;
      nodeKind = 'inline-flow';
      orientation = 'h';
    }

    // justify-content: space-* is reproduced by folding the measured gaps into
    // each slot's padding (CSS has no UMG equivalent for space distribution).
    if (String(style.justify).indexOf('space') === 0 && (cls === CLASS.VERTICAL || cls === CLASS.HORIZONTAL)) {
      const allElements = items.every((item) => item.kind === 'el');
      style.measuredMainGaps = allElements
        ? this.measureMainGaps(items.map((item) => item.rec), cls === CLASS.VERTICAL)
        : null;
    }

    const children = this.mapChildren(items, ctx, orientation, name);
    // An empty container is noise in the Designer: only keep it if it carries
    // children. (Decorations still survive through their Border/SizeBox wrapper.)
    if (!children.length) return null;

    const node = this.makeNode(name, cls, rec);
    node.children = children;
    const properties = this.containerProperties(cls, style);
    if (properties) node.properties = properties;
    this.meta.set(node, { rec, style, kind: nodeKind });
    return node;
  }

  /** Leading main-axis gaps between consecutive children, from the snapshot. */
  measureMainGaps(childRecs, vertical) {
    const gaps = [0];
    for (let i = 1; i < childRecs.length; i += 1) {
      const prev = childRecs[i - 1].rect;
      const cur = childRecs[i].rect;
      const gap = vertical ? cur[1] - (prev[1] + prev[3]) : cur[0] - (prev[0] + prev[2]);
      gaps.push(Math.max(0, V.round(gap, 2)));
    }
    return gaps;
  }

  containerProperties(cls, style) {
    const props = {};
    if (cls === CLASS.UNIFORM_GRID) {
      const gx = V.round((style.columnGap || 0) / 2, 2);
      const gy = V.round((style.rowGap || 0) / 2, 2);
      if (gx || gy) props.SlotPadding = [gx, gy, gx, gy];
    } else if (cls === CLASS.WRAP) {
      props.InnerSlotPadding = [V.round(style.columnGap || 0, 2), V.round(style.rowGap || 0, 2)];
    } else if (cls === CLASS.GRID) {
      // TArray<float>: star tracks must stay proportional inside GridPanel.
      const fr = style.gridFrColumns || [];
      if (fr.length && fr.every((v) => v > 0)) props.ColumnFill = fr;
    }
    return Object.keys(props).length ? props : null;
  }

  mapChildren(items, ctx, orientation, ownerName) {
    // Only <body> is the root; descendants always inherit a parent container and
    // must never inherit the root's name hint.
    const childCtx = Object.assign({}, ctx, { isRoot: false, forceName: null, orientation: orientation || null });
    const out = [];
    let textIndex = 0;
    for (const item of items) {
      if (item.kind === 'text') {
        // A bare text run next to real children becomes its own TextBlock, in
        // document order, so captions are not swallowed by the container.
        const text = String(item.text || '').trim();
        if (!text) continue;
        textIndex += 1;
        const suffix = textIndex === 1 ? '_Text' : `_Text${textIndex}`;
        const generated = this.names.unique(`${ownerName || 'Text'}${suffix}`);
        const textNode = this.buildRunText(item.parentRec || null, item.parentStyle || null, ctx, text, generated);
        // Inline flow relied on a literal space to separate this run from the
        // widget before it; carry it over as a small leading padding.
        if (item.leadingSpace && item.parentStyle && out.length > 0) {
          const meta = this.meta.get(textNode);
          if (meta) meta.inlineSpace = V.round((item.parentStyle.fontSize || 14) * 0.26, 2);
        }
        out.push(textNode);
        continue;
      }
      const childNode = this.mapElement(item.rec, childCtx);
      if (childNode) out.push(childNode);
    }
    if (out.length > 1) {
      out.sort((a, b) => {
        const ma = this.meta.get(a) || {};
        const mb = this.meta.get(b) || {};
        const oa = (ma.style && ma.style.order) || 0;
        const ob = (mb.style && mb.style.order) || 0;
        return oa - ob;
      });
    }
    return out;
  }

  // ------------------------------------------------------------------- brush
  /**
   * Derive per-state button brushes from the :hover / :active / :disabled declarations the
   * snapshot kept. Only the properties a state actually declares are overridden, so a rule
   * that just darkens the background keeps the authored border and radius.
   */
  buttonStateBrushes(base, rec) {
    const states = (rec && rec.states) || null;
    if (!base || !states) return null;

    const apply = (decl) => {
      if (!decl) return null;
      const brush = JSON.parse(JSON.stringify(base));
      let touched = false;

      const bg = decl['background-color'] || decl['background'];
      if (bg) {
        const color = V.colorToLinear(bg);
        if (color) {
          brush.tint = color;
          touched = true;
        }
      }

      // CSSOM expands the `border-color` shorthand into four longhands when the rule is read
      // back, so accept either form. A Slate brush has a single outline anyway.
      const borderColor = decl['border-color'] || decl['border-top-color'];
      if (borderColor) {
        const color = V.colorToLinear(borderColor);
        if (color) {
          brush.outlineColor = color;
          touched = true;
        }
      }

      const borderWidth = decl['border-width'];
      if (borderWidth !== undefined) {
        const width = V.parsePx(borderWidth);
        if (width !== null && Number.isFinite(width)) {
          brush.outlineWidth = width;
          touched = true;
        }
      }

      const radius = decl['border-radius'];
      if (radius) {
        brush.cornerRadii = V.parseBorderRadius(radius);
        touched = true;
      }

      const opacity = decl['opacity'];
      if (opacity !== undefined) {
        const value = Number(opacity);
        if (Number.isFinite(value) && Array.isArray(brush.tint)) {
          brush.tint[3] = V.round(brush.tint[3] * V.clamp(value, 0, 1), 4);
          touched = true;
        }
      }

      return touched ? brush : null;
    };

    const out = {};
    const hovered = apply(states.hover);
    const pressed = apply(states.active);
    const disabled = apply(states.disabled);
    if (hovered) out.hovered = hovered;
    if (pressed) out.pressed = pressed;
    if (disabled) out.disabled = disabled;
    return Object.keys(out).length ? out : null;
  }

  borderBrush(style, rec, policy) {
    const brush = {};
    const radii = style.borderRadius.map((r) => V.round(r, 2));
    const hasRadius = radii.some((r) => r > 0);
    const texture = style.bgImage.urls.length
      ? this.assets && this.assets.addFromUrl(style.bgImage.urls[0], { label: `background-image on '${this.label(rec)}'` })
      : null;

    if (texture) {
      brush.drawAs = 'Image';
      brush.texture = `@${texture.key}`;
      brush.tiling = 'NoTile';
      if (style.bgSize.mode === 'cover' || style.bgSize.mode === 'contain') {
        this.warn(`approximated: background-size:${style.bgSize.mode} on '${this.label(rec)}' stretched to the box`);
      }
    } else {
      brush.drawAs = hasRadius ? 'RoundedBox' : 'Box';
    }
    if (hasRadius) brush.cornerRadii = radii;
    brush.tint = style.backgroundColor || [0, 0, 0, 0];

    // One Slate outline for four CSS sides: outlinePolicy reports the collapse.
    const effective = policy || this.outlinePolicy(this.sidesFromStyle(style), this.label(rec), 'border');
    if (effective.width > 0) {
      brush.outlineWidth = effective.width;
      brush.outlineColor = effective.color || style.borderColor;
    }
    return brush;
  }
}

// --------------------------------------------------------------- free helpers
/** <body> rarely has a name of its own: call it "Root" rather than "Body". */
function rootPreferredName(bodyRec) {
  const ue = (bodyRec && bodyRec.ue) || {};
  if (ue.name || bodyRec.id || (bodyRec.cls && bodyRec.cls.length)) return null;
  return 'Root';
}

function mapJustify(justify, vertical) {
  switch (justify) {
    case 'center':
      return 'Center';
    case 'flex-end':
    case 'end':
    case 'right':
      return vertical ? 'Bottom' : 'Right';
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return vertical ? 'Top' : 'Left';
    default:
      return vertical ? 'Top' : 'Left';
  }
}

function mapAlign(align, vertical) {
  switch (align) {
    case 'center':
      return 'Center';
    case 'flex-end':
    case 'end':
      return vertical ? 'Right' : 'Bottom';
    case 'flex-start':
    case 'start':
    case 'left':
      return vertical ? 'Left' : 'Top';
    default:
      return 'Fill';
  }
}

function mapJustifyText(align) {
  switch (align) {
    case 'center':
      return 'Center';
    case 'right':
    case 'end':
      return 'Right';
    default:
      return 'Left';
  }
}

function typefaceName(weight, italic) {
  const bold = weight >= 600;
  if (italic) return bold ? 'BoldItalic' : 'Italic';
  return bold ? 'Bold' : 'Regular';
}

function textSignature(rec) {
  const cs = rec.cs || {};
  return [cs.color, cs.fontSize, cs.fontWeight || '400', cs.fontStyle || 'normal', cs.textDecorationLine || 'none'].join('|');
}

/** "rgba(0,0,0,.5) 0px 2px 4px" -> {offset:[0,2], color:[...]} */
function parseTextShadow(value) {
  const text = String(value || '').trim();
  if (!text || text === 'none') return null;
  const first = V.splitTopLevel(text, ',')[0];
  const colorMatch = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(first);
  const numbers = (first.replace(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/g, ' ').match(/-?[\d.]+px/g) || []);
  const color = colorMatch ? V.colorToLinear(colorMatch[1]) : [0, 0, 0, 1];
  if (!color) return null;
  return {
    offset: [V.round(V.parsePx(numbers[0]) || 0, 1), V.round(V.parsePx(numbers[1]) || 0, 1)],
    color,
  };
}

module.exports = { Mapper, CLASS, BOX_SLOTS };
