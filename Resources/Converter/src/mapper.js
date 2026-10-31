// Copyright (c) 2026 FPVSkyline. MIT License.
// Mapper: DOM snapshot (src/snapshot.js) -> Html2UMG contract node tree.
// Rules live in Docs/Html2UMG_LayoutContract.md §6; field names come from that
// contract and from real UMG reflection names (see README "engine facts").
'use strict';

const path = require('path');
const V = require('./values');
const fontmetrics = require('./fontmetrics');
const { baseName, wantsVerbatim, NameRegistry, ROLE_SUFFIX } = require('./names');

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
  BACKGROUND_BLUR: 'BackgroundBlur',
  TEXT: 'TextBlock',
  IMAGE: 'Image',
  BUTTON: 'Button',
  EDITABLE: 'EditableTextBox',
  // <input type="number"> -> UMG SpinBox. It carries its own arrows and background as part of
  // FSpinBoxStyle, so the browser's UA spinner needs no baking; only the range, font, colour and
  // padding are taken from the design.
  SPIN_BOX: 'SpinBox',
  // UNamedSlot, authored with data-ue-named-slot="Body" inside a component page. Its own widget
  // name IS the slot name, which is what data-ue-slot on the consuming page matches against.
  NAMED_SLOT: 'NamedSlot',
  COMBO: 'ComboBoxString',
  PROGRESS: 'ProgressBar',
  CHECK_BOX: 'CheckBox',
  SLIDER: 'Slider',
  // The clamp stack synthesised by wrapScaleClamp(): a CanvasPanel + ScaleBox + SizeBox, all stock
  // panel that turns one percentage + a min/max clamp into a real run-time size. Emitted only by
  // --layout=responsive, see Docs/Html2UMG_RelativeSize.md.
  // Page container: children are mutually exclusive pages, i.e. a WidgetSwitcher.
  //
  // The name is semantic on purpose. Whether the project can use CommonUI's animated switcher is a
  // property of the project, not of the layout, so the importer makes that choice
  // (/Script/CommonUI.CommonAnimatedSwitcher when the plugin is enabled, /Script/UMG.WidgetSwitcher
  // otherwise) and the JSON stays portable.
  PAGE_SWITCHER: 'PageSwitcher',
};

/**
 * Any class name that behaves like a switcher: WidgetSwitcher and its CommonUI variants
 * (CommonAnimatedSwitcher, CommonActivatableWidgetSwitcher). Matched by name because a project may
 * spell one of these bare (data-ue-class) instead of using the semantic PageSwitcher.
 */
const SWITCHER_CLASS_RE = /Switcher$/;

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
  'text', 'image', 'button', 'textinput', 'spinbox', 'combobox', 'progress', 'checkbox', 'slider', 'placeholder',
  // classifyInput() emits the HTML input types, not the widget names: a range is
  // 'range' and a radio is 'radio'. Without them the element's name lands on the
  // decoration Border and the real Slider/CheckBox is emitted as '<name>_Content'.
  'range', 'radio',
]);

/**
 * Kinds whose widget style paints the element's own box (background, outline and
 * content inset). A wrapper Border around one of these paints the same box a
 * second time — the browser draws one frame, the widget would draw two — and
 * doubles the content padding (wrapper Border.Padding + the style's own padding).
 */
const SELF_BOX_KINDS = new Set([
  'button', 'combobox', 'textinput', 'checkbox', 'radio', 'range', 'slider', 'progress',
]);

/** Slate font sizes are points at 96 dpi; CSS font-size is px. */
const PX_PER_POINT = 96 / 72;
/** Slate's default line box for a font is ~1.2em; used to derive row padding. */
const LINE_BOX_FACTOR = 1.2;
/**
 * Segoe UI's metrics, used only when the font FILE could not be read (a data-URI webfont, a
 * .ttc, a family with no file on this machine). Feeding them through the same code path as a
 * parsed font keeps one formula instead of a second set of magic numbers.
 *
 * Why the two engines disagree, and why the old 1.0625 shortcut existed:
 *   Slate  FSlateFontRenderer::GetMaxHeight = round(FreeType face->height * ppem/upem), i.e. hhea
 *          ascender-descender+lineGap, rounded once to whole pixels. For 12px Segoe UI that is
 *          2724/2048*12 = 15.96 -> 16px, and UTextBlock's default ShadowOffset (1,1) added a
 *          further 1px -> 17px. 17/12 = 1.4167 was that number, not a font property.
 *   CSS    Chromium asks DirectWrite, which reports usWinAscent+usWinDescent plus hhea's lineGap,
 *          and keeps it fractional: 15.96px for the same 12px text.
 * Dividing one by the other is right for exactly one size of one font; see
 * Docs/Html2UMG_FontMetrics.md for the measured table across fonts.
 */
/** The two numbers the pre-per-font converter used for every font (kept for
 *  --line-height-model=legacy; see Docs/Html2UMG_FontMetrics.md §2.1 for where they came from). */
const LEGACY_SLATE_FACTOR = 1.4167; // round(1.3301*12)=16 plus the 1px ShadowOffset, over 12px
const LEGACY_CSS_NORMAL_FACTOR = 1.3333; // 16px line box for 12px Segoe UI in Chromium

const FALLBACK_FONT_METRICS = {
  file: '(built-in Segoe UI metrics)',
  upem: 2048,
  hhea: { ascender: 2210, descender: -514, lineGap: 0 },
  os2: { useTypoMetrics: false, winAscent: 2210, winDescent: 514, typoAscender: 1491, typoDescender: -431, typoLineGap: 269 },
};

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
    // Named slots get their name BEFORE anything else can take it.
    //
    // UMG widget names are subobject names under the WidgetTree, so two widgets called "Body" cannot
    // coexist - NewObject fails with "Cannot replace existing object of a different class" and the
    // editor dies. A decorative div called #body would claim "Body" first, so reserve every slot name
    // up front and let the ornament take "Body_1" instead. The slot's name is a public interface
    // (`data-ue-slot="Body"` on a consuming page); a border's name is not.
    for (const rec of this.snapshot.elements) {
      const slotName = rec && rec.ue ? rec.ue['named-slot'] : null;
      if (!slotName) continue;
      const clean = String(slotName).trim();
      if (!clean) continue;
      this._slotNames = this._slotNames || new Set();
      this._slotNames.add(clean);
      this.names.claim(clean);
    }
    this.meta = new Map();
    // node -> the element's OWN assigned name. Every role-suffixed companion is named
    // "<own base><role>" (never a parent's composed name), so this map is what keeps a
    // deep tree from accumulating "Item_1_Content_Content_Flow".
    this.nodeBase = new WeakMap();
    this.samples = new Map();
    // USlider cannot paint to the ends of its own box: SSlider::OnPaint draws the track
    // from HalfHandleSize.X to AllottedWidth - HalfHandleSize.X, so a 702px slider shows a
    // 687px bar inset by 7.5px each side. The overhang that puts the painted track back on
    // the CSS box is recorded per record index and applied as negative slot padding on the
    // SizeBox wrapper (boxSlot).
    this.sliderOverhang = new Map();
    this._buildSamples();
  }

  warn(message) {
    if (this._warned.has(message)) return;
    this._warned.add(message);
    this.warnings.push(message);
  }

  /**
   * A soft note that matters once but is not a defect ("this clamp is inactive at the design
   * size"). The mapper has no separate notes channel, so it uses the file's existing
   * `note:`-prefixed warning convention - visible in layout.warnings, and --strict makes the
   * caller decide whether that is a failure.
   */
  infoOnce(message) {
    this.warn(/^(note|info):/.test(message) ? message : `note: ${message}`);
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
      // Effects Slate has no direct model for. The mapper either bakes them (gradients)
      // or maps them onto a dedicated UMG widget (backdrop-filter -> BackgroundBlur).
      backdropFilter: cs.backdropFilter || 'none',
      boxShadow: cs.boxShadow || 'none',
      shadow: V.parseBoxShadow(cs.boxShadow),
      overflowX: cs.overflowX || 'visible',
      overflowY: cs.overflowY || 'visible',
      zIndex: cs.zIndex !== undefined ? Number(cs.zIndex) || 0 : 0,
      opacity: cs.opacity !== undefined ? Number(cs.opacity) : 1,
      // An inactive switcher page was laid out with visibility:hidden purely so it could be
      // measured; it is a real page and must be built, not skipped.
      visibility: rec.wasHidden ? 'visible' : cs.visibility || 'visible',
      // A grid track with a px size is the cell's width: UMG sizes a column from its content, so
      // without this a 148px track collapsed to the 83px the nav needed.
      fixedWidth: rec.h2uGridTrackWidth !== undefined ? rec.h2uGridTrackWidth : declPx('width'),
      fixedHeight:
        rec.h2uFlowHeight !== undefined
          ? rec.h2uFlowHeight
          : declPx('height'),
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

    // A table cell has no width of its own; the browser distributes the table's width over the
    // columns. UMG has no such pass, so the measured cell width is pinned. Without it every
    // cell sizes to its content and the columns do not line up between rows.
    if (cs.display === 'table-cell' && style.fixedWidth === null && rec.rect && rec.rect[2] >= 1) {
      style.fixedWidth = V.round(rec.rect[2], 2);
    }
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
      style.bgImage.urls.length > 0 ||
      // A gradient is painted too: without this an element whose only paint is a
      // gradient (e.g. the page background) got no Border and therefore drew nothing.
      style.bgImage.gradients.length > 0;
    style.hasPadding = style.padding.some((p) => p > 0);
    return style;
  }

  // ---------------------------------------------------------- unsupported CSS
  checkUnsupported(rec) {
    const cs = rec.cs || {};
    const label = this.label(rec);
    // A box-shadow is baked together with the element's own paint (see bake.js bakeShadow),
    // so it is only dropped when it cannot be mapped (an inset shadow, or no outer footprint).
    const parsedShadow = V.parseBoxShadow(cs.boxShadow);
    if (parsedShadow) {
      this.warn(`mapped: box-shadow on '${label}' baked into the element texture`);
    } else if (cs.boxShadow && cs.boxShadow !== 'none') {
      this.warn(`unsupported: box-shadow on '${label}' dropped (only outer shadows are mapped)`);
    }
    if (cs.filter) this.warn(`unsupported: filter on '${label}' dropped`);
    // backdrop-filter is mapped onto UBackgroundBlur (see the container builder), so it is
    // only unsupported when it is not a plain blur().
    if (cs.backdropFilter && cs.backdropFilter !== 'none' && this.blurStrength(cs.backdropFilter) <= 0) {
      this.warn(`unsupported: backdrop-filter: ${cs.backdropFilter} on '${label}' dropped (only blur() is mapped)`);
    }
    if (cs.transform) this.warn(`unsupported: transform on '${label}' dropped (layout uses the untransformed box)`);
    if (cs.mixBlendMode) this.warn(`unsupported: mix-blend-mode on '${label}' dropped`);
    if (cs.clipPath) this.warn(`unsupported: clip-path on '${label}' dropped`);
    if (cs.maskImage) this.warn(`unsupported: mask-image on '${label}' dropped`);
    // Gradients are no longer dropped: the bake pass rasterises them into a texture
    // (see bake.js bakePaint), so there is nothing to warn about here.
    const bg = V.parseBackgroundImage(cs.backgroundImage);
    if (bg.gradients.length > 1) {
      this.warn(`approximated: ${bg.gradients.length} stacked gradients on '${label}' baked as one paint`);
    }
    if (rec.pseudo && (rec.pseudo.before || rec.pseudo.after)) {
      this.warn(`unsupported: ::before/::after content on '${label}' dropped`);
    }
    if (cs.position === 'sticky') this.warn(`unsupported: position:sticky on '${label}' treated as static`);
    // overflow:hidden is mapped onto UMG's Clipping (see the border builder), so it is only worth
    // a note when the element has no box of its own to clip against.
    const hides = cs.overflowX === 'hidden' || cs.overflowY === 'hidden';
    if (hides && rec.tag !== 'svg' && rec.tag !== 'img') {
      this.warn(`mapped: overflow:hidden on '${label}' -> Clipping on its Border`);
    }
    if (cs.direction === 'rtl') this.warn(`unsupported: direction:rtl on '${label}' converted left-to-right`);
    if (rec.shadow) this.warn(`unsupported: shadow DOM inside '${label}' is not converted`);
  }

  /**
   * The element's OWN assigned name - also the base for every role-suffixed wrapper it
   * owns. Never a composed parent name: that is what used to grow "Content_Content_Flow".
   */
  ownBase(node) {
    if (!node) return 'Widget';
    return this.nodeBase.get(node) || node.name || 'Widget';
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
      // ScaleBox scales its child to the space it is given, using the child's
      // DESIRED size as the design extent. Wrapping <body> directly hands it the
      // body's content-driven size (for a fixed-size design that is the panel's
      // own box, not 1920x1080), so ScaleBox scaled the layout UP and the design
      // came out 27% wrong at its own size. The design extent has to be pinned
      // first: SizeBox(viewport) -> ScaleBox -> design.
      const viewport = (this.snapshot.viewport || this.snapshot.designViewport || {});
      const designW = Number(viewport.width) || 1920;
      const designH = Number(viewport.height) || 1080;
      const sizeName = this.names.unique(`${root.name}_DesignSize`);
      const size = {
        name: sizeName,
        class: CLASS.SIZE_BOX,
        source: 'cli:--scale-box',
        variable: false,
        properties: {
          WidthOverride: V.round(designW, 2),
          bOverride_WidthOverride: true,
          HeightOverride: V.round(designH, 2),
          bOverride_HeightOverride: true,
        },
        children: [root],
      };
      this.meta.set(size, { synthetic: true, style: null, rec: null, kind: 'sizebox' });
      const name = this.names.unique(`${root.name}_ScaleBox`);
      const wrapper = {
        name,
        class: CLASS.SCALE_BOX,
        source: 'cli:--scale-box',
        variable: false,
        properties: { Stretch: this.opts.scaleBox.stretch, StretchDirection: 'Both' },
        children: [size],
      };
      this.meta.set(wrapper, { synthetic: true, style: null, rec: null, kind: 'scalebox' });
      root = wrapper;
    }
    root = this.simplifyTree(root);
    this.assignSlots(root);
    // Only worth a line when the canvas rule actually fired somewhere: on a page with no such
    // parent the mechanism is inert and the note would just be noise (it also keeps those pages'
    // exact output byte-identical to the pre-change converter).
    if (this._canvasBaked && this._centerKept && this._centerKept.length) {
      const sample = this._centerKept.slice(0, 3).join("', '");
      this.infoOnce(
        `note: ${this._centerKept.length} element(s) stay cross-axis centred inside a fixed-size parent that is not the page canvas (e.g. '${sample}'); centring follows the widget's own size there and stays correct at any viewport`
      );
    }
    return root;
  }

  /**
   * Drop wrapper layers that cannot change a single pixel.
   *
   * The builder composes every element as SizeBox -> Border -> [ScrollBox] -> content plus role
   * wrappers. That is correct but produces chains nobody wants to edit, so these three rules remove
   * only layers whose contribution is provably zero - each one is checked against the geometry it
   * would otherwise express:
   *
   *   R1  a SizeBox inside a CanvasPanel slot: the slot's anchors + offsets already fix the rectangle
   *       and Slate ignores Width/HeightOverride there. Removed only when the override agrees with the
   *       measured rect within 1px, so the hoisted child recomputes an identical slot.
   *   R4  a SizeBox with no override at all: a pure container, equal to its parent's slot.
   *   R5  a Border that paints nothing (no brush, or a fully transparent tint) with no padding,
   *       no clipping and no slider overhang.
   *
   * Every rule additionally requires the node's name to END WITH A ROLE SUFFIX (_Box, _BG, _Padding's
   * _Pad, ...). Those names are the converter's own, so dropping them costs nothing; a name the author
   * wrote (data-ue-name / id / class) is a contract with the blueprint graph, and removing its widget
   * would silently break a binding. Measured over the 26 component pages: 115 layers removed, and the
   * only author-named ones the earlier, looser rule also hit were "BoxLeft" / "BoxRight".
   *
   * Deliberately NOT done: hoisting single-child Overlay/CanvasPanel/box wrappers in general. Container
   * and child come from different elements, so the child's slot would be recomputed from its own CSS
   * box instead of the container's - that changes geometry, not just structure.
   */
  simplifyTree(root) {
    if (this.opts.simplify === false) return root;
    const GENERATED_SUFFIXES = Object.values(ROLE_SUFFIX).filter(Boolean);
    const isGeneratedWrapper = (name) => GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix));
    const KEEP_KINDS = new Set(['relbox', 'pct-row', 'pct-spacer', 'widget-instance', 'scalebox']);
    let removed = 0;
    const reasons = { sizeboxInCanvas: 0, emptySizeBox: 0, transparentBorder: 0 };

    const overrideAgrees = (node) => {
      const props = node.properties || {};
      const rec = (this.meta.get(node) || {}).rec;
      const rect = rec && rec.rect ? rec.rect : null;
      if (!rect) return false;
      const dw = props.bOverride_WidthOverride ? Math.abs(Number(props.WidthOverride) - rect[2]) : 0;
      const dh = props.bOverride_HeightOverride ? Math.abs(Number(props.HeightOverride) - rect[3]) : 0;
      return dw <= 1 && dh <= 1;
    };

    /**
     * Keep the wrapper when its child is a rounded box whose corner is saturated:
     * `maxCornerRadius + outlineWidth >= half the box's smaller dimension`.
     *
     * Why this and not something simpler: hoisting a wrapper is only invisible when the child's
     * painted coverage does not depend on how its geometry was produced. It does for a rounded box
     * whose corner radius reaches the clamp - the coverage ramp of that corner then differs between
     * "the canvas allots it directly" and "an SBox clamps and re-hands the allotment".
     *
     * The rule is fitted to every wrapper we have A/B-tested (byte-for-byte render against
     * --no-simplify, geometry bit-identical in all cases):
     *
     *   MOVED  07-anchors  badge 168x36 r18 o1  (18+1 >= 18)   404 px, ring at the edge
     *   MOVED  02-absolute pill  222x42 r20 o1  (20+1 >= 21)   494 px, the pill itself
     *   MOVED  02-absolute dot    12x12 r 6 o0  ( 6+0 >=  6)    52 px, its 12x12 corner
     *   same   Chip 96x28 r6 o1, CenterBox 360x140 r10 o1, MaxBox 560x40 r8 o1,
     *          AltBadge 206x66 r6 o1, BottomBar 422x54 r8 o1, and every non-rounded brush
     *
     * One known over-conservative case: HalfBar 960x8 r4 o0 satisfies the test and is kept even
     * though removing it measured identical. Keeping a layer is the safe direction.
     */
    const cornerSaturated = (node) => {
      const brush = node && node.brush;
      if (!brush || brush.drawAs !== 'RoundedBox') return false;
      const radii = Array.isArray(brush.cornerRadii) ? brush.cornerRadii.map(Number) : [];
      if (!radii.length) return false;
      const meta = this.meta.get(node) || {};
      const rec = meta.rec || null;
      const rect = rec && rec.rect ? rec.rect : null;
      if (!rect) return false;
      const half = Math.min(Number(rect[2]), Number(rect[3])) / 2;
      if (!(half > 0)) return false;
      const outline = Number(brush.outlineWidth || 0);
      return Math.max(...radii) + outline >= half - 0.01;
    };

    const visit = (node, parent) => {
      if (!node) return null;
      if (node.children) {
        node.children = node.children.map((child) => visit(child, node)).filter(Boolean);
      }
      if (!parent) return node;

      const meta = this.meta.get(node) || {};
      if (KEEP_KINDS.has(meta.kind) || meta.isFlowGroup || meta.synthetic) return node;
      const children = node.children || [];
      const props = node.properties || {};
      // Only generated wrappers are disposable; an authored name is a binding contract.
      if (!isGeneratedWrapper(node.name || '')) return node;

      if (node.class === CLASS.SIZE_BOX && children.length === 1) {
        const hasOverride = !!(props.bOverride_WidthOverride || props.bOverride_HeightOverride);
        if (!cornerSaturated(children[0])) {
          if (parent.class === CLASS.CANVAS && hasOverride && overrideAgrees(node)) {
            removed += 1; reasons.sizeboxInCanvas += 1;
            return children[0];
          }
          const anyOverride = Object.keys(props).some((key) => key.startsWith('bOverride_') && props[key]);
          if (!anyOverride) {
            removed += 1; reasons.emptySizeBox += 1;
            return children[0];
          }
        }
      }

      if (node.class === CLASS.BORDER && children.length === 1) {
        const overhang = Number(meta.overhang || 0);
        const tint = node.brush && node.brush.tint ? Number(node.brush.tint[3]) : 1;
        const paintsNothing = tint <= 0.004;
        const padding = props.Padding;
        const noPadding = !padding || (Array.isArray(padding) && padding.every((v) => Math.abs(Number(v)) < 0.01));
        if (paintsNothing && noPadding && !props.Clipping && overhang === 0) {
          removed += 1; reasons.transparentBorder += 1;
          return children[0];
        }
      }

      return node;
    };

    root = visit(root, null);
    if (removed > 0) {
      const parts = [];
      if (reasons.sizeboxInCanvas) parts.push(reasons.sizeboxInCanvas + ' SizeBox in a canvas slot');
      if (reasons.emptySizeBox) parts.push(reasons.emptySizeBox + ' empty SizeBox');
      if (reasons.transparentBorder) parts.push(reasons.transparentBorder + ' transparent Border');
      this.infoOnce('note: simplified the widget tree - removed ' + removed + ' layer(s): ' + parts.join(', '));
    }
    return root;
  }

  assignSlots(parent) {
    const children = parent.children || [];
    if (!children.length) return;
    const pmeta = this.meta.get(parent) || {};
    // A switcher shows one page at a time, so its slots are plain Fill: a page is never sized by the
    // slot (WidgetSwitcherSlot has no size rule), only positioned.
    //
    // `data-ue-class="CommonAnimatedSwitcher"` (or any other switcher class a project names) is just
    // as much a switcher: the semantic PageSwitcher is only one spelling of it. Without this, a page
    // written with a bare class got its children treated as ordinary box children and every child
    // came out with no slot at all.
    const isSwitcher = parent.class === CLASS.PAGE_SWITCHER || SWITCHER_CLASS_RE.test(String(parent.class || ''));
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const cmeta = this.meta.get(child);
      if (isSwitcher) {
        child.slot = { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
      } else {
        const slot = this.makeSlot(parent, pmeta, child, cmeta, i, children.length);
        if (slot) child.slot = slot;
      }
      this.assignSlots(child);
    }
    if (isSwitcher) {
      // The page the browser was showing: the first child that was not display:none. The converter
      // measured the hidden pages by temporarily laying them out, and marked them as such.
      const activeIndex = children.findIndex((child) => {
        const meta = this.meta.get(child);
        const rec = meta && meta.rec;
        return !(rec && rec.wasHidden);
      });
      parent.properties = parent.properties || {};
      parent.properties.ActiveWidgetIndex = activeIndex >= 0 ? activeIndex : 0;
    }
  }

  /**
   * Cross-axis offset for a text widget inside a flex row, from the browser's own measurement.
   *
   * CSS positions a short item in a taller row by `align-items` (baseline / center / end). Slate's
   * box slots can only stretch the widget (Fill) or push it against one edge, so a baseline-aligned
   * unit label ends up at the top of the row: 03-dashboard's `.statUnit` renders 15px above where
   * the browser draws it. The browser already computed the right offset, so use it: VerticalAlign
   * Top plus that much top padding places the widget exactly where the browser had it, whatever
   * the row's alignment was.
   *
   * Returns `{ paddingTop }` or null when the situation does not apply.
   */
  crossAxisTextOffset(parent, pmeta, cmeta, slot) {
    const parentClass = parent && parent.class;
    if (parentClass !== CLASS.HORIZONTAL && parentClass !== CLASS.WRAP) return null;
    // Already centred by the slot (CSS `align-items: center` or the line-height centring path): the
    // widget is where it belongs, and adding a top padding on top of that would push it down again.
    // 05-controls' `Check_Text` labels are exactly this case (VAlign=Center already, offset 23/52/81
    // is the row's cumulative position, not a padding).
    if (slot && slot.VerticalAlignment === 'Center') return null;
    if (cmeta && cmeta.textVerticalCenter) return null;
    const rec = cmeta && cmeta.rec;
    const style = cmeta && cmeta.style;
    const pstyle = pmeta && pmeta.style;
    if (!rec || !rec.rect || !rec.prect || !style || !pstyle) return null;
    // The DOM parent must be the row this widget sits in. A `label.check` nested inside a flex
    // *column* has `prect` pointing at the column, so its "offset from the parent" is a cumulative
    // position (23/52/81 = one row stride apart) and applying it pushes the text down. Only a
    // horizontal parent makes the vertical offset an alignment.
    const parentDisplay = String(pstyle.display || 'block');
    const parentDirection = String(pstyle.flexDirection || 'row');
    const parentIsRow = (/flex|grid/.test(parentDisplay) && parentDirection === 'row') ||
      (/^inline/.test(parentDisplay) && !/flex|grid/.test(parentDisplay));
    if (!parentIsRow) return null;
    // `align-items: baseline` is the common case here and Slate cannot express it at all; the other
    // values are honoured by the slot already, but applying the measured offset reproduces them
    // exactly as well (it is what the browser did), so no alignment needs special-casing.
    const pad = pstyle.padding || [0, 0, 0, 0];
    const border = pstyle.borderWidth || [0, 0, 0, 0];
    const contentTop = rec.prect[1] + pad[1] + border[1];
    const contentHeight = rec.prect[3] - pad[1] - pad[3] - border[1] - border[3];
    const ownHeight = rec.rect[3];
    if (!(contentHeight > 0) || !(ownHeight > 0)) return null;
    // Only when the browser made the widget clearly shorter than its row's content box.
    if (ownHeight + 0.5 >= contentHeight) return null;
    // Single-line labels only. A multi-line block that happens to be shorter than its row is a
    // different situation (the element itself wraps), and its "offset" is usually the row's
    // cumulative position: 05-controls' Check_Text is a 42px two-line label, and treating its 23px
    // as padding pushed it 23px down (2.53% -> 4.77% on that page).
    const linePx = V.parsePx(style.lineHeight) || (style.fontSize > 0 ? style.fontSize * 1.35 : 0);
    if (linePx > 0 && ownHeight > linePx * 1.6) {
      this.warn(
        `text: '${this.label(rec)}' is ${V.round(ownHeight / linePx, 1)} line boxes tall (${V.round(ownHeight, 1)}px); multi-line text is aligned by its own box, offset not applied`
      );
      return null;
    }
    const offset = rec.rect[1] - contentTop;
    if (!Number.isFinite(offset)) return null;
    if (offset <= 0.01) return null; // already at the top: nothing to compensate
    if (offset > contentHeight - ownHeight + 0.5) return null; // not a sane offset, leave it alone
    // A cross-axis offset can never be a third of the row: that shape is a *cumulative* position
    // (a row wrapper that is taller than its text), not an alignment. Bail out and leave a trail.
    if (offset > contentHeight * 0.45) {
      this.warn(
        `text: '${this.label(rec)}' offset ${V.round(offset, 1)}px exceeds 45% of its row (${V.round(contentHeight, 1)}px); treated as cumulative position, slot left alone`
      );
      return null;
    }
    const lineBox = this.cssLineBoxPx(style, null, rec, null);
    if (lineBox > 0 && Math.abs(offset - (contentHeight - lineBox) / 2) > 2) {
      this.warn(
        `text: '${this.label(rec)}' is ${V.round(contentHeight - ownHeight, 1)}px shorter than its row and offset ${V.round(offset, 1)}px (not centred); slot uses the measured offset`
      );
    }
    return { paddingTop: V.round(offset, 2) };
  }

  /**
   * Centre a control's label inside its (taller) box.
   *
   * CSS centres a <button>'s text (UA default `align-items:center`), and authors do the same to a
   * plain element with `line-height == height`. Slate's TextBlock always paints from the TOP of its
   * geometry, and a control slot hands the label the whole content area, so the text ends up glued
   * to the top: the reference design's Apply/Cancel/Reset buttons drew their ink 11px above where
   * the browser has it (browser rows 819-831, UMG 808-820).
   *
   * Only the *vertical* alignment changes; horizontal centring stays Slate's Justification. Guards:
   * the label must be a single line (a paragraph would be pushed off-centre), the box must be
   * clearly taller than the line box (> 1.5x), and the parent must be a self-drawn control or the
   * element must use the `line-height == height` idiom. Table cells never take this path (their
   * parent is a Border, and that was already ruled out as a text-alignment problem).
   */
  controlLabelCentering(parent, pmeta, cmeta, slot) {
    if (!slot || !cmeta || cmeta.kind !== 'text') return false;
    if (slot.VerticalAlignment === 'Center' || cmeta.textVerticalCenter) return false;
    if (cmeta.textSingleLine === false) return false;
    const rec = cmeta.rec;
    const style = cmeta.style || {};
    if (!rec || !rec.rect) return false;
    const controlClasses = new Set([CLASS.BUTTON, CLASS.CHECKBOX, CLASS.RADIO, CLASS.EDITABLE, CLASS.COMBO]);
    const parentIsControl = !!(parent && controlClasses.has(parent.class));
    const pad = style.padding || [0, 0, 0, 0];
    const border = style.borderWidth || [0, 0, 0, 0];
    const contentHeight = rec.rect[3] - pad[1] - pad[3] - border[1] - border[3];
    const lineBox = cmeta.textLineBoxPx;
    if (!(contentHeight > 0) || !(lineBox > 0)) return false;
    const authored = V.parsePx(style.lineHeight);
    const lineHeightCentred = authored !== null && authored > 0 && Math.abs(authored - contentHeight) <= 2;
    if (!parentIsControl && !lineHeightCentred) return false;
    if (!(contentHeight > lineBox * 1.5)) return false;
    slot.VerticalAlignment = 'Center';
    return true;
  }

  makeSlot(parent, pmeta, child, cmeta, index, count) {
    const slot = this.rawSlot(parent, pmeta, child, cmeta, index, count);
    // CSS centres a single line with `line-height == box height`. UMG's TextBlock
    // has no vertical content alignment, so the *slot* has to centre the widget.
    // Only where that slot means "vertical position inside a box": for a box slot
    // (border/sizebox/…) or for a row's cross axis. On a VerticalBox the vertical
    // alignment is the flow axis, so applying it there would re-centre something
    // the flex layout already placed.
    // A text widget that the browser's flex row made *shorter* than the row is aligned by CSS
    // (baseline / center / end), and Slate's row slot can only stretch or push it to one edge.
    // Rather than guess the alignment, reuse the offset the browser itself produced: Top + that
    // padding reproduces baseline alignment exactly (03-dashboard's ".statRow/statUnit" unit sits
    // 15px below the row top because it is baseline-aligned with a 26px value, not centred).
    if (slot && cmeta && cmeta.kind === 'text' && Object.prototype.hasOwnProperty.call(slot, 'VerticalAlignment')) {
      // NOTE: the slot has to be passed in — the "already centred" guard reads its VerticalAlignment,
      // and without it a Centre slot was silently overwritten (06-native's Row_Text: Center -> Top+23).
      const crossStretchFix = this.crossAxisTextOffset(parent, pmeta, cmeta, slot);
      if (crossStretchFix) {
        slot.VerticalAlignment = 'Top';
        const pad = Array.isArray(slot.Padding) ? slot.Padding.slice() : [0, 0, 0, 0];
        pad[1] = crossStretchFix.paddingTop;
        slot.Padding = pad;
        return slot;
      }
    }
    // responsive: give a text widget the container's width instead of its measured width, so the
    // run-time allotted width is what decides the line breaks (no baked WrapTextAt).
    if (slot && cmeta && cmeta.kind === 'text' && this.responsiveMode() &&
        parent && parent.class === CLASS.VERTICAL &&
        Object.prototype.hasOwnProperty.call(slot, 'HorizontalAlignment')) {
      const style = cmeta.style || {};
      if (style.fixedWidth === null || style.fixedWidth === undefined) slot.HorizontalAlignment = 'Fill';
    }
    // A control's label (button / check / input) is centred by CSS; Slate paints from the top.
    if (slot && cmeta && Object.prototype.hasOwnProperty.call(slot, 'VerticalAlignment')) {
      if (this.controlLabelCentering(parent, pmeta, cmeta, slot)) return slot;
    }
    if (slot && cmeta && cmeta.textVerticalCenter && Object.prototype.hasOwnProperty.call(slot, 'VerticalAlignment')) {
      const parentClass = parent.class;
      const verticalIsCrossAxis = parentClass === CLASS.HORIZONTAL || parentClass === CLASS.WRAP;
      const isBoxSlot =
        parentClass === CLASS.BORDER ||
        parentClass === CLASS.SIZE_BOX ||
        parentClass === CLASS.SCROLL_BOX ||
        parentClass === CLASS.BUTTON ||
        parentClass === CLASS.BACKGROUND_BLUR ||
        parentClass === CLASS.OVERLAY;
      // An explicit cross-axis alignment in CSS wins over the line-height trick.
      const parentAlign = (pmeta && pmeta.style && pmeta.style.alignItems) || 'normal';
      const parentAlreadyAligns = parentAlign !== 'normal' && parentAlign !== 'stretch';
      if (isBoxSlot || (verticalIsCrossAxis && !parentAlreadyAligns)) {
        slot.VerticalAlignment = 'Center';
      }
    }
    // UMG's SizeBox clamps Min/MaxDesiredSize only while computing the *desired* size
    // (SBox.cpp:146-158); OnArrangeChildren (SBox.cpp:187+) hands the child its allotted geometry
    // untouched. A min/max-width element inside a Fill slot therefore ignores its clamp at run
    // time - worth one line rather than a silent difference from the browser.
    if (this.responsiveMode() && slot && slot.Size && cmeta && cmeta.style && cmeta.rec && cmeta.rec.rect) {
      const s = cmeta.style;
      const rec = cmeta.rec;
      // Which axis does this Fill slot stretch? boxSlot() only weights the MAIN axis, so a
      // VerticalBox Fill is a height and a HorizontalBox Fill is a width. The old check always
      // read the width clamp, which on a column tested the wrong axis.
      const parentMeta = this.meta.get(parent) || {};
      const verticalBox = parent && parent.class === CLASS.VERTICAL;
      const horizontalBox = parent && parent.class === CLASS.HORIZONTAL;
      const axes = [];
      if (verticalBox) axes.push({ key: 'height', isWidth: false });
      else if (horizontalBox) axes.push({ key: 'width', isWidth: true });
      else axes.push({ key: 'width', isWidth: true }, { key: 'height', isWidth: false });
      // When the child itself carries a clamp stack, the clamp is its job (it is exact at
    // run time), so the Fill slot must stay: dropping it would starve the box of the space it
    // measures.
    if (slot.Size.SizeRule === 'Fill' && parentMeta.kind !== 'relbox' && cmeta.kind !== 'relbox') {
        const pad = s.padding || [0, 0, 0, 0];
        const border = s.borderWidth || [0, 0, 0, 0];
        for (const axis of axes) {
          const prefix = axis.isWidth ? 'Width' : 'Height';
          const minKey = axis.isWidth ? 'minWidth' : 'minHeight';
          const maxKey = axis.isWidth ? 'maxWidth' : 'maxHeight';
          const hasMax = s[maxKey] !== null && s[maxKey] !== undefined && s[maxKey] > 0;
          const hasMin = s[minKey] !== null && s[minKey] !== undefined && s[minKey] > 0;
          // `min-width:0` is a no-op, not a 0px clamp ("no clamp" is how CSS reads it), and a 0px
          // `max-*` is a degenerate box no design has.
          const clamp = hasMax ? s[maxKey] : hasMin ? s[minKey] : null;
          if (clamp === null) continue;
          const clampName = hasMax ? maxKey : minKey;
          const i = axis.isWidth ? 0 : 1;
          const measured = rec.rect[i + 2] - pad[i] - pad[i + 2] - border[i] - border[i + 2];
          const active = Math.abs(measured - clamp) <= 1;
          if (active) {
            // The clamp is what the browser actually used, so it must survive into the game. UMG's
            // SizeBox only clamps the *desired* size (SBox.cpp:146-158; OnArrangeChildren hands over
            // the allotted geometry), so the widget has to sit in a desired-driven slot, not Fill.
            slot.Size = { SizeRule: 'Automatic' };
            this._clampKeeping = this._clampKeeping || [];
            this._clampKeeping.push(this.label(rec));
            this.warn(
              `layout: '${this.label(rec)}' is clamped by ${clampName.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} (${V.round(clamp, 1)}px) at the design size; dropped its Fill slot so the SizeBox clamp still applies at runtime`
            );
          } else {
            this._clampInactive = this._clampInactive || [];
            this._clampInactive.push(this.label(rec));
            this.infoOnce(
              `layout: ${clampName.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} on '${this.label(rec)}' is inactive at the design size (${V.round(measured, 1)}px vs ${V.round(clamp, 1)}px); its Fill slot will ignore the clamp at runtime`
            );
          }
          break; // one axis decides the slot: dropping Fill is all-or-nothing
        }
      }
    }
    return slot;
  }

  rawSlot(parent, pmeta, child, cmeta, index, count) {
    // Synthesised wrappers (the CanvasPanel + ScaleBox + SizeBox clamp stack) carry a slot the
    // builder composed on purpose; recomputing it from the element's measurement would turn the
    // percentage anchors into a fixed px pin and silently drop the clamp.
    if (cmeta && cmeta.keepSlot) return null;
    const orientation = BOX_SLOTS[parent.class];
    if (orientation) return this.boxSlot(pmeta, cmeta, index, orientation);
    switch (parent.class) {
      case CLASS.CANVAS:
        return this.canvasSlot(cmeta, pmeta);
      case CLASS.GRID:
        return this.gridSlot(pmeta, cmeta, index);
      case CLASS.UNIFORM_GRID:
        return this.uniformSlot(pmeta, index);
      case CLASS.BORDER:
      case CLASS.SIZE_BOX:
      case CLASS.SCROLL_BOX:
      case CLASS.BUTTON:
      case CLASS.OVERLAY:
        // A responsive-centred container records the alignment it wants for its single child;
        // everything else stays stretched.
        return (cmeta && cmeta.overlaySlot) || { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
      // UBackgroundBlurSlot carries the same alignment pair (it is a UContentWidget like
      // Border), so a blurred element's child gets the same single-child slot.
      case CLASS.BACKGROUND_BLUR:
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
  /**
   * The free space CSS puts *before* the first child of a flex container, in px.
   *
   * `justify-content: center / end / space-around / space-evenly` distributes the leftover space,
   * but Slate has no equivalent: a box slot's alignment only acts inside the width the child was
   * *allotted*, and an Automatic child is allotted exactly its desired width, so the leftover space
   * is silently dropped and every child ends up at the start. A real design hit this: the page body
   * is `display:flex; justify-content:center` around a 1240px panel, the browser puts it at x=340,
   * the widget at x=0 - the whole panel 340px to the left.
   *
   * The browser already measured the answer, so read it back: the first child's main-axis start
   * minus the parent's content-box start is exactly the leading space (it also covers
   * `space-around`/`space-evenly`, which `measureMainGaps()` leaves at 0 for the first child).
   * Later children follow from gap + Automatic sizing, so only index 0 needs it.
   *
   * Returns `{ extra, axis }` (extra = px still to add on top of the slot's current main padding)
   * or null. Guards: WrapBox/Grid never wrap this way; a flex-grow child fills the space itself;
   * a leading space of more than half the content box means the measurement is probably wrong.
   */
  justifyLeadingOffset(parent, pmeta, cmeta, index, orientation, slot) {
    if (orientation !== 'h' && orientation !== 'v') return null; // WrapBox has its own wrapping
    if (index !== 0) return null;
    const pstyle = (pmeta && pmeta.style) || {};
    const justify = String(pstyle.justify || 'normal');
    if (!/^(center|end|flex-end|right|space-around|space-evenly)$/.test(justify)) return null;
    if (slot && slot.Size && slot.Size.SizeRule === 'Fill') return null; // flex-grow fills it anyway
    const parentRec = pmeta && pmeta.rec;
    const rec = cmeta && cmeta.rec;
    if (!parentRec || !parentRec.rect || !rec || !rec.rect) return null;
    const vertical = orientation === 'v';
    const axis = vertical ? 1 : 0;
    const pad = pstyle.padding || [0, 0, 0, 0];
    const border = pstyle.borderWidth || [0, 0, 0, 0];
    const contentStart = parentRec.rect[axis] + pad[axis] + border[axis];
    const size = vertical
      ? parentRec.rect[3] - pad[1] - pad[3] - border[1] - border[3]
      : parentRec.rect[2] - pad[0] - pad[2] - border[0] - border[2];
    if (!(size > 0)) return null;
    const leading = rec.rect[axis] - contentStart;
    if (!Number.isFinite(leading) || leading <= 0.5) return null;
    // "leading > half the row" is what a *cumulative* offset looks like... but it is also exactly
    // what `justify-content: flex-end` does to a small child: the free space all ends up in front
    // of it. Tell the two apart by predicting the end-aligned position from the measured sizes;
    // a right-aligned switch (leading 338 of a 380px row, child 42 wide) is legitimate, while a
    // stray 120px inside a 200px row is not.
    const childSize = vertical ? rec.rect[3] : rec.rect[2];
    const endOffset = size - childSize;
    const endAligned = Math.abs(leading - endOffset) <= 2;
    if (!endAligned && leading > size * 0.5) {
      this.warn(
        `slot: '${this.label(rec)}' leading space ${V.round(leading, 1)}px is neither end-aligned (${V.round(endOffset, 1)}px) nor under half of its ${justify} parent (${V.round(size, 1)}px); not applied`
      );
      return null;
    }
    const already = (slot && Array.isArray(slot.Padding) ? slot.Padding[axis] : 0) || 0;
    const extra = V.round(leading - already, 2);
    return extra > 0.01 ? { extra, axis } : null;
  }

  /**
   * The parent's declared content-box extent on an axis, in px - or null when it is not fixed.
   *
   * Only a px declaration counts: `height:100%` / `auto` / a flex-grown parent really does
   * re-centre its children when the viewport changes, so `Center` stays correct there. A fixed px
   * parent keeps the browser's layout box whatever the window is (and clips), which is what
   * exact mode has to reproduce.
   */
  fixedContentExtent(pmeta, axis) {
    const decl = (pmeta && pmeta.rec && pmeta.rec.decl) || {};
    const px = V.parsePx(axis === 0 ? decl.width : decl.height);
    return px !== null && px > 0 ? px : null;
  }

  /**
   * Is this element the page canvas - the box that carries the design size instead of following
   * the window?
   *
   * Decided from the probe measurements, not by guessing: it has to cover the whole design
   * viewport AND keep that size at every probed viewport. <body> qualifies by definition. A
   * `height:100%` wrapper covers the viewport but shrinks with the probes, so its children really
   * do re-centre; a `height:38px` row never covers it.
   *
   * Only the canvas qualifies: its children are laid out against the design height, so a
   * cross-axis `Center` inside it would re-centre them against a window CSS never gave them.
   */
  designCanvasParent(pmeta) {
    const rec = pmeta && pmeta.rec;
    if (!rec || !rec.rect) return false;
    if (rec.tag === 'body') return true;
    const viewport = this.snapshot.viewport || this.snapshot.designViewport || {};
    const vw = Number(viewport.width) || 0;
    const vh = Number(viewport.height) || 0;
    if (!(vw > 0) || !(vh > 0)) return false;
    if (Math.abs(rec.rect[2] - vw) > 1 || Math.abs(rec.rect[3] - vh) > 1) return false;
    const series = this.samples.get(rec.i);
    if (!series) return true;
    return series.x.every((s) => Math.abs(s.size - rec.rect[2]) <= 1) &&
      series.y.every((s) => Math.abs(s.size - rec.rect[3]) <= 1);
  }

  /**
   * A child's measured cross-axis offset inside its parent's content box, in px, or null.
   *
   * Same idea as justifyLeadingOffset() but on the cross axis: reuse the position the browser
   * produced instead of the alignment keyword that would only reproduce it at one size.
   */
  crossAxisMeasuredOffset(pmeta, cmeta, axis, currentPadding) {
    const rec = cmeta && cmeta.rec;
    if (!rec || !rec.rect) return null;
    const prect = rec.prect || (pmeta && pmeta.rec && pmeta.rec.rect);
    if (!prect) return null;
    const pstyle = (pmeta && pmeta.style) || {};
    const pad = pstyle.padding || [0, 0, 0, 0];
    const border = pstyle.borderWidth || [0, 0, 0, 0];
    const contentStart = prect[axis] + pad[axis] + border[axis];
    const contentSize = prect[axis + 2] - pad[axis] - pad[axis + 2] - border[axis] - border[axis + 2];
    if (!(contentSize > 0)) return null;
    const own = rec.rect[axis + 2];
    const already = (currentPadding && currentPadding[axis]) || 0;
    const offset = rec.rect[axis] - contentStart - already;
    if (!Number.isFinite(offset) || offset <= 0.5) return null;
    // An offset larger than the free space is not an alignment (it would push the child past the
    // parent's far edge), so leave the slot alone.
    if (offset > Math.max(0, contentSize - own) + 1) return null;
    return V.round(offset, 2);
  }

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
      //
      // WrapBox is the exception: its gap is UWrapBox::InnerSlotPadding, which the panel itself
      // applies between items (see containerProperties). Emitting it here as well doubled every
      // card pitch - measured on 12-responsive: browser 476 = 460 + 16, UMG 492 = 460 + 32, so
      // four cards drifted 48px. One source only.
      const gapInSlot = orientation !== 'w';
      const mainGap = (gapInSlot && index > 0) ? (vertical ? pstyle.rowGap || 0 : pstyle.columnGap || 0) : 0;
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
    //
    // A spacer row's synthetic spacers carry their weight on the meta because their slot is
    // recomputed here, after wrapCrossAxisPercent() wrote it: without this the spacers came out
    // SizeRule=Automatic (0px wide) and the child took the whole row instead of N% of it.
    const forcedFill = (cmeta && cmeta.fillWeight > 0) ? cmeta.fillWeight : 0;
    const grow = forcedFill > 0 ? forcedFill : (style.flexGrow || 0);
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

    // Free space before the first child (justify-content: center/end/space-*), measured.
    // The slot's own alignment cannot express it - see justifyLeadingOffset().
    const leading = this.justifyLeadingOffset(null, pmeta, cmeta, index, orientation, out);
    if (leading) {
      out.Padding[leading.axis] = V.round((out.Padding[leading.axis] || 0) + leading.extra, 2);
    }

    const justify = pstyle.justify || 'normal';
    const alignItems = pstyle.alignItems || 'normal';
    const alignSelf = style.alignSelf || 'auto';
    const cross = alignSelf !== 'auto' ? alignSelf : alignItems;
    const mainAlign = mapJustify(justify, vertical);
    let crossAlign = mapAlign(cross, vertical);
    // CSS only stretches a child on the cross axis when the child has no size of its own
    // ('align-items: stretch' loses to an explicit width/height). Slate has no such rule: a
    // Fill slot allots the whole panel width, which SILENTLY OVERRIDES the SizeBox's
    // WidthOverride/HeightOverride, so a flow element with a fixed CSS size was stretched to
    // the full canvas. Use the start alignment instead - the SizeBox then reports the size
    // the design asked for, and still shrinks when the parent is narrower.
    // A synthetic node (spacer row) has no readStyle() style object, so test for a real number:
    // `undefined !== null` would make the spacer look like an explicitly sized child.
    const hasCrossSize = vertical
      ? style.fixedWidth !== null && style.fixedWidth !== undefined
      : style.fixedHeight !== null && style.fixedHeight !== undefined;
    const explicitOnCross = hasCrossSize;
    if (crossAlign === 'Fill' && explicitOnCross) {
      crossAlign = vertical ? 'Left' : 'Top';
    }
    // A synthetic wrapper that measures the space it is given has to BE given all of it: the
    // spacer row's Fill weights only mean "fraction of the parent" at the parent's full width, and
    // The clamp stack must see the whole extent of the axis it sizes. Its own centring is encoded
    // inside the wrapper (spacer weights / ContentHAlign), not in this slot.
    const wrapper = cmeta && cmeta.kind;
    if (wrapper === 'pct-spacer') crossAlign = 'Fill';
    if (wrapper === 'pct-row' && vertical) crossAlign = 'Fill';
    if (wrapper === 'relbox' && cmeta.rel) {
      const wantsW = !!(cmeta.rel.width && cmeta.rel.width.percent > 0);
      const wantsH = !!(cmeta.rel.height && cmeta.rel.height.percent > 0);
      if (vertical) {
        if (wantsW) crossAlign = 'Fill';
        if (wantsH) out.Size = { Value: 1, SizeRule: 'Fill' };
      } else {
        if (wantsH) crossAlign = 'Fill';
        if (wantsW) out.Size = { Value: 1, SizeRule: 'Fill' };
      }
      if ((vertical && wantsH) || (!vertical && wantsW)) {
        this.infoOnce(
          `layout: '${this.label(cmeta.rec)}' is sized by a relative function on the ${vertical ? 'column' : 'row'} main axis; its slot takes the remaining space so the box can measure it`
        );
      }
    }
    // --- exact: a fixed-size parent must not re-centre when the viewport changes --------------
    // CSS keeps laying out against the parent's declared extent. With `body{height:1080px}` and
    // `align-items:center` the panel is at y=204 whether the window is 1080 or 720 tall (at 720 it
    // is simply clipped). A cross-axis Center slot re-centres at run time instead: measured y=25
    // instead of 204 at 1280x720, 25.76% page diff (Docs/Html2UMG_Anchoring.md §1.4 explains the
    // same effect on the main axis). The browser already measured the offset, so bake it exactly
    // like justifyLeadingOffset() does - only when the parent declares a px extent on that axis.
    // Containers only: a text widget's own height follows the width it wraps at, so `Center`
    // keeps it centred when it re-wraps, while a baked offset would not (and crossAxisTextOffset()
    // already owns the text cases).
    if (!this.responsiveMode() && crossAlign === 'Center' && (!cmeta || cmeta.kind !== 'text')) {
      const axis = vertical ? 0 : 1;
      const fixed = this.fixedContentExtent(pmeta, axis);
      if (fixed !== null) {
        // ...but ONLY inside the page canvas. A row that declares `height:38px` keeps that height at
        // every resolution, so `Center` inside it already follows the widget's own size and stays
        // correct: baking the measured offset there changed 17 slots and cost 0.12% at the design
        // size (Slate's text height differs slightly from the browser's line box, and centring
        // absorbs that difference while a frozen number cannot).
        if (this.designCanvasParent(pmeta)) {
          const offset = this.crossAxisMeasuredOffset(pmeta, cmeta, axis, out.Padding);
          if (offset !== null) {
            out.Padding[axis] = V.round((out.Padding[axis] || 0) + offset, 2);
            crossAlign = vertical ? 'Left' : 'Top';
            this._canvasBaked = (this._canvasBaked || 0) + 1;
            this.warn(
              `mapped: '${this.label(cmeta && cmeta.rec)}' is centred on the cross axis of the page canvas (fixed ${vertical ? 'width' : 'height'} ${V.round(fixed, 1)}px); baked Padding.${['Left', 'Top'][axis]}=${V.round(offset, 1)} instead of ${vertical ? 'Horizontal' : 'Vertical'}Alignment=Center so it does not re-centre at another viewport size`
            );
          }
        } else if (cmeta && cmeta.rec) {
          this._centerKept = this._centerKept || [];
          this._centerKept.push(this.label(cmeta.rec));
        }
      }
    }
    // A Fill slot must ALSO say Fill on the main axis.
    //
    // Slate's box panels run a flex algorithm (SlateCore/LayoutUtils.h ArrangeChildrenInStack):
    // the slot's SizeRule decides the share, but the alignment decides the arranged size that
    // is actually handed to the child. A slot that is SizeRule=Fill with HorizontalAlignment=Left
    // therefore gets the distributed share *position* yet the child is arranged at its own
    // desired width - measured on 01-flex: two flex:2 / flex:1 columns came out 485px and 110px
    // wide where the browser has 1236px and 618px. Declaring the main axis Fill as well made the
    // render match the browser and dropped that page from 13.01% to 6.02%.
    const fillMain = out.Size && out.Size.SizeRule === 'Fill';
    // The leading padding already puts the child where the browser had it; centring or right-
    // aligning the slot *inside* the padded area would move it a second time.
    const mainFillAlign = fillMain ? 'Fill' : leading ? (vertical ? 'Top' : 'Left') : mainAlign;
    if (vertical) {
      out.HorizontalAlignment = crossAlign;
      out.VerticalAlignment = mainFillAlign;
    } else {
      out.HorizontalAlignment = mainFillAlign;
      out.VerticalAlignment = crossAlign;
    }
    // A text run that followed an inline widget carries its separating space, but
    // only when no explicit gap already separates them.
    const inlineSpace = (cmeta && cmeta.inlineSpace) || 0;
    if (inlineSpace && !usedMainGap) {
      out.Padding[vertical ? 1 : 0] = V.round(out.Padding[vertical ? 1 : 0] + inlineSpace, 2);
    }
    // Slider overhang (see the constructor): grow the slot by one thumb width so the track
    // SSlider insets by HalfHandleSize.X lands exactly on the CSS box instead of 7.5px in
    // from both ends. A negative FMargin is legal on a box slot and only pads outward.
    // box-shadow growth is cancelled on the slot so the element's FLOW footprint stays its CSS
    // box while the SizeBox/Border underneath is larger (and paints the shadow).
    const shadowGrowth = this.shadowExtentsOf(style);
    if (shadowGrowth) {
      for (let i = 0; i < 4; i += 1) {
        out.Padding[i] = V.round((out.Padding[i] || 0) - shadowGrowth[i], 2);
      }
    }

    const overhang = (cmeta && cmeta.overhang) || 0;
    if (overhang && vertical) {
      out.Padding[0] = V.round(out.Padding[0] - overhang, 2);
      out.Padding[2] = V.round(out.Padding[2] - overhang, 2);
    }
    return out;
  }

  canvasSlot(cmeta, pmeta) {
    const rec = cmeta && cmeta.rec;
    const style = (cmeta && cmeta.style) || null;

    if (cmeta && cmeta.isFlowGroup) {
      // The canvas spans the padding box (see canvasPad); the flow content belongs in the content
      // box, so re-apply the padding here instead of leaving the offsets at zero.
      const pad = (pmeta && pmeta.canvasPad) || [0, 0, 0, 0];
      return {
        LayoutData: {
          Anchors: { Minimum: [0, 0], Maximum: [1, 1] },
          Offsets: { Left: pad[0], Top: pad[1], Right: pad[2], Bottom: pad[3] },
          Alignment: [0, 0],
        },
        // UCanvasPanelSlot's reflected bool keeps its b-prefix (the UPROPERTY is
        // literally `bAutoSize`), so that is the key a reflection importer needs.
        bAutoSize: false,
      };
    }

    // The canvas now spans the parent's PADDING box (= border box minus border), so sample positions
    // (which are border-box relative) have to lose the border and the parent extent has to shrink by
    // it. With no border on the container this is a no-op, which is why most pages are unaffected.
    const samples = this.withCanvasBorder(rec ? this.samples.get(rec.i) : null, pmeta && pmeta.canvasBorder);
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
    // box-shadow: grow the placed rect outward. Point anchors carry the size in
    // Right/Bottom, stretched anchors carry margins there, so the two cases add differently.
    const shadowGrowth = this.shadowExtentsOf(style);
    if (shadowGrowth) {
      const pointX = xAxis.min === xAxis.max;
      const pointY = yAxis.min === yAxis.max;
      const offsets = slot.LayoutData.Offsets;
      offsets.Left = V.round(offsets.Left - shadowGrowth[0], 2);
      offsets.Top = V.round(offsets.Top - shadowGrowth[1], 2);
      offsets.Right = V.round(offsets.Right + (pointX ? shadowGrowth[0] + shadowGrowth[2] : shadowGrowth[2]), 2);
      offsets.Bottom = V.round(offsets.Bottom + (pointY ? shadowGrowth[1] + shadowGrowth[3] : shadowGrowth[3]), 2);
    }
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

    // 1. Opposing insets with an auto size: stretch between them - but only when the measurement
    //    confirms the element really fills that span.
    //
    //    A replaced element can beat left/right with its own intrinsic width: a <progress> keeps its
    //    default 160px, so the browser draws a 160px bar even though the CSS says left:0;right:0.
    //    Emitting a stretch anchor for it produced a canvas offset of parentWidth - 160 and a widget
    //    width of -1120 at 640, i.e. nothing drawn at all. When the measured box does not reach the
    //    far inset, fall through and pin it to the leading edge with its measured size instead.
    //    Compare sizes, not absolute edges: the sample's pos can be page-absolute while parentSize is
    //    the parent's extent, and mixing the two frames made a genuinely stretched overlay look
    //    unstretched. The span the insets imply is frame independent.
    const insetPx = (inset) => (inset ? (inset.kind === 'pct' ? inset.value * base.parentSize : inset.value) : 0);
    const impliedSpan = base.parentSize - insetPx(near) - insetPx(far);
    const stretchReachesFar = near && far && !hasDeclaredSize
      ? base.size >= impliedSpan - 2
      : false;
    if (stretchReachesFar) {
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
    // UMG's GridPanel has no gap. Half a gap on every side of every cell looks symmetric but is
    // wrong at the edges: on a two-column grid it pushed the first column 22px right and took 44px
    // off its width (measured: a 148px rail came out 83px wide and the second column started 43px
    // early). A gap only exists BETWEEN tracks, so it goes on the trailing edge of every cell
    // except the last one.
    const trackCount = Math.max(1, (pstyle.gridColumns || []).length);
    const gapRight = column < trackCount - 1 ? (pstyle.columnGap || 0) : 0;
    const gapBottom = (pstyle.rowGap || 0);
    return {
      Row: row,
      Column: column,
      RowSpan: 1,
      ColumnSpan: 1,
      Layer: 0,
      Padding: [
        V.round(margin[0], 2),
        V.round(margin[1], 2),
        V.round(margin[2] + gapRight, 2),
        V.round(margin[3] + gapBottom, 2),
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
    // --font-map=ignore (the default): never point a TextBlock at a project font asset. The
    // reference design maps "Cascadia Mono" / "Consolas" onto /Game/MenuSystem/... assets, which
    // is both a licensing question and a "this design only renders in that project" problem.
    // Ignoring the map lets the families resolve through @font-face / the system table instead.
    if (this.fontMapMode() === 'ignore') {
      this._ignoredFontMap = this._ignoredFontMap || [];
      const text = String(raw).trim();
      const entries = [];
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          for (const key of Object.keys(parsed)) entries.push([key, String(parsed[key])]);
        } catch (err) {
          entries.push([text.slice(0, 40), '(invalid JSON)']);
        }
      } else {
        for (const pair of text.split(/[;,]/)) {
          const eq = pair.indexOf('=');
          if (eq > 0) entries.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
        }
      }
      for (const [family, target] of entries) {
        this._ignoredFontMap.push({ family, target });
        // Deliberately no '/Game/...' in the message: an imported design must not carry a single
        // reference to the authoring project, and this line lands in layout.warnings.
        const assetName = String(target).split(/[./]/).filter(Boolean).pop() || target;
        this.warn(`font: ignoring data-ue-font-map "${family}" -> project asset ${assetName} (--font-map=ignore)`);
      }
      return inherited;
    }
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
  /**
   * The element's own widget name, honouring `data-ue-name-verbatim` (or the global --name-verbatim).
   *
   * A verbatim name that collides is the one case worth shouting about: UMG names must be unique, so
   * the second one silently becomes `Button_Left_1` - and the copied blueprint graph still binds
   * `Button_Left`, i.e. the binding breaks exactly the way the whole feature exists to prevent.
   */
  rootNameFor(rec, ctx) {
    const verbatim = wantsVerbatim(rec.ue || rec.dataUe || {}, { verbatim: this.opts.nameVerbatim === true });
    const base = ctx.forceName || baseName(rec, { verbatim });
    const finalName = this.names.unique(base);
    if (verbatim && finalName !== base) {
      this.warn(
        `error: duplicate widget name '${base}' (verbatim); the second one became '${finalName}' - any blueprint binding or variable referring to '${base}' will not match it`
      );
    }
    return finalName;
  }

  buildElement(rec, style, ctx) {
    const ue = rec.ue || {};

    // A declared slot inside a component page (data-ue-named-slot="Body") becomes a UNamedSlot whose
    // widget name is the slot name. No Border/SizeBox wrapper: UNamedSlot is a bare content host and
    // its layout belongs to whoever fills it.
    if (ue['named-slot']) {
      return this.buildNamedSlot(rec, style, ctx, String(ue['named-slot']).trim());
    }

    // Reuse of an already imported widget (contract §10): the element becomes one
    // instance node, its subtree is not expanded. An explicit data-ue-widget wins; otherwise a
    // component registry can claim the element by selector (class/tag/id/attribute).
    let widgetPath = this.widgetPathOf(ue);
    if (!widgetPath && !Object.prototype.hasOwnProperty.call(ue, 'inline')) {
      const registered = this.componentFor(rec, ue);
      if (registered) {
        widgetPath = registered.path;
        this.warn(
          `mapped: '${this.label(rec)}' matches component registry selector "${registered.selector}" -> ${registered.path} (data-ue-widget on the element or data-ue-inline would override this)`
        );
      }
    }
    if (widgetPath) {
      return this.buildWidgetInstance(rec, style, ctx, this.rootNameFor(rec, ctx), widgetPath);
    }
    if (ue.component) {
      this.warn(
        `note: data-ue-component="${ue.component}" on '${this.label(rec)}' is not in the component registry (pass --components <file>); expanded inline`
      );
    }
    const kind = this.classify(rec, style);
    if (kind === 'skip') return null;

    const wantsScroll = this.wantsScroll(style, kind, rec);
    // A leaf control's widget style already paints the element's whole box
    // (FButtonStyle, FComboBoxStyle, FEditableTextBoxStyle, FCheckBox images,
    // FSliderStyle bar, FProgressBar images). A wrapper Border around it would
    // paint the same background/outline a second time and would also apply the
    // CSS content padding twice (Border.Padding + the style's own padding).
    const selfPainted = SELF_BOX_KINDS.has(kind);
    const wantsBorder = !selfPainted && (style.hasVisualBox || style.hasPadding);
    // --layout=responsive: a size that only the runtime can resolve (min()/max()/clamp(), or a
    // percentage that carries a min/max clamp) becomes the clamp stack instead of a px pin.
    const relPlan = this.responsiveMode() ? this.relativeBoxPlan(rec, style, ctx.orientation) : null;
    const crossPercent = this.crossAxisPercentPx(rec, style, ctx.orientation, relPlan);
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
    // only the pure SizeBox wrapper is demoted to a `_Box` suffix.
    // rootName is the element's OWN base: children never derive their name from it.
    const rootName = this.rootNameFor(rec, ctx);
    const plan = [];
    if (wantsSize) plan.push('size');
    if (wantsBorder) plan.push('border');
    if (wantsScroll) plan.push('scroll');
    plan.push('content');
    const primaryKey = LEAF_KINDS.has(kind) ? 'content' : wantsBorder ? 'border' : wantsScroll ? 'scroll' : 'content';
    // One short role suffix per wrapper, all of them from names.js so the vocabulary is
    // identical across every design. "${rootName}<suffix>", never "<parent name><suffix>".
    const suffixFor = (key) => {
      if (key === 'size') return ROLE_SUFFIX.size;
      if (key === 'border') return style.hasVisualBox ? ROLE_SUFFIX.bg : ROLE_SUFFIX.pad;
      if (key === 'scroll') return ROLE_SUFFIX.scroll;
      return ROLE_SUFFIX.content;
    };
    const nodeName = {};
    for (const key of plan) {
      nodeName[key] = key === primaryKey ? rootName : this.names.unique(`${rootName}${suffixFor(key)}`);
    }

    let node = this.buildContent(rec, style, kind, ctx, nodeName.content, rootName);
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
      // Only a *positioned* box is the containing block of an absolutely positioned
      // descendant, so on a static element (e.g. <body>) the CSS padding/border must
      // not inset a CanvasPanel whose children carry viewport-absolute offsets —
      // insetting it translated the whole design by the padding.
      const staticCanvas = kind === 'canvas' && style.position === 'static';
      const shadowGrowth = this.shadowExtentsOf(style) || [0, 0, 0, 0];
      const inset = [0, 1, 2, 3].map((i) =>
        V.round(
          (staticCanvas ? 0 : (style.padding[i] || 0) + (style.borderWidth[i] || 0)) +
            (policy.extra[i] || 0) +
            shadowGrowth[i],
          2
        )
      );
      // A CanvasPanel must sit on the element's PADDING box: that is what CSS measures an absolutely
      // positioned child's insets against (border box minus border). So when this element hosts a
      // canvas, the Border must NOT consume the CSS padding - its content area IS the padding box -
      // and the flow group re-applies the padding as its own canvas-slot offsets (canvasPad).
      // Growing the canvas back out with negative slot padding is not an option: Slate clamps a
      // negative FMargin, so the canvas stayed on the content box and only the flow drifted +24/+18.
      const contentMeta = node ? this.meta.get(node) : null;
      const hostsCanvas = !!(contentMeta && contentMeta.kind === 'canvas' && style.position !== 'static');
      if (hostsCanvas) {
        contentMeta.canvasBorder = (style.borderWidth || [0, 0, 0, 0]).slice();
        const pad = inset.map((v, i) => V.round(v - (style.borderWidth[i] || 0), 2));
        if (pad.some((v) => v !== 0)) contentMeta.canvasPad = pad;
        const borderOnly = [0, 1, 2, 3].map((i) => V.round(style.borderWidth[i] || 0, 2));
        if (borderOnly.some((v) => v !== 0)) border.properties = { Padding: borderOnly };
      } else if (inset.some((v) => v !== 0)) {
        border.properties = { Padding: inset };
      }
      // overflow:hidden is a clip, and UMG can do it: Clipping on the widget that owns the bounds.
      // Without this a table inside a rounded panel, or any list inside a fixed-height card, spills
      // its children outside the box the design drew. auto/scroll already became a ScrollBox.
      const clips = (value) => value === 'hidden' || value === 'clip';
      if (clips(style.overflowX) || clips(style.overflowY)) {
        border.properties = border.properties || {};
        border.properties.Clipping = 'ClipToBounds';
      }
      if (node) border.children = [node];
      this.meta.set(border, { rec, style, kind: 'border' });
      node = border;
    }

    // backdrop-filter: blur(N) is exactly what UMG's BackgroundBlur widget does: it blurs
    // whatever is already painted behind it in the widget stack. It goes OUTSIDE the
    // element's own background (which is translucent) but inside the size box, so the
    // blur covers the designed box and the tinted panel is drawn on top of it.
    const blurStrength = this.blurStrength(style.backdropFilter);
    if (blurStrength > 0) {
      const blur = this.makeNode(this.names.unique(`${rootName}${ROLE_SUFFIX.blur}`), CLASS.BACKGROUND_BLUR, rec, true);
      blur.properties = { BlurStrength: blurStrength };
      if (node) blur.children = [node];
      this.meta.set(blur, { rec, style, kind: 'blur' });
      this.warn(`mapped: backdrop-filter: blur(${blurStrength}px) on '${this.label(rec)}' -> BackgroundBlur (runtime-only; the offscreen render cannot show it)`);
      node = blur;
    }

    if (wantsSize) {
      const box = this.makeNode(nodeName.size, CLASS.SIZE_BOX, rec, true);
      box.properties = this.sizeBoxProperties(style, crossPercent);
      // box-shadow: the painted footprint is bigger than the element. Grow the SizeBox and pull
      // the slot back with negative padding (see boxSlot), so the shadow has room to be drawn
      // while the element still occupies exactly its CSS box in the flow.
      const shadowExtents = this.shadowExtentsOf(style);
      if (shadowExtents) {
        const [left, top, right, bottom] = shadowExtents;
        // The design's measured box is a perfectly good size to grow from, so an element without
        // an explicit CSS width/height can still reserve room for its shadow.
        const measured = rec && rec.rect ? rec.rect : null;
        if (box.properties.bOverride_WidthOverride) {
          box.properties.WidthOverride = V.round(box.properties.WidthOverride + left + right, 2);
        } else if (measured && measured[2] >= 1) {
          box.properties.WidthOverride = V.round(measured[2] + left + right, 2);
          box.properties.bOverride_WidthOverride = true;
        } else {
          this.warn(`approximated: box-shadow on '${this.label(rec)}' has no measurable width, so the shadow is clipped horizontally`);
        }
        if (box.properties.bOverride_HeightOverride) {
          box.properties.HeightOverride = V.round(box.properties.HeightOverride + top + bottom, 2);
        } else if (measured && measured[3] >= 1) {
          box.properties.HeightOverride = V.round(measured[3] + top + bottom, 2);
          box.properties.bOverride_HeightOverride = true;
        } else {
          this.warn(`approximated: box-shadow on '${this.label(rec)}' has no measurable height, so the shadow is clipped vertically`);
        }
      }
      if (node) box.children = [node];
      this.meta.set(box, { rec, style, kind: 'sizebox', overhang: this.sliderOverhang.get(rec.i) || 0 });
      node = box;
    }

    // "Percentage with a px clamp" (`width:92%; max-width:1240px`, `min(1240px, 92vw)`) cannot be
    // expressed by a single UMG widget: a CanvasPanel slot hands out the percentage, and a SizeBox
    // clamps the DESIRED size only and passes the allotted geometry through unchanged (SBox.cpp
    // 146-158 vs 187+). Nesting the two the obvious way fixes nothing - measured, an inner
    // MaxDesiredWidth=1240 inside a 92% slot still came out 1766px wide at 1920.
    //
    // What does work, and needs no runtime widget:
    //
    //   CanvasPanel(anchors = the percentage band)
    //     ScaleBox(ScaleToFit, DownOnly)     <- shrinks only, never magnifies
    //       SizeBox(clamped px x design px)  <- the design size, clamped
    //         content
    //
    // Measured on a panel with width:92%; max-width:1240px: 1240 at 1920, 1177.6 at 1280,
    // 1240 at 2560 - the box is right at every width. The trade-off is that below the clamp the
    // content is scaled uniformly instead of being re-laid out (a browser re-wraps at 1177.6 with
    // unchanged type size), which costs about 7 points of pixel difference on a text-dense panel
    // at 1280. That is the price of not shipping a runtime module, and it is recorded here so the
    // next person does not have to re-measure it.
    if (relPlan && node) {
      node = this.wrapScaleClamp(rec, style, node, rootName, relPlan);
    }

    if (!node) return null;
    // Remember whose element this node belongs to: role-suffixed wrappers are named from
    // this base, so a nested container never leaks its own composed name downwards.
    this.nodeBase.set(node, rootName);
    if (style.opacity < 0.999) {
      node.properties = node.properties || {};
      node.properties.RenderOpacity = V.round(style.opacity, 3);
    }
    if (String((rec.ue || {}).variable || '').toLowerCase() === 'false') node.variable = false;
    return node;
  }

  // ------------------------------------------------------- relative size (responsive)
  /**
   * Reduce one axis of this element to `{ percent, minPx, maxPx }`, or null.
   *
   * Only three shapes need the runtime box, and they are the same shape:
   *   width:min(1240px, 92vw)      signed segmented min()
   *   width:clamp(320px, 50%, 900px)
   *   width:92%; max-width:1240px  the declarative spelling of min(1240px, 92%)
   * Everything else stays on the old paths (a plain percentage -> spacer row / Fill weight, a
   * plain px -> SizeBox), so nothing that already works changes representation.
   */
  relativeSizeOfAxis(rec, axis) {
    const decl = (rec && rec.decl) || {};
    const label = this.label(rec);
    const minName = axis === 'width' ? 'min-width' : 'min-height';
    const maxName = axis === 'width' ? 'max-width' : 'max-height';
    const raw = decl[axis];
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    if (!text || /^(auto|none|initial|unset|inherit|revert|fit-content|max-content|min-content)$/i.test(text)) {
      return null;
    }
    const parsed = V.parseRelativeSize(text);
    if (!parsed) {
      // A value we cannot reduce still has to be *reported*: silently falling back to the design
      // size is exactly the failure mode this task exists to remove.
      if (/^(min|max|clamp|calc|var|env)\s*\(/i.test(text)) {
        this.warn(
          `relative-size: ${text} at '${label}' falls back to the design-size branch (only min(px,%|vw), max(px,%|vw) and clamp(px,%,px) reduce to one box)`
        );
      }
      return null;
    }
    if (parsed.percent === null) {
      this.warn(
        `relative-size: ${text} at '${label}' is a constant ${V.round(parsed.px, 2)}px; the design-size branch is used for it`
      );
      return null;
    }
    if (!(parsed.percent > 0)) return null;
    const clampOf = (name) => {
      const value = decl[name];
      if (value === undefined || value === null) return null;
      const body = String(value).trim();
      if (!body || /^(auto|none)$/i.test(body)) return null;
      const px = V.parsePx(body);
      if (px !== null) return px;
      const rel = V.parseRelativeSize(body);
      if (rel && rel.px !== undefined) return rel.px;
      if (rel && rel.percent !== null) {
        this.warn(`relative-size: ${name} on '${label}' is itself a percentage (${body}); the percentage of '${axis}' wins and this clamp is dropped`);
        return null;
      }
      if (/^(min|max|clamp|calc|var|env)\s*\(/i.test(body)) {
        this.warn(`relative-size: ${name} on '${label}' (${body}) cannot be reduced to one px clamp; the design-size branch is used for it`);
      }
      return null;
    };
    const minPx = parsed.minPx !== null ? parsed.minPx : clampOf(minName);
    const maxPx = parsed.maxPx !== null ? parsed.maxPx : clampOf(maxName);
    if (parsed.unit && parsed.unit !== '%') {
      this.warn(
        `note: ${text} at '${label}' is ${Math.round(parsed.percent * 100)}% of the viewport (${parsed.unit}); the clamp stack measures the space it is given, so the two agree only while the parent spans the viewport`
      );
    }
    return {
      percent: parsed.percent,
      minPx: minPx !== null ? minPx : null,
      maxPx: maxPx !== null ? maxPx : null,
      expr: text,
      unit: parsed.unit || '%',
    };
  }

  /**
   * The axes that need the clamp stack, or null when neither does.
   *
   * A percentage that carries no clamp is NOT one of them: the cross axis is already continuous as
   * a spacer row and the main axis as a Fill weight, and both are cheaper than a runtime widget.
   */
  relativeBoxPlan(rec, style, orientation) {
    if (!rec) return null;
    const keeps = (axis) => !!(axis && axis.percent > 0 && (axis.minPx !== null || axis.maxPx !== null));
    /**
     * The clamp stack sizes its content from the space it is ALLOTTED, so it may only take an axis
     * where "allotted" means "the parent's extent on that axis":
     *   - the CROSS axis of a box panel: yes (the slot allots the panel's full cross size);
     *   - the MAIN axis of a box panel: NO. A Fill share is a fraction of the *remaining* space,
     *     not of the parent, so the box would apply the percentage to an already-divided share
     *     (41% of 41%). The existing Fill weight + SizeBox clamp stays there, which is the
     *     documented half-continuous case (Docs/Html2UMG_ResponsiveContract.md §1.2/§6.4);
     *   - a GridPanel cell, a SingleChild slot, the WBP root: yes (the cell/slot is the parent);
     *   - a CanvasPanel: no, axisPlacement() already expresses percentages as stretch anchors.
     */
    const allowed = (axis) => {
      if (orientation === 'v') return axis === 'width';
      if (orientation === 'h') return axis === 'height';
      if (orientation === 'w') return false;
      if (orientation === 'canvas') return false;
      return true;
    };
    const width = this.relativeSizeOfAxis(rec, 'width');
    const height = this.relativeSizeOfAxis(rec, 'height');
    const keepWidth = keeps(width) && allowed('width');
    const keepHeight = keeps(height) && allowed('height');
    if ((keeps(width) && !keepWidth) || (keeps(height) && !keepHeight)) {
      this.warn(
        `note: '${this.label(rec)}' has a clamped percentage on its container's main axis; it is left to the SizeBox clamp because a Fill share is not a fraction of the parent (see Docs/Html2UMG_RelativeSize.md §4)`
      );
    }
    const plan = { width: keepWidth ? width : null, height: keepHeight ? height : null };
    return plan.width || plan.height ? plan : null;
  }

  /**
   * Where the browser put the element across its parent's free space, as 0 / 0.5 / 1.
   *
   * The runtime box can only say "left / centre / right", so it has to be told which one the
   * design used; the measurement is the only source that knows (justify/align + auto margins +
   * absolute offsets all collapse into the same three outcomes).
   */
  contentAlignOf(rec, axis) {
    if (!rec || !rec.rect || !rec.prect) return 0;
    const prect = rec.prect;
    const parent = this.byIndex.get(rec.p);
    let start = prect[axis];
    let extent = prect[axis + 2];
    if (parent) {
      const cs = parent.cs || {};
      const near = axis === 0
        ? (V.parsePx(cs.paddingLeft) || 0) + (V.parsePx(cs.borderLeftWidth) || 0)
        : (V.parsePx(cs.paddingTop) || 0) + (V.parsePx(cs.borderTopWidth) || 0);
      const far = axis === 0
        ? (V.parsePx(cs.paddingRight) || 0) + (V.parsePx(cs.borderRightWidth) || 0)
        : (V.parsePx(cs.paddingBottom) || 0) + (V.parsePx(cs.borderBottomWidth) || 0);
      start += near;
      extent -= near + far;
    }
    const free = extent - rec.rect[axis + 2];
    if (!(free > 1)) return 0; // no room to align in
    const ratio = V.clamp((rec.rect[axis] - start) / free, 0, 1);
    if (ratio <= 0.2) return 0;
    if (ratio >= 0.8) return 1;
    return 0.5;
  }

  /**
   * CSS percentages on the *cross* axis of a box container have no UMG
   * equivalent (a box slot only weights the main axis), so they are pinned to the
   * measured size — never left as Automatic, which would collapse to zero.
   * Percentages on the main axis become Fill weights in boxSlot().
   */
  crossAxisPercentPx(rec, style, orientation, relPlan) {
    if (orientation !== 'v' && orientation !== 'h' && orientation !== 'w') return null;
    const out = {};
    const label = this.label(rec);
    const widthIsMain = orientation === 'h';
    const heightIsMain = orientation === 'v';
    // A column's cross axis is width, and responsive mode prefers a wrapper there (spacer row or
    // clamp stack). The pin is still emitted FIRST and only stripped by the wrapper that
    // actually replaces it: suppressing it up front is what silently dropped the width - when the
    // wrapper did not materialise the element kept neither a Fill weight nor a WidthOverride and
    // collapsed to its text width (probe: `width:60%` came out with only HeightOverride left).
    const deferred = this.responsiveMode() && orientation === 'v';
    if (style.percentWidth !== null && !widthIsMain && style.percentWidth < 0.995) {
      out.width = V.round(rec.rect[2], 2);
      if (!deferred && !(relPlan && relPlan.width)) {
        this.warn(
          `approximated: width:${Math.round(style.percentWidth * 100)}% on '${label}' pinned to ${out.width}px — UMG box slots have no cross-axis weight`
        );
      }
    }
    if (style.percentHeight !== null && !heightIsMain && style.percentHeight < 0.995) {
      out.height = V.round(rec.rect[3], 2);
      if (!(relPlan && relPlan.height)) {
        this.warn(
          `approximated: height:${Math.round(style.percentHeight * 100)}% on '${label}' pinned to ${out.height}px — UMG box slots have no cross-axis weight`
        );
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Express a column child's `width: N%` as a spacer row.
   *
   * A box slot only weights the MAIN axis, so a percentage on a column's width used to be pinned to
   * the measured pixels - correct at the design width and wrong at every other one (the fluid
   * reference page went 1.17% at 1920 and 9.56% at 1280 for exactly this reason). Slate's Fill
   * weights are proportional, so the same intent can be spelled as a HorizontalBox row:
   *
   *     [spacer Fill=left]  [child Fill=N%]  [spacer Fill=right]
   *
   * which reflows at any width and never depends on a desired size.
   */
  wrapCrossAxisPercent(child) {
    const meta = this.meta.get(child);
    const style = meta && meta.style;
    const rec = meta && meta.rec;
    const pct = style && style.percentWidth;
    if (!rec || !style || !(pct > 0.001) || pct >= 0.999) return null;
    // A percentage that carries a px clamp is wrapped by wrapScaleClamp() (CanvasPanel + ScaleBox +
    // SizeBox), not by a spacer row: a row would express the percentage and silently drop the clamp
    // (measured on a 1240px-capped 92% panel: 92% of 1920 = 1766 instead of 1240). The wrapper is
    // applied after the element is built, so skip the row here.
    if (style.maxWidth !== null || style.minWidth !== null) return null;
    if (!rec.rect || !rec.prect || !(rec.prect[2] > 0)) return null;
    const free = Math.max(0, 1 - pct);
    let left = free / 2; // CSS default is start-aligned; use the measured offset when it is clear
    const measuredLeft = (rec.rect[0] - rec.prect[0]) / rec.prect[2];
    if (Number.isFinite(measuredLeft)) {
      left = V.clamp(measuredLeft, 0, free);
    }
    const right = Math.max(0, free - left);
    // The row and its spacers belong to the CHILD element: name them from its own base
    // ("Item1_Row" with "Item1_L" / "Item1_R"), not from the child's composed node name.
    const childBase = this.ownBase(child);
    const wrapName = this.names.unique(`${childBase}${ROLE_SUFFIX.row}`);
    const spacer = (weight, side) => {
      if (!(weight > 0.0005)) return null;
      const node = this.makeNode(this.names.unique(`${childBase}${side}`), CLASS.SIZE_BOX, undefined);
      node.children = [];
      // No brush and no child: the spacer is pure weight. The weight ALSO lives on the meta
      // because boxSlot() recomputes this slot in assignSlots(), which used to overwrite the Fill
      // rule back to Automatic and collapse the spacer to 0px.
      node.slot = { Size: { SizeRule: 'Fill', Value: V.round(weight, 4) }, HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
      this.meta.set(node, { synthetic: true, style: null, rec: null, kind: 'pct-spacer', fillWeight: weight });
      return node;
    };
    const row = this.makeNode(wrapName, CLASS.HORIZONTAL, rec);
    // The row spans the PARENT's content width, not the element's own box, so claiming the
    // element as its `source` would make a geometry audit compare two different rects (same
    // reason the flow group drops it).
    delete row.source;
    row.children = [spacer(left, ROLE_SUFFIX.left), child, spacer(right, ROLE_SUFFIX.right)].filter(Boolean);
    child.slot = { Size: { SizeRule: 'Fill', Value: V.round(pct, 4) }, HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
    // The provisional px pin crossAxisPercentPx() emitted is dead weight now: the Fill weight is
    // what sizes the child, and a frozen WidthOverride inside a Fill slot is ignored by Slate
    // anyway. Removing it keeps the asset free of a design-size number.
    if (child.class === CLASS.SIZE_BOX && child.properties) {
      delete child.properties.WidthOverride;
      delete child.properties.bOverride_WidthOverride;
      if (!Object.keys(child.properties).length) delete child.properties;
    }
    this.meta.set(row, { rec, style, kind: 'pct-row' });
    this.warn(
      `mapped: width:${Math.round(pct * 100)}% on '${this.label(rec)}' expressed as a spacer row (Fill ${V.round(left, 3)} / ${V.round(pct, 3)} / ${V.round(right, 3)})`
    );
    return row;
  }

  /**
   * The spacer row could not be built, so the px pin crossAxisPercentPx() emitted stays.
   *
   * Say so out loud: a percentage that quietly turns into either nothing (the old bug - no Fill
   * weight, no WidthOverride, the element collapses to its text width) or an unexplained frozen
   * number is worse than an explained approximation.
   */
  pinCrossAxisPercent(child) {
    const meta = this.meta.get(child);
    const style = meta && meta.style;
    const rec = meta && meta.rec;
    if (!meta || meta.kind === 'relbox' || meta.kind === 'pct-row') return child;
    if (!style || style.percentWidth === null || style.percentWidth === undefined) return child;
    if (!(style.percentWidth > 0.001) || style.percentWidth >= 0.995) return child;
    if (!rec || !rec.rect) return child;
    this.warn(
      `approximated: width:${Math.round(style.percentWidth * 100)}% on '${this.label(rec)}' pinned to ${V.round(rec.rect[2], 2)}px — the spacer row needs a column child with a measurable parent width`
    );
    return child;
  }

  /**
   * A declared slot inside a component page: `<div data-ue-named-slot="Body">…</div>`.
   *
   * UNamedSlot's slot name IS its widget name, which is what `data-ue-slot="Body"` on a consuming
   * page resolves against (the importer walks INamedSlotInterface). Its children are ordinary
   * mapping output - whatever the page puts in the slot.
   */
  buildNamedSlot(rec, style, ctx, slotName) {
    if (!slotName) {
      this.warn(`error: data-ue-named-slot on '${this.label(rec)}' is empty; the element is expanded as a plain container`);
      return this.buildContainer(rec, style, 'container', ctx, this.rootNameFor(rec, ctx), null);
    }
    // A slot is an interface, not a label: keep the author's name verbatim even if a decorative
    // widget already took it (see NameRegistry.claim).
    const node = this.makeNode(this.names.claim(slotName), CLASS.NAMED_SLOT, rec, true);
    const children = [];
    for (const item of this.childItems(rec)) {
      if (item.kind !== 'el') {
        if (item.kind === 'text' && String(item.text || '').trim()) {
          this.warn(`note: bare text inside a named slot '${slotName}' is ignored; wrap it in an element`);
        }
        continue;
      }
      const childNode = this.mapElement(item.rec, Object.assign({}, ctx, { isRoot: false, forceName: null }));
      if (childNode) children.push(childNode);
    }
    if (!children.length) {
      this.warn(
        `note: named slot '${slotName}' has no children at design time; a UMG NamedSlot can still be filled at run time, this only means the preview is empty`
      );
    } else {
      // UNamedSlot is a content widget: exactly one child. Extra children cannot be expressed, and
      // silently keeping the first would hide the author's mistake.
      if (children.length > 1) {
        this.warn(
          `note: named slot '${slotName}' holds ${children.length} children; UNamedSlot takes ONE. They are wrapped in a VerticalBox so nothing is lost`
        );
        const box = {
          class: CLASS.VERTICAL,
          name: this.names.unique(`${slotName}Stack`),
          properties: {},
          children,
        };
        node.children = [box];
      } else {
        node.children = children;
      }
    }
    this.meta.set(node, { rec, style, kind: 'namedslot' });
    this.nodeBase.set(node, slotName);
    return node;
  }

  /**
   * Component registry lookup (\`--components registry.json\`).
   *
   * File shape:
   *   { "components": [ { "name": "panel-card", "match": ".card, [data-kind=card]",
   *                       "blueprint": "/Game/UI/WBP_PanelCard" } ] }
   *
   * `match` is a comma-separated list of COMPOUND selectors (tag, .class, #id, [attr],
   * [attr=value] - combinators are not evaluated). `name` lets the page ask for a component
   * explicitly with \`data-ue-component="panel-card"\`, which is checked first.
   */
  componentFor(rec, ue) {
    const registry = this.componentRegistry();
    if (!registry.length) return null;
    const wanted = ue && ue.component ? String(ue.component).trim() : '';
    if (wanted) {
      const byName = registry.find((entry) => entry.name === wanted);
      if (byName) return { path: byName.blueprint, selector: `data-ue-component="${wanted}"` };
    }
    for (const entry of registry) {
      for (const selector of entry.selectors) {
        if (this.matchesSelector(rec, selector)) {
          return { path: entry.blueprint, selector };
        }
      }
    }
    return null;
  }

  /** Lazily normalise the registry option into [{name, blueprint, selectors}]. */
  componentRegistry() {
    if (this._registry) return this._registry;
    const raw = this.opts.components;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.components)) list = raw.components;
    else if (raw && typeof raw === 'object') {
      // Terse form: { ".card": "/Game/UI/WBP_Card" }
      list = Object.keys(raw).map((key) => ({ match: key, blueprint: raw[key] }));
    }
    this._registry = list
      .map((entry) => ({
        name: entry && entry.name ? String(entry.name).trim() : '',
        blueprint: entry && entry.blueprint ? String(entry.blueprint).trim() : '',
        selectors: entry && entry.match
          ? String(entry.match).split(',').map((part) => part.trim()).filter(Boolean)
          : [],
      }))
      .filter((entry) => entry.blueprint && entry.selectors.length);
    if (this._registry.length) {
      this.infoOnce(
        `note: component registry has ${this._registry.length} entry(ies); matching elements become widget instances (data-ue-inline opts one out)`
      );
    }
    return this._registry;
  }

  /** Compound-selector match: tag, .class, #id, [attr], [attr=value]. No combinators. */
  matchesSelector(rec, selector) {
    if (!rec || !selector) return false;
    const text = String(selector).trim();
    if (!text || text === '*') return true;
    const classes = rec.cls || [];
    const attrs = rec.attr || {};
    const ue = rec.ue || {};
    const tokens = text.match(/[.#]?[\w-]+|\[[^\]]+\]|\*/g);
    if (!tokens) return false;
    for (const token of tokens) {
      if (token === '*') continue;
      if (token[0] === '.') {
        if (!classes.includes(token.slice(1))) return false;
        continue;
      }
      if (token[0] === '#') {
        if (rec.id !== token.slice(1)) return false;
        continue;
      }
      if (token[0] === '[') {
        const body = token.slice(1, -1);
        const eq = body.indexOf('=');
        if (eq < 0) {
          const key = body.trim();
          const value = attrs[key] !== undefined ? attrs[key] : ue[key.replace(/^data-ue-/, '')];
          if (value === undefined) return false;
          continue;
        }
        const key = body.slice(0, eq).trim();
        const expected = body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        const actual = attrs[key] !== undefined ? attrs[key] : ue[key.replace(/^data-ue-/, '')];
        if (actual === undefined || String(actual) !== expected) return false;
        continue;
      }
      if (String(rec.tag || '').toLowerCase() !== token.toLowerCase()) return false;
    }
    return true;
  }

  /**
   * `data-ue-widget`, or `data-ue-class` holding an asset path. Null when inlining. */
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
    this.nodeBase.set(node, name);
    if (style && (style.fixedWidth !== null || style.fixedHeight !== null)) {
      const box = {
        name: this.names.unique(`${name}${ROLE_SUFFIX.size}`),
        class: CLASS.SIZE_BOX,
        source: this.label(rec),
        variable: false,
        properties: this.sizeBoxProperties(style, null),
        children: [node],
      };
      this.meta.set(box, { rec, style, kind: 'sizebox' });
      this.nodeBase.set(box, name);
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

  wantsScroll(style, kind, rec) {
    if (kind === 'text' || kind === 'image') return false;
    // A <textarea> is mapped to a MULTILINE UEditableTextBox, and SMultiLineEditableTextBox
    // scrolls its own text. Wrapping it in a ScrollBox is worse than redundant: SScrollBox
    // arranges children at their DESIRED height (it has no stretch), so the multiline box
    // painted only its one-line height (38px) inside the 76px viewport the design declares.
    if (rec && rec.tag === 'textarea') return false;
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
    // A table is a column of rows, but a ROW is a horizontal line of cells. Left
    // unhandled, <tr> fell through to the block path and stacked its cells vertically,
    // which made every table ten times too tall.
    if (style.display === 'table-row') return 'tablerow';
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
      case 'number':
        // A number field is a spinner in the browser too, so it becomes a real SpinBox rather than
        // an edit box that cannot step. min/max/step come from the element's attributes.
        return 'spinbox';
      case 'password':
      case 'email':
      case 'search':
      case 'tel':
      case 'url':
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

  buildText(rec, style, ctx, name, base) {
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
    const fontProps = this.fontProperties(textRec, textStyle, ctx.fontMap, text);
    // "What the browser did not wrap, do not wrap."
    //
    // A short CJK label (the nav's 图形 / 音频 ...) is one line in the browser and its box is
    // content-driven, but with AutoWrapText + AllowPerCharacterWrapping + an Automatic slot width
    // it folds one character per line the moment Slate's allotted width is a fraction narrower
    // than its own measurement - which is exactly what the UMG designer shows. Turning wrapping
    // off for that shape is structural (it cannot fold at any preview size) instead of tuning a
    // tolerance. Block text that really wraps keeps AutoWrapText + WrapTextAt (see wrapTextAt()).
    // No second condition on purpose: the earlier "content-driven width" requirement missed the
    // nav's 16px `nav-idx` SizeBox (its width comes from the box, not the text), and "01" still
    // folded into two lines as soon as the allotted width was a fraction narrow.
    const browserLines = this.textLineCount(rec, style, fontProps, text);
    const noWrapByDesign = browserLines === 1;
    const autoWrap = !/^nowrap/.test(style.whiteSpace) && !noWrapByDesign;
    const props = {
      Text: text,
      Font: fontProps,
      ColorAndOpacity: textStyle.color,
      Justification: mapJustifyText(style.textAlign),
      AutoWrapText: autoWrap,
    };
    // UTextBlock's default ShadowOffset is (1,1) with a transparent colour, and
    // FSlateTextRun::GetMaxHeight adds |ShadowOffset.Y| to every line box whether the shadow is
    // visible or not. Clearing it makes the line box the font's own metric again, which is what
    // CSS 'line-height: normal' measures (and it puts the baseline back where the browser has it).
    // legacy/default models keep the engine default and count the pixel in the line box instead.
    const shadow = parseTextShadow(textStyle.textShadow);
    const keepShadow = this.keepUmgShadow(shadow);
    if (!keepShadow) props.ShadowOffset = shadow ? shadow.offset : [0, 0];
    if (shadow) props.ShadowColorAndOpacity = shadow.color;
    const shadowY = shadow ? Math.abs(shadow.offset[1] || 0) : keepShadow ? 1 : 0;
    // The width Slate may wrap at. AutoWrapText alone never wraps here: these text blocks sit in
    // absolute CanvasPanel slots, so desired size never sees a bounded width, and UMG only binds
    // WrapTextAt when it is non-zero. See wrapTextAt().
    if (autoWrap) {
      // responsive: no baked wrap width - the run-time allotted width decides, so the text
      // reflows inside the game instead of being frozen at the design width.
      // Responsive mode never bakes a wrap width: STextBlock re-wraps at the allotted width during
      // paint and invalidates layout when the measured height changes, so plain AutoWrapText settles
      // on the second frame. Only exact mode bakes, because it wants the design-size lines frozen.
      const wrapWidth = this.responsiveMode() ? 0 : this.wrapTextAt(rec, style, fontProps, text);
      if (wrapWidth > 0) props.WrapTextAt = wrapWidth;
      // A space-less CJK run has no break point Slate's line breaker will use, so allow the
      // per-character fallback. Latin text is unaffected unless a single word is wider than the box.
      if (this.cjkBreakMode() !== 'none') props.WrappingPolicy = 'AllowPerCharacterWrapping';
    }
    // `line-height` means two different things and they must not be mixed:
    //   * line-height == box height on a single line -> the author wanted vertical
    //     centring; UMG cannot centre inside a TextBlock, so the slot does it.
    //   * otherwise it is line spacing -> TextBlock.LineHeightPercentage.
    // Both cases still need the value: without it a 24px line box in a 24px design row renders
    // as Slate's natural 21px box, which is the "16px title 24 -> 22" the geometry dump found.
    const lineHeightPx = V.parsePx(textStyle.lineHeight);
    const verticalPadding = (style.padding ? style.padding[1] + style.padding[3] : 0);
    const boxHeight = rec && rec.rect ? rec.rect[3] - verticalPadding : 0;
    const singleLine = text.indexOf('\n') < 0;
    const fillsBox = lineHeightPx !== null && boxHeight > 1 && lineHeightPx >= boxHeight * 0.9;
    // Only a genuinely single-run leaf text: a paragraph with inline children is a
    // wrapping block whose box the line-height did not fill.
    const centreSingleLine = singleLine && fillsBox && rec.elemKids === 0;
    // Always emitted, not only for an explicit line-height: the default deserves the correction
    // too, because the two engines round the font's line box differently per font.
    const percentage = this.lineHeightPercentage(textStyle, fontProps, shadowY, rec, text);
    if (percentage !== null) props.LineHeightPercentage = percentage;
    if (style.textDecoration.indexOf('underline') >= 0) {
      this.warn(`unsupported: text-decoration:underline on '${this.label(rec)}' dropped`);
    }
    if (style.textOverflow === 'ellipsis') props.TextOverflowPolicy = 'Ellipsis';
    node.properties = props;
    this.meta.set(node, {
      rec,
      style,
      kind: 'text',
      textVerticalCenter: centreSingleLine,
      textSingleLine: singleLine,
      textLineBoxPx: this.cssLineBoxPx(textStyle, fontProps, rec, text),
      autoWrap,
    });
    // Wrapping needs no helper widget: STextBlock re-measures at the width it is arranged in during
    // paint and invalidates layout when the line count changed, so plain AutoWrapText settles on the
    // second frame (measured: 17px on pass 1, 51px on pass 2, identical to an explicit WrapTextAt).
    return node;
  }

  /**
   * Build the native stand-in for "percentage with a px clamp".
   *
   * See the comment at the call site for the measurements. Shape: CanvasPanel(percentage anchors)
   * -> ScaleBox(ScaleToFit, DownOnly) -> SizeBox(clamped design px) -> the element.
   *
   * The percentage band is centred inside the canvas the way CSS centres a block with
   * `margin:auto`: anchors span `[free/2, 1 - free/2]`, so the ScaleBox occupies exactly the
   * percentage of its parent and the clamped content sits centred in it.
   */
  wrapScaleClamp(rec, style, node, rootName, relPlan) {
    const label = this.label(rec);
    // This construction needs a parent that allots the canvas a definite box: a canvas slot
    // (absolute element) or an Overlay/CanvasPanel parent. Inside a box panel the wrapper would be
    // measured at its desired size, and a CanvasPanel has none, so the row would collapse; those
    // keep the measured px pin instead and get a warning.
    const parentSlot = node.slot;
    const insideBoxPanel = !!(parentSlot && parentSlot.Size);
    if (insideBoxPanel) {
      this.warn(
        `approximated: '${label}' keeps ${relPlan.width && relPlan.width.expr ? `width:${relPlan.width.expr}` : 'its clamped size'} as a fixed ${V.round(rec.rect[2], 1)}px - a box-panel parent has no definite extent for the percentage, so the clamp cannot be expressed at run time`
      );
      return node;
    }
    const width = relPlan.width;
    const percent = width && width.percent !== null && width.percent !== undefined
      ? V.clamp(width.percent, 0, 1)
      : null;

    // The px value the design asks for: min(percent of the parent, maxPx), or max(..., minPx).
    const designParent = rec.prect && rec.prect[2] ? rec.prect[2] : (rec.rect ? rec.rect[2] : 0);
    const measuredWidth = rec.rect ? rec.rect[2] : 0;
    let clampedPx = width && width.maxPx !== null && width.maxPx !== undefined
      ? Math.min(designParent * (percent === null ? 1 : percent), width.maxPx)
      : (width && width.minPx !== null && width.minPx !== undefined
        ? Math.max(designParent * (percent === null ? 1 : percent), width.minPx)
        : measuredWidth);
    if (!(clampedPx > 0)) clampedPx = measuredWidth;
    const designHeight = rec.rect && rec.rect[3] >= 1 ? rec.rect[3] : 0;

    // The element's own slot moves up to the canvas, so it keeps its place in the parent.
    const originalSlot = node.slot ? JSON.parse(JSON.stringify(node.slot)) : undefined;
    delete node.slot;
    node.slot = { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };

    // A WidthOverride on the element itself would fight the clamp; the SizeBox below owns the size.
    if (node.properties) {
      delete node.properties.WidthOverride;
      delete node.properties.bOverride_WidthOverride;
      if (!Object.keys(node.properties).length) delete node.properties;
    }

    const sized = {
      class: CLASS.SIZE_BOX,
      name: this.names.unique(`${rootName}Clamp`),
      properties: { WidthOverride: V.round(clampedPx, 2), bOverride_WidthOverride: true },
      slot: { HorizontalAlignment: 'Center', VerticalAlignment: 'Center' },
      children: [node],
    };
    if (designHeight > 0) {
      sized.properties.HeightOverride = V.round(designHeight, 2);
      sized.properties.bOverride_HeightOverride = true;
    }
    this.meta.set(sized, { rec, style, kind: 'sizebox', keepSlot: true });

    const scale = {
      class: CLASS.SCALE_BOX,
      name: this.names.unique(`${rootName}Scale`),
      properties: { Stretch: 'ScaleToFit', StretchDirection: 'DownOnly' },
      slot: {
        LayoutData: {
          Anchors: {
            Minimum: [V.round(percent === null ? 0 : (1 - percent) / 2, 4), 0],
            Maximum: [V.round(percent === null ? 1 : 1 - (1 - percent) / 2, 4), 1],
          },
          Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
          Alignment: [0, 0],
        },
        bAutoSize: false,
      },
      children: [sized],
    };
    this.meta.set(scale, { rec, style, kind: 'scalebox', keepSlot: true });

    const canvas = {
      class: CLASS.CANVAS,
      name: this.names.unique(`${rootName}${ROLE_SUFFIX.rel}`),
      properties: {},
      children: [scale],
    };
    // The canvas has to span its parent, otherwise the percentage anchors below it resolve against
    // the canvas's own (content) size and the clamp is meaningless. Vertical placement of the
    // element is the inner SizeBox's job (it is centred there).
    canvas.slot = originalSlot && originalSlot.LayoutData
      ? {
        LayoutData: {
          Anchors: { Minimum: [0, 0], Maximum: [1, 1] },
          Offsets: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
          Alignment: [0, 0],
        },
        bAutoSize: false,
      }
      : { HorizontalAlignment: 'Fill', VerticalAlignment: 'Fill' };
    this.meta.set(canvas, { rec, style, kind: 'canvas', keepSlot: true });

    this.warn(
      `mapped: '${label}' keeps ${width && width.expr ? `width:${width.expr}` : 'its clamped width'} as CanvasPanel + ScaleBox(DownOnly) + SizeBox(${V.round(clampedPx, 1)}px) - native UMG cannot resolve a percentage and a px clamp together; below the clamp the content is scaled rather than re-flowed`
    );
    return canvas;
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
    const runFont = this.fontProperties(rec, style, ctx.fontMap, out);
    // Same rule as buildText(): a run the browser kept on one line must never fold. An inline run
    // like the nav's 图形 / 音频 label sits in a row with an Automatic width, so a hundredth of a
    // pixel of extra advance is enough to stack it one character per line in the designer.
    const runLines = this.textLineCount(rec, style, runFont, out);
    const runAutoWrap = !/^nowrap/.test(style.whiteSpace) && !(runLines === 1 && out.indexOf('\n') < 0);
    const runShadow = parseTextShadow(style.textShadow);
    node.properties = {
      Text: out,
      Font: runFont,
      ColorAndOpacity: style.color,
      Justification: mapJustifyText(style.textAlign),
      AutoWrapText: runAutoWrap,
      // Same reasoning as buildText(): UTextBlock's (1,1) default adds a pixel to every line box.
    };
    const runKeepShadow = this.keepUmgShadow(runShadow);
    if (!runKeepShadow) node.properties.ShadowOffset = runShadow ? runShadow.offset : [0, 0];
    if (runShadow) node.properties.ShadowColorAndOpacity = runShadow.color;
    if (runAutoWrap) {
      const runWrap = this.responsiveMode() ? 0 : this.wrapTextAt(rec, style, runFont, out);
      if (runWrap > 0) node.properties.WrapTextAt = runWrap;
      if (this.cjkBreakMode() !== 'none') node.properties.WrappingPolicy = 'AllowPerCharacterWrapping';
    }
    const runShadowY = runShadow ? Math.abs(runShadow.offset[1] || 0) : runKeepShadow ? 1 : 0;
    const runPercentage = this.lineHeightPercentage(style, runFont, runShadowY, rec, out);
    if (runPercentage !== null) node.properties.LineHeightPercentage = runPercentage;
    // The run has no box of its own: the owner's margins must not leak into its slot.
    this.meta.set(node, { rec, style: Object.assign({}, style, { margin: [0, 0, 0, 0] }), kind: 'text' });
    return node;
  }

  /**
   * box-shadow growth per side [l, t, r, b] in CSS px, or null when there is no shadow.
   *
   * A CSS blur radius b bakes a shadow that fades over roughly b beyond the shape (the blur
   * kernel's sigma is b/2), so the painted footprint grows by (blur + spread) on every side,
   * shifted by the offset.
   */
  shadowExtentsOf(style) {
    const shadow = style && style.shadow;
    if (!shadow) return null;
    const grow = (shadow.blur || 0) + (shadow.spread || 0);
    const out = [
      Math.max(0, grow - (shadow.dx || 0)),
      Math.max(0, grow - (shadow.dy || 0)),
      Math.max(0, grow + (shadow.dx || 0)),
      Math.max(0, grow + (shadow.dy || 0)),
    ].map((value) => V.round(value, 2));
    return out.some((value) => value > 0) ? out : null;
  }

  /**
   * `backdrop-filter: blur(18px)` -> UBackgroundBlur::BlurStrength.
   * Returns 0 when there is no blur (or the value is not a px length).
   */
  blurStrength(value) {
    const text = String(value || '');
    if (!text || text === 'none') return 0;
    const match = /blur\(\s*([\d.]+)\s*(px)?\s*\)/i.exec(text);
    if (!match) return 0;
    const radius = Number(match[1]);
    if (!(radius > 0)) return 0;
    return Math.round(Math.min(radius, 100) * 100) / 100;
  }

  /**
   * CSS line-height -> UMG LineHeightPercentage, correcting for the different line box
   * definition.
   *
   * UTextBlock::LineHeightPercentage is a MULTIPLIER where 1.0 means Slate's natural line box
   * (STextBlock initialises it to 1.0f and FTextLayout multiplies the font's ascent+descent by
   * it). It is NOT a 0-100 percentage: emitting 94 here makes every line 94 times taller.
   * Returns null when the style carries no usable font size.
   */
  lineHeightPercentage(style, fontProps, shadowOffsetY, rec, text) {
    if (!style || !(style.fontSize > 0)) return null;
    // A computed line-height is always a px length or 'normal', so this is the CSS line box.
    const explicit = V.lineHeightToPercent(style.lineHeight, style.fontSize);
    const styleFactor = explicit === null ? null : explicit / 100;
    if (this.typographyModel() === 'legacy') {
      // Pre-per-font behaviour, kept as an A/B switch: one global Slate ratio for every font.
      const factor = styleFactor === null ? LEGACY_CSS_NORMAL_FACTOR : styleFactor;
      return V.round(factor / LEGACY_SLATE_FACTOR, 3);
    }
    // CSS side: the author line-height, or the measured line box when the text needs a fallback
    // face (see measuredCssLineBox), or the primary font's own metric.
    const cssBox = this.cssLineBoxPx(style, fontProps, rec, text);
    // Slate side: the font the TextBlock is actually created with. Without a readable file, the
    // built-in Segoe UI metrics keep the formula instead of a second set of constants.
    const metrics = this.fontMetricsFor(fontProps) || FALLBACK_FONT_METRICS;
    const slateBox = fontmetrics.slateLineBox(metrics, style.fontSize, { shadowOffsetY: shadowOffsetY || 0 });
    if (!(cssBox > 0) || !(slateBox > 0)) return null;
    return V.round(cssBox / slateBox, 4);
  }

  /**
   * The vertical metrics of the font a TextBlock will actually be drawn with.
   *
   * fontProperties() has already resolved the family to a font file (it is the only code that
   * knows about data-ue-font-map, @font-face and the system font table), so this reads the file
   * back out of the asset registry record instead of resolving the family a second time. The
   * registry's recorded path is relative to the assets directory, and the copied file is
   * byte-identical to the source.
   */
  fontMetricsFor(fontProps) {
    if (!this._metricsByFont) this._metricsByFont = new Map();
    if (!this._metricsByFile) this._metricsByFile = new Map();
    const objectPath = fontProps && typeof fontProps.FontObject === 'string' ? fontProps.FontObject : '';
    if (objectPath.charAt(0) !== '@' || !this.assets) return null;
    const key = objectPath.slice(1);
    if (this._metricsByFont.has(key)) return this._metricsByFont.get(key);
    const records = this.assets.fonts || [];
    const record = records.find((entry) => entry && entry.key === key);
    let metrics = null;
    if (record && record.file) {
      const file = path.join(this.assets.outDir || '.', path.basename(record.file));
      // A .ttc holds several faces and each has its OWN hhea/OS-2 (msyh.ttc: 1.3198 vs
      // 1.2700 line box), so the selected sub-face index is part of the metrics identity.
      const subface = Number.isInteger(record.subface) ? record.subface : 0;
      const cacheKey = `${file}#${subface}`;
      if (this._metricsByFile.has(cacheKey)) {
        metrics = this._metricsByFile.get(cacheKey);
      } else {
        metrics = fontmetrics.readFontFile(file, { index: subface });
        this._metricsByFile.set(cacheKey, metrics);
        if (!metrics) {
          this.warn(
            `font: cannot read vertical metrics from '${path.basename(file)}'${subface ? ` face ${subface}` : ''}; line heights fall back to the Segoe UI model`
          );
        }
      }
    }
    this._metricsByFont.set(key, metrics);
    return metrics;
  }

  /**
   * CSS content box width in px: border box minus horizontal padding and borders.
   *
   * This is what UMG's `WrapTextAt` has to be told. AutoWrapText only allows wrapping; the width
   * comes from WrapTextAt, and when it is 0 the attribute is not bound at all
   * (UMG TextWidgetTypes.h: SynchronizeTextLayoutProperties binds
   * `WrapTextAt != 0 ? WrapTextAt : TAttribute<float>()`). Every text block here sits on a
   * CanvasPanel with absolute offsets, so desired-size never sees a bounded width and the only
   * way Slate can wrap is an explicit WrapTextAt.
   */
  contentBoxWidth(rec, style) {
    if (!rec || !rec.rect) return 0;
    const pad = (style && style.padding) || [0, 0, 0, 0];
    const border = (style && style.borderWidth) || [0, 0, 0, 0];
    const width = rec.rect[2] - (pad[0] + pad[2]) - (border[0] + border[2]);
    return width > 0 ? V.round(width, 2) : 0;
  }

  /**
   * WrapTextAt for a text block, or 0 when the element must not wrap.
   *
   * Emitted even when the browser did not wrap: a single line is unaffected (its measured width
   * is smaller than the content box), while a line that only *nearly* fits now breaks instead of
   * overflowing the box. `white-space: nowrap` never wraps, which is why AutoWrapText and this
   * stay separate decisions. Set --wrap-tolerance (or HTML2UMG_WRAP_TOLERANCE) to give Slate a
   * little slack when its glyph advances measure wider than Chromium's.
   */
  /**
   * True when the element's used width comes from its content (shrink-to-fit), not from a box.
   *
   * An inline box, an inline-block, a float, or an absolutely positioned box with `width: auto`
   * is only as wide as its text needs. That width is the *result* of laying the text out, so it
   * must never be handed back to Slate as a wrap width: a fraction of a pixel of extra glyph
   * advance then turns into an extra line (the .btn case: browser 153.73px box, Slate measured a
   * couple of pixels wider and wrapped a one-line label into two).
   */
  widthIsContentDriven(rec, style) {
    const cs = (rec && rec.cs) || {};
    const display = String((style && style.display) || cs.display || 'block');
    if (/^inline/.test(display)) return true;
    if (String(cs.float || 'none') !== 'none') return true;
    const position = String((style && style.position) || cs.position || 'static');
    const autoWidth = !style || style.fixedWidth === null || style.fixedWidth === undefined;
    if (autoWidth && (position === 'absolute' || position === 'fixed' || position === 'sticky')) return true;
    return false;
  }

  /** element index -> parent record, built once from the snapshot's child lists. */
  parentRecords() {
    if (this._parents) return this._parents;
    const map = new Map();
    for (const rec of this.snapshot.elements) {
      for (const child of rec.k || []) {
        if (typeof child === 'number' && !map.has(child)) map.set(child, rec.i);
      }
    }
    this._parents = map;
    return map;
  }

  /**
   * Width of the line box a text run is laid out in, in CSS px.
   *
   * For a block-level element that is its own content box. For shrink-to-fit boxes it is the
   * content box of the nearest block-level ancestor, because *that* is what CSS gives the line
   * box; the inline box's own width is just where the text happened to end.
   */
  wrapWidthFor(rec, style) {
    const own = this.contentBoxWidth(rec, style);
    if (!this.widthIsContentDriven(rec, style)) return own;
    const parents = this.parentRecords();
    let cursor = rec.i;
    for (let guard = 0; guard < 64; guard += 1) {
      const parentIndex = parents.get(cursor);
      if (parentIndex === undefined) break;
      const parent = this.byIndex.get(parentIndex);
      if (!parent) break;
      const parentStyle = this.readStyle(parent);
      if (!this.widthIsContentDriven(parent, parentStyle)) {
        const width = this.contentBoxWidth(parent, parentStyle);
        return width > own ? width : own;
      }
      cursor = parent.i;
    }
    return own;
  }

  /** CSS content box height in px: border box minus vertical padding and borders. */
  contentBoxHeight(rec, style) {
    if (!rec || !rec.rect) return 0;
    const pad = (style && style.padding) || [0, 0, 0, 0];
    const border = (style && style.borderWidth) || [0, 0, 0, 0];
    const height = rec.rect[3] - (pad[1] + pad[3]) - (border[1] + border[3]);
    return height > 0 ? V.round(height, 2) : 0;
  }

  /** The line box this style's font predicts, in px (explicit line-height wins). */
  modelCssLineBox(style, fontProps) {
    const explicit = V.parsePx(style && style.lineHeight);
    if (explicit !== null && explicit > 0) return explicit;
    const size = style && style.fontSize > 0 ? style.fontSize : 14;
    const metrics = this.fontMetricsFor(fontProps);
    const mode = String(this.opts.lineBoxSnap || process.env.HTML2UMG_LINE_BOX_SNAP || 'exact').toLowerCase();
    // 'font' = what Chromium actually uses: each of ascent/descent/lineGap rounded to a
    // whole pixel and then added (fontmetrics.cssLineBox). The other modes keep this raw value so
    // the snap A/B still measures snapping alone.
    const box = metrics ? (mode === 'font' ? fontmetrics.cssLineBox(metrics, size) : fontmetrics.cssLineBoxExact(metrics, size)) : null;
    if (box > 0) return box;
    return LEGACY_CSS_NORMAL_FACTOR * size;
  }

  /**
   * Does any character of this text fall outside the primary font's cmap?
   *
   * When it does, Chromium draws that glyph from a fallback face and the LINE BOX follows the face
   * it really used: Segoe UI is 1.3301em but Microsoft YaHei is 1.42em and Noto Sans SC 1.448em, so
   * a 16px "十六像素 ABC" label gets a 24px line box in the browser while the primary font alone
   * predicts 21.31. That is why a CJK label with 'line-height: normal' used to come out 1.0-2.7px
   * short per line. Coverage is checked against the file we actually import, so no font name is
   * guessed here.
   */
  hasFallbackGlyphs(fontProps, text) {
    if (!text || !this.assets) return false;
    const objectPath = fontProps && typeof fontProps.FontObject === 'string' ? fontProps.FontObject : '';
    if (objectPath.charAt(0) !== '@') return false;
    const metrics = this.fontMetricsFor(fontProps);
    if (!metrics || !metrics.cmap) return false;
    if (!this._coversByFont) this._coversByFont = new Map();
    let cache = this._coversByFont.get(objectPath);
    if (!cache) {
      cache = new Map();
      this._coversByFont.set(objectPath, cache);
    }
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp <= 0x7f) continue; // ASCII is the baseline every UI face covers
      if (cache.has(cp)) {
        if (cache.get(cp) === false) return true;
        continue;
      }
      const covered = fontmetrics.covers(metrics, [cp]).missing.length === 0;
      cache.set(cp, covered);
      if (!covered) return true;
    }
    return false;
  }

  /**
   * The CSS line box Chromium actually laid out, in px, or null when the measurement cannot be
   * trusted. **This is the default path**; the font-file model is only the fallback.
   *
   * The browser already resolved every font quirk for us — fallback faces for CJK, Consolas' huge
   * and ignored lineGap, variable-font default instances, per-side rounding — and any of them can
   * be 0.3-2px off when modelled from the file. Measuring costs nothing: the element's content box
   * is a whole number of line boxes, so dividing it out gives the exact line box.
   *
   * Guards (all keep the model instead of the measurement):
   *   * an authored `line-height` wins outright (the browser uses that length verbatim);
   *   * an authored `height` says nothing about the line box (34px button around a 17px line);
   *   * table cells are stretched by the row's tallest cell;
   *   * the content box must be within 0.15 of a whole number of line boxes, otherwise it was
   *     stretched by a parent (flex item, grid row) and the ratio means nothing.
   */
  measuredCssLineBox(rec, style, fontProps, text, modelBox) {
    if (!rec || !rec.rect || !(modelBox > 0)) return null;
    const explicit = V.parsePx(style && style.lineHeight);
    if (explicit !== null && explicit > 0) return null;
    if (style && style.fixedHeight !== null && style.fixedHeight !== undefined) return null;
    const display = String((style && style.display) || 'block');
    if (display === 'table-cell' || display === 'table' || display === 'inline-table') return null;
    const contentHeight = this.contentBoxHeight(rec, style);
    if (!(contentHeight > 0)) return null;
    const raw = contentHeight / modelBox;
    // A box shorter than half a line is clipped/collapsed, not a line count. Above that the
    // integer tolerance below decides: a face whose modelled line box is 15% wrong (Consolas, .ttc
    // faces, variable fonts) still lands within 0.15 of a whole line box and must be believed.
    if (raw < 0.5) return null;
    const lines = Math.max(1, Math.round(raw));
    if (Math.abs(raw - lines) > 0.15) return null; // stretched box, keep the model
    const measured = contentHeight / lines;
    // Only believe the measurement when it *contradicts* the model by a measurable amount.
    //
    // The faces whose modelled line box is wrong are all off by a lot: Consolas 12px is 2.1px off
    // (Chrome ignores its lineGap), the 10px rounding boundary is 0.7px, 17px is 0.6px, a .ttc
    // sub-face ~5%. Those get corrected by taking the measurement. Pages where the model is already
    // right (native-control-heavy ones) gain nothing: a 0.2-0.4px difference only moves widgets off
    // integer pixels so baked brushes resample (06-native went 1.93% -> 2.21%). The measurement
    // therefore wins only when |measured - model| >= 0.5px, which is also where a difference stops
    // being sub-pixel noise.
    // Threshold is a knob (env only, no CLI surface) so the exact value can be A/B'd without a code
    // change: HTML2UMG_LINE_BOX_MEASURE_MIN=0.25 (default) / 0 / 0.5.
    const thresholdRaw = Number(process.env.HTML2UMG_LINE_BOX_MEASURE_MIN);
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw >= 0 ? thresholdRaw : 0.25;
    const delta = measured - modelBox;
    if (Math.abs(delta) < threshold) return null;
    this.warn(
      `font: '${this.label(rec)}' line box measured ${V.round(measured, 2)}px vs model ${V.round(modelBox, 2)}px (Δ${delta > 0 ? '+' : ''}${V.round(delta, 2)}px); using the measurement`
    );
    return measured;
  }

  /** The CSS line box of one line of this style, in px (explicit > measured > model). */
  cssLineBoxPx(style, fontProps, rec, text) {
    const explicit = V.parsePx(style && style.lineHeight);
    if (explicit !== null && explicit > 0) return explicit;
    const modelBox = this.modelCssLineBox(style, fontProps);
    const measured = this.measuredCssLineBox(rec, style, fontProps, text, modelBox);
    const mode = String(this.opts.lineBoxSnap || process.env.HTML2UMG_LINE_BOX_SNAP || 'exact').toLowerCase();
    const target = measured !== null && measured > 0 ? measured : modelBox;
    return mode === 'font' ? target : this.lineBoxSnap(target);
  }

  /**
   * Optional snapping of the target line box to whole or half pixels.
   *
   * 'exact' (default) uses the font's fractional metric, which is what Chromium's own layout keeps
   * (LayoutUnit = 1/64px). 'int' / 'half' exist to test the opposite hypothesis on pages whose
   * downstream widgets get resampled anyway: a line box that is a fraction of a pixel tall pushes
   * every following widget onto a fractional pixel, and baked brushes then resample. This is only
   * an A/B knob (--line-box-snap=exact|half|int, or HTML2UMG_LINE_BOX_SNAP); the default stays exact.
   */
  lineBoxSnap(box) {
    const mode = String(this.opts.lineBoxSnap || process.env.HTML2UMG_LINE_BOX_SNAP || 'exact').toLowerCase();
    if (!(box > 0)) return box;
    if (mode === 'half') return Math.round(box * 2) / 2;
    if (mode === 'int') return Math.round(box);
    return box;
  }

  /**
   * How many lines the browser laid this text out in.
   *
   * Wrapping an element that Chromium kept on one line is worse than not wrapping it: a Slate
   * font that measures a fraction of a pixel wider turns a one-line label into two, which is
   * exactly the button bug (20px -> 40px). So the wrap width is only emitted when the browser
   * itself broke the text, i.e. when the content box is at least two line boxes tall.
   */
  textLineCount(rec, style, fontProps, text) {
    const explicitBreaks = typeof text === 'string' ? (text.match(/\n/g) || []).length : 0;
    // An authored height says nothing about the line count: a 34px button around a single 17px
    // line divides out to 1.96 "lines" and would have made Slate wrap a label the browser kept on
    // one line. Only a content-driven box is evidence. (Explicit <br> breaks still count.)
    if (style && style.fixedHeight !== null && style.fixedHeight !== undefined) {
      return Math.max(1, explicitBreaks + 1);
    }
    const lineBox = this.modelCssLineBox(style, fontProps);
    if (!(lineBox > 0)) return Math.max(1, explicitBreaks + 1);
    const contentHeight = this.contentBoxHeight(rec, style);
    if (!(contentHeight > 0)) return Math.max(1, explicitBreaks + 1);
    const raw = contentHeight / lineBox;
    const lines = Math.max(1, Math.round(raw));
    // A row stretched by a taller sibling (table rows, flex stretches) lands between whole
    // lines; round anyway but leave a trail so a bad wrap can be traced back to this guess.
    const fraction = Math.abs(raw - Math.floor(raw));
    if (fraction > 0.4 && fraction < 0.6 && lines >= 2) {
      this.warn(
        `wrap: '${this.label(rec)}' content box is ${V.round(raw, 2)} line boxes tall; assumed ${lines} line(s) from the box height`
      );
    }
    return Math.max(lines, explicitBreaks + 1);
  }

  wrapTextAt(rec, style, fontProps, text) {
    if (!rec || !rec.rect) return 0;
    if (/^nowrap/.test(String((style && style.whiteSpace) || 'normal'))) return 0;
    // Only text the browser actually wrapped gets a wrap width (see textLineCount).
    if (this.textLineCount(rec, style, fontProps, text) < 2) return 0;
    const width = this.wrapWidthFor(rec, style);
    if (!(width > 0)) return 0;
    const tolerance = Number(this.opts.wrapTolerance !== undefined ? this.opts.wrapTolerance : process.env.HTML2UMG_WRAP_TOLERANCE);
    return V.round(width + (Number.isFinite(tolerance) ? tolerance : 0), 2);
  }

  /**
   * 'per-font' (default) reads each font's real line box; 'legacy' is the single global constant
   * the converter used before, kept so a page can be A/B'd without a revert
   * (--line-height-model=per-font|legacy, or HTML2UMG_LINE_HEIGHT_MODEL).
   */
  typographyModel() {
    const raw = String(this.opts.lineHeightModel || process.env.HTML2UMG_LINE_HEIGHT_MODEL || 'per-font').toLowerCase();
    return raw === 'legacy' ? 'legacy' : 'per-font';
  }

  /**
   * Whether a TextBlock keeps UTextBlock's default ShadowOffset (1,1).
   *
   * `legacy` always keeps it (that is what the old output did). `default` keeps it while still
   * counting the extra pixel in the line box, which isolates "baseline shifted by 1px" from
   * "line box one pixel too tall" when A/B-ing a page (HTML2UMG_TEXT_SHADOW=default).
   */
  keepUmgShadow(shadow) {
    if (shadow) return false;
    if (this.typographyModel() === 'legacy') return true;
    const raw = String(this.opts.textShadow || process.env.HTML2UMG_TEXT_SHADOW || 'zero').toLowerCase();
    return raw === 'default';
  }

  /**
   * How CJK runs get break opportunities. 'policy' (default) asks Slate to fall back to
   * per-character wrapping when a run has no break point that fits; 'none' keeps the old
   * behaviour. No zero-width characters are ever injected into the text itself, so the WBP's
   * strings stay identical to the design.
   */
  /**
   * 'ignore' (default) drops data-ue-font-map, 'keep' honours it.
   * Env: HTML2UMG_FONT_MAP.
   */
  fontMapMode() {
    const raw = String(this.opts.fontMap || process.env.HTML2UMG_FONT_MAP || 'ignore').toLowerCase();
    return raw === 'keep' ? 'keep' : 'ignore';
  }

  /**
   * 'exact' (default) bakes the design at --viewport; 'responsive' emits constraints Slate can
   * resolve at run time (no baked WrapTextAt, text stretches across its container so it rewraps,
   * centring becomes an Overlay instead of baked padding).
   */
  responsiveMode() {
    const raw = String(this.opts.layout || process.env.HTML2UMG_LAYOUT || 'exact').toLowerCase();
    return raw === 'responsive';
  }

  cjkBreakMode() {
    const raw = String(this.opts.cjkBreaks || process.env.HTML2UMG_CJK_BREAKS || 'policy').toLowerCase();
    return raw === 'none' || raw === 'off' ? 'none' : 'policy';
  }

  /**
   * @param {object} rec          element record (carries platformFonts when probed)
   * @param {object} style        computed style with fontFamily/fontSize/...
   * @param {Map}    fontMap      data-ue-font-map overrides (empty for probes)
   * @param {string} [text]       the string this font will render; decides whether a
   *                              CJK fallback is required. Falls back to rec.text.
   */
  fontProperties(rec, style, fontMap, text) {
    const font = {
      // FSlateFontInfo::Size is a POINT size at 96 dpi, CSS font-size is px:
      // emitting px directly renders text 96/72 = 1.333x too large, which inflates
      // every line box and drags the whole column down the page.
      Size: V.round(style.fontSize / PX_PER_POINT, 2),
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
      const rendered = typeof text === 'string' ? text : (rec && rec.text) || '';
      const registered = this.assets.addFont(style.fontFamily, style.fontWeight, style.fontItalic, faces, {
        text: rendered,
        platformFonts: rec && rec.platformFonts ? rec.platformFonts : null,
        faces: this.snapshot ? this.snapshot.fontFaces : null,
      });
      if (registered && registered.hasFile) font.FontObject = `@${registered.key}`;
    }
    return font;
  }

  // ----------------------------------------------------------------- content
  /**
   * `name` is the name of the widget this element's content becomes; `base` is the
   * element's OWN assigned name, used for companions generated *inside* the content
   * (a text-wrap box, a control's caption) so they never chain onto `name`.
   */
  buildContent(rec, style, kind, ctx, name, base) {
    switch (kind) {
      case 'placeholder':
        return this.buildPlaceholder(rec, style, name);
      case 'text':
        return this.buildText(rec, style, ctx, name, base);
      case 'image':
        return this.buildImage(rec, style, name);
      case 'button':
        return this.buildButton(rec, style, ctx, name);
      case 'textinput':
        return this.buildTextInput(rec, style, name);
      case 'spinbox':
        return this.buildSpinBox(rec, style, name);
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
        return this.buildContainer(rec, style, kind, ctx, name, base || name);
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
    // One Slate outline has to stand for four CSS sides, so pick the width the MAJORITY of
    // painted edges use and only fall back to the widest edge on a tie. Picking the single
    // widest edge repainted all four in that edge's colour: a textarea styled
    // `border:1px #24384a; border-left:3px #d29922` got a 3px ORANGE frame on every side,
    // which is where ~2.9k of that page's 3.0k orange pixels came from (the browser draws
    // 3px of orange on 76 left-hand pixels only).
    let index = 0;
    let bestCount = -1;
    for (let i = 0; i < 4; i += 1) {
      if (!(widths[i] > 0.01)) continue;
      let count = 0;
      for (let j = 0; j < 4; j += 1) {
        if (widths[j] > 0.01 && Math.abs(widths[j] - widths[i]) < 0.01) count += 1;
      }
      if (count > bestCount || (count === bestCount && widths[i] > widths[index])) {
        bestCount = count;
        index = i;
      }
    }
    const outlineWidth = widths[index] > 0.01 ? widths[index] : maxWidth;
    const color = sides.colors[index] || [0, 0, 0, 0];
    const present = widths.filter((value) => value > 0.01).length;
    const uniform = present === 4 && widths.every((value) => Math.abs(value - outlineWidth) < 0.01);
    if (!uniform) {
      for (let i = 0; i < 4; i += 1) extra[i] = V.round(Math.max(0, outlineWidth - widths[i]), 2);
      if (present === 1) {
        this.warn(
          `approximated: only the ${names[index]} ${what} is kept on '${label}' (Slate brushes have a single outline); other edges padded by ${V.round(outlineWidth, 2)}px`
        );
      } else {
        this.warn(
          `approximated: ${what} widths ${JSON.stringify(widths.map((v) => V.round(v, 2)))} on '${label}' collapsed to the dominant ${V.round(outlineWidth, 2)}px (${names[index]} colour)`
        );
      }
    }
    if (sides.styles.some((value) => /dashed|dotted|double|groove|ridge/.test(String(value)))) {
      this.warn(`approximated: ${what}-style ${sides.styles.join('/')} on '${label}' drawn solid`);
    }
    return { width: V.round(outlineWidth, 2), color, extra, sides };
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
    const policy = this.outlinePolicy(this.sidesFromVisual(visual), opts.label || 'control', opts.where);
    // Same rule as borderBrush: a Box brush ignores OutlineSettings, so a bordered control with
    // square corners would have no border at all. RoundedBox with zero radii is still a rectangle.
    const outlined = policy.width > 0;
    brush.drawAs = hasRadius || outlined ? 'RoundedBox' : 'Box';
    if (hasRadius || outlined) brush.cornerRadii = radii;
    brush.tint = V.colorToLinear(visual.backgroundColor) || [0, 0, 0, 0];
    if (outlined) {
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

  /**
   * Designed popup row height in CSS px. An SComboRow is sized by its content plus
   * MenuRowPadding, so the authored height can only be honoured as vertical padding.
   * Sources, in order: data-ue-row-height, the row rule's line-height (a single-line
   * row is as tall as its line box), else 0 (leave the engine default).
   */
  rowHeight(info, ue, style) {
    const declared = ue && ue['row-height'] !== undefined ? parseFloat(ue['row-height']) : NaN;
    if (Number.isFinite(declared) && declared > 0) return declared;
    const row = info && info.row;
    const line = row && row.base ? V.parsePx(row.base.lineHeight) : null;
    const font = (style && style.fontSize) || 14;
    if (line && line > font * 1.15) return line;
    return 0;
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
    // A hovered, *non-selected* row is painted with the zebra hovered brushes, never
    // with InactiveHoveredBrush (STableRow::OnPaint), so leaving these at the engine
    // default is what put a light highlight bar over the dark popup list.
    out.EvenRowBackgroundHoveredBrush =
      chain([row.hover], 'row:even:hover') || clone(out.EvenRowBackgroundBrush);
    out.OddRowBackgroundHoveredBrush =
      chain([row.hover], 'row:odd:hover') || clone(out.OddRowBackgroundBrush);
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
      const textNode = this.buildText(rec, style, ctx, this.names.unique(`${name}${ROLE_SUFFIX.text}`), name);
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
    // A <textarea> is a MULTILINE edit box. Without IsMultiLine the widget is a single-line
    // SEditableTextBox that can never be taller than one line, which is why a 76px design
    // painted a 38px box (the ScrollBox around it does not stretch its child either).
    if (rec.tag === 'textarea') props.IsMultiLine = true;

    const normal = this.visualBrush(ctl.box, { label: `${label} box`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    const hover = ctl.states && ctl.states.hover ? this.visualBrush(ctl.states.hover, { label: `${label}:hover`, allowEmpty: true }) : null;
    const focused = ctl.states && ctl.states.focus ? this.visualBrush(ctl.states.focus, { label: `${label}:focus`, allowEmpty: true }) : null;
    const textColor = this.colorOf(ctl.computed) || style.color;

    // UEditableTextBox keeps its font, colours and background inside the style struct.
    const widgetStyle = {
      TextStyle: {
        Font: this.fontProperties(rec, style, new Map(), form.value || form.placeholder || ''),
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

  /**
   * <input type="number"> -> UMG SpinBox.
   *
   * A number field is a spinner in the browser as well, so it becomes a real SpinBox instead of an
   * edit box that cannot step. The browser draws its own spinner arrows from the UA stylesheet (only
   * on hover), so there is nothing to bake: FSpinBoxStyle already carries ArrowsImage with the
   * engine's default style, and we override only what the design states - range, font, colour,
   * padding. Leaving the rest of the struct alone is deliberate; writing an empty WidgetStyle would
   * wipe the arrows.
   */
  buildSpinBox(rec, style, name) {
    const node = this.makeNode(name, CLASS.SPIN_BOX, rec);
    const form = rec.form || {};
    const ctl = rec.control || {};
    const label = this.label(rec);
    const props = {};

    // HTML numbers are strings and may be absent; a missing min/max keeps UMG's own default.
    const num = (raw) => {
      if (raw === null || raw === undefined || String(raw).trim() === '') return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const min = num(form.min);
    const max = num(form.max);
    const step = num(form.step);
    let value = num(form.value);
    if (value === null) value = min !== null ? min : 0;
    // The browser clamps a typed value into the range on commit; do the same at build time.
    if (min !== null && value < min) value = min;
    if (max !== null && value > max) value = max;

    props.Value = value;
    if (min !== null) props.MinValue = min;
    if (max !== null) props.MaxValue = max;
    if (step !== null && step > 0) props.Delta = step;
    // UMG shows the arrows of its own accord (the engine default style carries ArrowsImage); 5.8
    // has no "always show" flag any more, so there is nothing to force here.
    //
    // A whole-number field must not render as "45.0": the browser shows what the author typed, so
    // take the decimal count from the value and the step rather than from UMG's default of one.
    const decimals = (raw) => {
      const text = String(raw === null || raw === undefined ? '' : raw);
      const dot = text.indexOf('.');
      return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
    };
    props.MinFractionalDigits = 0;
    props.MaxFractionalDigits = Math.max(decimals(form.value), decimals(step));

    props.Font = this.fontProperties(rec, style, new Map(), String(form.value || ''));

    const textColor = this.colorOf(ctl.computed) || style.color;
    const widgetStyle = { ForegroundColor: textColor };
    const normal = this.visualBrush(ctl.box, { label: `${label} box`, allowEmpty: true }) ||
      (style.hasVisualBox ? this.borderBrush(style, rec) : null);
    if (normal) {
      const hover = ctl.states && ctl.states.hover
        ? this.visualBrush(ctl.states.hover, { label: `${label}:hover`, allowEmpty: true })
        : null;
      widgetStyle.BackgroundBrush = normal;
      widgetStyle.HoveredBackgroundBrush = hover || normal;
      widgetStyle.ActiveBackgroundBrush = (ctl.states && ctl.states.focus
        ? this.visualBrush(ctl.states.focus, { label: `${label}:focus`, allowEmpty: true })
        : null) || hover || normal;
    }
    const inset = this.controlInset(style, ctl.box, label);
    if (inset) widgetStyle.TextPadding = inset;
    props.WidgetStyle = widgetStyle;

    node.properties = props;
    this.meta.set(node, { rec, style, kind: 'spinbox' });
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
    // The popup is an SComboButton menu: it is wrapped in an SBorder painted with
    // FComboButtonStyle.MenuBorderBrush and inset by MenuBorderPadding. Both default
    // to the editor's light menu frame, so a dark popup ends up inside a light frame
    // (and pushed inward) unless they are authored.
    const menuSource = (ctl.row && ctl.row.list) || ctl.box;
    const menu = menuSource ? this.visualBrush(menuSource, { label: `${label} menu`, allowEmpty: true }) : null;
    if (menu || baked) {
      widgetStyle.ComboButtonStyle = widgetStyle.ComboButtonStyle || {};
      if (menu) widgetStyle.ComboButtonStyle.MenuBorderBrush = menu;
      // The design's list box is drawn by its own rows; an extra frame inset would
      // show as a gap between the closed box and the rows.
      widgetStyle.ComboButtonStyle.MenuBorderPadding = [0, 0, 0, 0];
    }
    if (baked) {
      // The baked closed box already carries the caret the browser drew; the engine
      // arrow (a light default brush) would be painted a second time on top of it.
      widgetStyle.ComboButtonStyle = widgetStyle.ComboButtonStyle || {};
      // imageSize 0 for the same reason as the check box: a NoDrawType brush still feeds its
    // ImageSize into the SImage's desired size (engine default 32x32).
    widgetStyle.ComboButtonStyle.DownArrowImage = { drawAs: 'NoDrawType', tint: [0, 0, 0, 0], imageSize: [0, 0] };
      widgetStyle.ComboButtonStyle.DownArrowPadding = [0, 0, 0, 0];
    }
    // UComboBoxString's popup is an SListView whose scrollbar comes from its own
    // ScrollBarStyle UPROPERTY, which defaults to the bright editor scrollbar. The
    // design shows no scrollbar, so it is collapsed to zero thickness.
    // imageSize 0: a NoDrawType brush still contributes its ImageSize to the owning SImage's
    // desired size, and the engine default is 32x32.
    const noBrush = () => ({ drawAs: 'NoDrawType', tint: [0, 0, 0, 0], imageSize: [0, 0] });
    props.ScrollBarStyle = {
      Thickness: 0,
      VerticalBackgroundImage: noBrush(),
      VerticalTopSlotImage: noBrush(),
      VerticalBottomSlotImage: noBrush(),
      NormalThumbImage: noBrush(),
      HoveredThumbImage: noBrush(),
      DraggedThumbImage: noBrush(),
    };
    // Row metrics: FComboBoxStyle has no row-height field — an SComboRow is the item
    // content plus MenuRowPadding — so the designed row height has to become vertical
    // padding around the text line. Using only the author's padding collapsed the
    // 34px '.combo-list .item' rows to the bare text height.
    const rowPad = this.rowPadding(info);
    const rowHeight = this.rowHeight(info, ue, style);
    const hPad = rowPad || [0, 0, 0, 0];
    if (rowHeight > 0) {
      const line = (style.fontSize || 14) * LINE_BOX_FACTOR;
      const vpad = V.round(Math.max(0, (rowHeight - line) / 2), 2);
      widgetStyle.MenuRowPadding = [hPad[0], vpad, hPad[2], vpad];
    } else if (rowPad) {
      widgetStyle.MenuRowPadding = rowPad;
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
    // FCheckBoxStyle.ForegroundColor tints the caption, but SCheckBox builds its
    // check image as
    //   SNew(SImage).Image(OnGetCheckImage).ColorAndOpacity(FSlateColor::UseForeground())
    // so the SAME colour is also a multiplier on the check image. A baked texture
    // already carries the authored colours, so every state colour must stay white
    // or the green tick is multiplied down to near-black.
    const textColor =
      V.colorToLinear(ctl.inheritedColor) || this.colorOf(ctl.box) || this.colorOf(ctl.computed) || style.color;
    const imageCarriesColour = !!(bakedParts || checked || unchecked);
    const foregrounds = [
      'ForegroundColor', 'CheckedForeground', 'UndeterminedForeground',
      'HoveredForeground', 'CheckedHoveredForeground', 'PressedForeground', 'CheckedPressedForeground',
    ];
    if (imageCarriesColour) {
      for (const key of foregrounds) widgetStyle[key] = [1, 1, 1, 1];
    } else {
      widgetStyle.ForegroundColor = textColor;
      if (accent) widgetStyle.CheckedForeground = accent;
    }
    // The engine's check box style carries a non-zero Padding and a BackgroundImage;
    // both paint/inset a box the browser never draws.
    widgetStyle.Padding = [0, 0, 0, 0];
    // imageSize MUST be zeroed alongside NoDrawType: SCheckBox builds this image as an SImage,
    // and an SImage still contributes Brush.ImageSize to its DESIRED size even when the draw
    // type paints nothing. FSlateBrush defaults ImageSize to (32,32), so leaving it alone makes
    // the 18x18 check box report a 32px desired width and the tick renders stretched to 32x18.
    widgetStyle.BackgroundImage = { drawAs: 'NoDrawType', tint: [0, 0, 0, 0], imageSize: [0, 0] };
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
    // USlider paints the bar/thumb as
    //   Brush->GetTint() * SliderBarColor * ...
    // (SSlider.cpp OnPaint). Our bar/thumb brush already carries the authored
    // colour — a baked texture of the real pixels, or a tinted visual brush — so a
    // coloured multiplier squares the colour and turns the blue track black.
    if (widgetStyle.NormalBarImage) props.SliderBarColor = [1, 1, 1, 1];
    else if (barColor && barColor[3] > 0) props.SliderBarColor = barColor;
    if (widgetStyle.NormalThumbImage) props.SliderHandleColor = [1, 1, 1, 1];
    else if (accent) props.SliderHandleColor = accent;
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

  /**
   * `name` is this container widget's name; `base` is the owning element's own name.
   * Everything generated below (flow group, bare text runs) is named from `base`.
   */
  buildContainer(rec, style, kind, ctx, name, base) {
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
      node.children = this.mapChildren(flow.concat(absolute), ctx, null, name, base);
      this.meta.set(node, { rec, style, kind: 'custom' });
      return node;
    }

    if (absolute.length && flow.length) {
      // Flow children keep their flow container, absolutely positioned ones are
      // placed on a CanvasPanel sibling layer (CSS stacking inside one box).
      const canvas = this.makeNode(name, CLASS.CANVAS, rec);
      const flowNode = this.buildFlowContainer(rec, style, kind, flow, ctx, this.names.unique(`${base}${ROLE_SUFFIX.flow}`), base);
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
      canvasChildren.push.apply(canvasChildren, this.mapChildren(absolute, ctx, 'canvas', name, base));
      if (!canvasChildren.length) return null;
      canvas.children = canvasChildren;
      this.meta.set(canvas, { rec, style, kind: 'canvas', canvasInset: this.canvasInsetOf(style) });
      return canvas;
    }

    if (absolute.length) {
      const canvas = this.makeNode(name, CLASS.CANVAS, rec);
      canvas.children = this.mapChildren(absolute, ctx, 'canvas', name, base);
      if (!canvas.children.length) return null;
      this.meta.set(canvas, { rec, style, kind: 'canvas', canvasInset: this.canvasInsetOf(style) });
      return canvas;
    }

    return this.buildFlowContainer(rec, style, kind, flow, ctx, name, base);
  }

  /**
   * How far the CanvasPanel sits inside its parent element's border box, per side.
   *
   * `buildElement` wraps the content in a Border whose Padding is the element's own padding+border,
   * so the CanvasPanel is the element's CONTENT box. But an absolutely positioned child's CSS
   * insets are measured from the element's **padding box**, and our sample positions are
   * border-box relative (`rect - prect`). Both spaces have to be brought to the canvas origin or
   * every absolute child is off by the padding: measured on 12-responsive's `.overlay`
   * (`left/right:32; bottom:24; height:56` in a `padding:18px 24px 96px` element) it landed at
   * x=296 (browser 272) and y=904 (browser 1000).
   *
   * A STATIC element is not a containing block for its absolute descendants, so its children's
   * measured offsets are meaningless here - that path keeps the old (unshifted) treatment.
   */
  canvasInsetOf(style) {
    // NOT tied to classify()'s kind: a CanvasPanel is created whenever the element has absolute
    // children, and such an element is usually display:flex or grid, whose kind is not 'canvas'.
    if (!style || style.position === 'static') return null;
    const pad = style.padding || [0, 0, 0, 0];
    const border = style.borderWidth || [0, 0, 0, 0];
    const inset = [0, 1, 2, 3].map((i) => V.round((pad[i] || 0) + (border[i] || 0), 2));
    return inset.some((v) => v !== 0) ? inset : null;
  }

  /** Move border-box-relative canvas samples onto the padding box (canvasBorder). */
  withCanvasBorder(series, border) {
    if (!series || !border) return series;
    if (!border.some((v) => v !== 0)) return series;
    const shift = (entries, near, far) => (entries || []).map((s) => ({
      pos: V.round(s.pos - near, 4),
      size: s.size,
      parentSize: Math.max(1, V.round(s.parentSize - near - far, 4)),
    }));
    return { x: shift(series.x, border[0], border[2]), y: shift(series.y, border[1], border[3]) };
  }

  buildFlowContainer(rec, style, kind, items, ctx, name, base) {
    let cls = CLASS.VERTICAL;
    let nodeKind = 'block';
    let orientation = 'v';

    // data-ue-switcher: this container's children are mutually exclusive pages. The importer maps
    // it to CommonUI's animated switcher when available and to a stock WidgetSwitcher otherwise.
    if (rec.ue && rec.ue.switcher !== undefined) {
      cls = CLASS.PAGE_SWITCHER;
      nodeKind = 'switcher';
      orientation = 'switcher';
      this.infoOnce(
        `mapped: 'switcher' at '${this.label(rec)}' becomes a page switcher (${(rec.k || []).length} page(s))`
      );
    } else if (kind === 'grid') {
      const tracks = style.gridColumns || [];
      const first = tracks.length ? tracks[0].px : undefined;
      const uniform =
        tracks.length >= 2 &&
        first !== undefined &&
        tracks.every((t) => t.px !== undefined && Math.abs(t.px - first) < 1);
      cls = uniform ? CLASS.UNIFORM_GRID : CLASS.GRID;
      nodeKind = uniform ? 'uniform-grid' : 'grid';
      orientation = 'grid';
      // UMG's GridPanel sizes a column from its widest cell, so a CSS track of 148px collapses to
      // whatever the cell's content needs (measured: 83px). Pin every cell whose track has a px
      // size to that width; fr / auto tracks stay content-driven.
      const columns = Math.max(1, tracks.length);
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== 'el' || !item.style) continue;
        const explicit = Number.parseInt(item.style.gridColumnStart, 10);
        const column = Number.isFinite(explicit) && explicit > 0 ? explicit - 1 : i % columns;
        const track = tracks[column];
        // mapChildren re-reads the style from the record, so the pin has to travel on the record
        // rather than on the item's style object.
        if (track && track.px !== undefined && item.rec) {
          item.rec.h2uGridTrackWidth = V.round(track.px, 2);
        }
      }
    } else if (kind === 'flex') {
      if (style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse') {
        // responsive: the runtime subclass recomputes its desired HEIGHT from the width it was last
        // arranged at, so the column count (and therefore the height a parent sees) follows the
        // viewport. A plain WrapBox can only report the design-time WrapSize it was born with.
        // Plain WrapBox: SWrapBox writes the allotted width into PreferredSize from its Tick, and
        // that attribute invalidates layout, so the row count and the reported height both settle
        // on the second frame (verified: 592 stay at 1920, 896 at 1280, no runtime widget needed).
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
    } else if (kind === 'tablerow') {
      cls = CLASS.HORIZONTAL;
      nodeKind = 'hbox';
      orientation = 'h';
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

    // A VerticalBox child's height comes from its own content, and any per-element error then
    // accumulates down the column. A long document drifted 660px over 7081px that way. The browser
    // already measured each child, so the measured height is pinned on the record and read back by
    // readStyle; fr/百分比 children and absolute ones keep their own sizing.
    if (cls === CLASS.VERTICAL && this.opts.pinFlowHeights !== false) {
      for (const item of items) {
        if (item.kind !== 'el' || !item.rec || !item.rec.rect) continue;
        if (item.style && item.style.isAbs) continue;
        // A child that fills the remaining space (flex-grow / percentage height) must keep filling:
        // pinning it to the design height would freeze a layout that is meant to stretch, which cost
        // a dashboard page 5 points when every child was pinned.
        if (item.style && (item.style.flexGrow > 0 || item.style.percentHeight !== null)) continue;
        const height = item.rec.rect[3];
        if (height >= 1) item.rec.h2uFlowHeight = V.round(height, 2);
      }
    }

    const children = this.mapChildren(items, ctx, orientation, name, base);
    // An empty container is noise in the Designer: only keep it if it carries
    // children. (Decorations still survive through their Border/SizeBox wrapper.)
    if (!children.length) return null;

    const node = this.makeNode(name, cls, rec);
    node.children = children;
    const properties = this.containerProperties(cls, style, rec);
    if (properties) node.properties = properties;
    this.meta.set(node, { rec, style, kind: nodeKind });
    // --- responsive: express main-axis centring as a real Overlay -------------------------
    // The exact mode bakes the leftover space as a top/left padding on the first child, which is
    // correct only at the measured width. An Overlay slot centres for real, so one WBP keeps
    // working at other sizes.
    // responsive: a column child with width:N% becomes [spacer, child, spacer] in a row.
    let pctWrapped = false;
    if (this.responsiveMode() && cls === CLASS.VERTICAL) {
      node.children = node.children.map((child) => {
        const wrapped = this.wrapCrossAxisPercent(child);
        if (wrapped) pctWrapped = true;
        // Never a silent drop: if the row could not be built, crossAxisPercentPx()'s pin stays
        // and the fallback explains why.
        return wrapped || this.pinCrossAxisPercent(child);
      });
    }
    // The Overlay rewrite below must read node.children (post-wrap), not the stale pre-wrap array:
    // it used to take `children[0]`, so a spacer row was silently discarded and the box came out
    // with no width at all. A row may still be re-parented into the Overlay - its Fill weights
    // encode the HORIZONTAL share, while the Overlay is what makes the column's main-axis
    // justify-content continuous - but it has to keep the full cross extent, so the slot below is
    // forced to Fill on that axis.
    if (this.responsiveMode() && node.children.length === 1 &&
        (cls === CLASS.VERTICAL || cls === CLASS.HORIZONTAL) &&
        /^(center|flex-end|end|right)$/.test(String(style.justify || ''))) {
      const child = node.children[0];
      const vertical = cls === CLASS.VERTICAL;
      const justify = String(style.justify || '');
      const cross = String(style.alignItems || 'normal');
      // An Overlay slot can only align: it has no Fill weight, so a child that FILLS the main axis
      // (flex-grow / main-axis percentage / a clamp stack that measures that axis) would lose
      // the stretch it needs. Leave the box alone and say so - centring it is cosmetic next to
      // silently dropping a size.
      const cm = this.meta.get(child) || {};
      const cstyle = cm.style || {};
      const mainPercent = vertical ? cstyle.percentHeight : cstyle.percentWidth;
      const relOwnsMain = !!(cm.rel && (vertical ? cm.rel.height : cm.rel.width));
      const fillsMain =
        (cstyle.flexGrow || 0) > 0 ||
        (mainPercent !== null && mainPercent !== undefined && mainPercent > 0) ||
        relOwnsMain;
      if (fillsMain) {
        this.infoOnce(
          `layout: '${this.label(cm.rec || rec)}' fills its parent's ${vertical ? 'column' : 'row'} main axis, so justify-content:${justify} stays a box slot (an Overlay slot would drop the stretch)`
        );
      } else {
        const centred = (value, axisEnd) => (/center/.test(value) ? 'Center' : axisEnd.test(value) ? (axisEnd.horizontal ? 'Right' : 'Bottom') : null);
        const hCross = centred(cross, { horizontal: true, test: s => /(end|flex-end|right)/.test(s) });
        const vCross = centred(cross, { horizontal: false, test: s => /(end|flex-end|bottom)/.test(s) });
        const hJustify = /center/.test(justify) ? 'Center' : 'Right';
        const vJustify = /center/.test(justify) ? 'Center' : 'Bottom';
        const slot = {
          HorizontalAlignment: vertical ? (hCross || 'Fill') : hJustify,
          VerticalAlignment: vertical ? vJustify : (vCross || 'Fill'),
        };
        // A wrapper that measures the space it is ALLOTTED (spacer row, clamp stack) must keep
        // the parent's full cross extent; the centring it encodes lives inside the wrapper.
        if (cm.kind === 'relbox' || cm.kind === 'pct-row' || pctWrapped) {
          if (vertical) slot.HorizontalAlignment = 'Fill';
          else slot.VerticalAlignment = 'Fill';
        }
        // The clamp stack's CanvasPanel needs the parent's whole box on BOTH axes: its percentage
        // anchors are meaningless in a canvas that was shrunk to its (zero) content size, and the
        // element it holds centres itself inside the SizeBox.
        if (cm && cm.keepSlot) {
          slot.HorizontalAlignment = 'Fill';
          slot.VerticalAlignment = 'Fill';
        }
        node.class = CLASS.OVERLAY;
        node.properties = undefined;
        delete node.properties;
        node.children = [child];
        child.slot = slot;
        if (cm) cm.overlaySlot = slot;
        this.meta.set(node, { rec, style, kind: 'overlay-center' });
      }
    }
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

  containerProperties(cls, style, rec) {
    const props = {};
    if (cls === CLASS.UNIFORM_GRID) {
      const gx = V.round((style.columnGap || 0) / 2, 2);
      const gy = V.round((style.rowGap || 0) / 2, 2);
      if (gx || gy) props.SlotPadding = [gx, gy, gx, gy];
    } else if (cls === CLASS.WRAP) {
      props.InnerSlotPadding = [V.round(style.columnGap || 0, 2), V.round(style.rowGap || 0, 2)];
      // `WrapSize` is the DESIGN content width of this container - not 0, and not the engine default.
      //
      // SWrapBox drives BOTH ComputeDesiredSize and the child arranger from `PreferredSize`
      // (SWrapBox.cpp:227 `WidthOfCurrentLine = WrapBox.PreferredSize`), and UWrapBox maps
      // `WrapSize -> PreferredSize` (WrapBox.cpp:65-72). `bUseAllottedSize` (passed as
      // `!bExplicitWrapSize`) only makes Tick overwrite that value with the allotted width, i.e. it
      // fixes ARRANGE after the first pass but never the desired size. Measured:
      //   WrapSize = 0        -> desired = one column   (12-responsive cards: 1226px tall)
      //   engine default 500  -> a 460px card per row   (8 rows / 896px)
      //   design content width-> 3 cards per row = 458px, which is what the browser reports
      // In BOTH modes: this is an engine-default trap, not a responsive feature - a fixed-size design
      // is just as wrong when the panel silently wraps at 500px.
      props.bExplicitWrapSize = false;
      const wrapSize = this.contentBoxWidth(rec, style);
      if (wrapSize > 0) props.WrapSize = wrapSize;
    } else if (cls === CLASS.GRID) {
      // TArray<float>: star tracks must stay proportional inside GridPanel.
      const fr = style.gridFrColumns || [];
      if (fr.length && fr.every((v) => v > 0)) props.ColumnFill = fr;
    }
    return Object.keys(props).length ? props : null;
  }

  mapChildren(items, ctx, orientation, ownerName, ownerBase) {
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
        // A bare text run belongs to the container element, so it is named from that
        // element's OWN base ("Item_1_Text"), not from the container widget's composed
        // name ("Item_1_Inner_Text").
        const suffix = textIndex === 1 ? ROLE_SUFFIX.text : `${ROLE_SUFFIX.text}${textIndex}`;
        const generated = this.names.unique(`${ownerBase || ownerName || 'Text'}${suffix}`);
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
    // A gradient background was rasterised by the bake pass (see bake.js
    // bakePaint): the texture already carries the gradient, the rounded corners and
    // the border, so it replaces the tint/outline combination entirely.
    const bakedPaint = this.bakedFor(rec);
    if (bakedPaint && bakedPaint.shadow) {
      // A shadow bake already contains the element's own background and border, drawn over the
      // expanded rect, so it replaces every other brush on this node.
      const shaded = this.bakedBrush(bakedPaint.shadow);
      if (shaded) return shaded;
    }
    if (bakedPaint && bakedPaint.paint) {
      const painted = this.bakedBrush(bakedPaint.paint);
      if (painted) return painted;
    }
    const hasRadius = radii.some((r) => r > 0);
    const texture = style.bgImage.urls.length
      ? this.assets && this.assets.addFromUrl(style.bgImage.urls[0], { label: `background-image on '${this.label(rec)}'` })
      : null;

    // One Slate outline for four CSS sides: outlinePolicy reports the collapse.
    const effective = policy || this.outlinePolicy(this.sidesFromStyle(style), this.label(rec), 'border');
    const outlined = effective.width > 0;

    if (texture) {
      brush.drawAs = 'Image';
      brush.texture = `@${texture.key}`;
      brush.tiling = 'NoTile';
      if (style.bgSize.mode === 'cover' || style.bgSize.mode === 'contain') {
        this.warn(`approximated: background-size:${style.bgSize.mode} on '${this.label(rec)}' stretched to the box`);
      }
    } else {
      // A plain Box brush (the 9-slice path) draws its fill and NOTHING else: FSlateBrush's
      // OutlineSettings is only consumed by the rounded-box shader. An element with a border and
      // no corner radius therefore lost its border completely (measured: a 6px border rendered as
      // no border at all, 14.5% of that swatch wrong). RoundedBox with zero radii is a rectangle,
      // so the outline exists as soon as there is a border.
      brush.drawAs = hasRadius || outlined ? 'RoundedBox' : 'Box';
    }
    if (hasRadius || (outlined && brush.drawAs === 'RoundedBox')) brush.cornerRadii = radii;
    brush.tint = style.backgroundColor || [0, 0, 0, 0];

    if (outlined) {
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
