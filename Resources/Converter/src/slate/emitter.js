'use strict';

/**
 * layout.json -> Slate C++ source.
 *
 * The UMG path bakes colour changes into textures: a button's hover/pressed colours, a checkbox's
 * track and knob, a gradient. Slate does not need that, because Slate draws from FSlateBrush values
 * that are CONSTRUCTED IN CODE. The layout JSON already holds exactly those values - brush.tint,
 * cornerRadii, outlineWidth and WidgetStyle.Normal/Hovered/Pressed are FSlateBrush fields - so this
 * emitter writes them as C++ expressions instead of loading a PNG.
 *
 * Real design images (an <img>, a background-image) stay textures and are referenced by the UObject
 * path from the layout's asset list.
 *
 * Two JSON dialects are accepted, because the tool emits both: the converter writes nested objects
 * (properties.Font.Size) and the WBP exporter writes dotted keys ('Font.Size'). normalize.pget()
 * tries the dotted key first, then walks the nested path.
 */

const N = require('./normalize');
const HELPER = require('./helper');

const H = N.ALIGN_H;
const V = N.ALIGN_V;

function kindOf(cls) {
  const c = String(cls || '');
  if (/Switcher/.test(c)) return 'switcher';
  if (/CanvasPanel/.test(c)) return 'canvas';
  if (/Overlay/.test(c)) return 'overlay';
  if (/VerticalBox|HorizontalBox/.test(c)) return 'box';
  if (/ScrollBox/.test(c)) return 'scroll';
  if (/TextBlock/.test(c)) return 'text';
  if (/Image/.test(c)) return 'image';
  if (/Spacer/.test(c)) return 'spacer';
  if (/Button/.test(c)) return 'button';
  if (/ComboBox/.test(c)) return 'combo';
  if (/CheckBox/.test(c)) return 'check';
  if (/Slider/.test(c)) return 'slider';
  if (/ProgressBar/.test(c)) return 'progress';
  if (/EditableTextBox/.test(c)) return 'edit';
  if (/SpinBox/.test(c)) return 'spin';
  if (/Border|SizeBox|ScaleBox|NamedSlot/.test(c)) return 'single';
  return 'other';
}

class SlateEmitter {
  constructor(layout, options) {
    const o = options || {};
    this.layout = layout || {};
    this.className = o.className || 'FH2USlatePage';
    this.assetRoot = String(o.assetRoot || '').replace(/\/+$/, '');
    this.warnings = [];
    this.brushExprs = [];
    this.initLines = [];
    this.styleInits = [];
    this.styleCount = 0;
    this.comboCount = 0;
    this.parentMode = 'single';
    this.comboInits = [];
    this.usesCombo = false;
    this.texByKey = new Map();
    const assets = this.layout.assets || {};
    for (const t of assets.textures || []) {
      const key = String(t.key || '');
      let source = String(t.source || '');
      if (!source && this.assetRoot && key) source = this.assetRoot + '/' + key + '.' + key;
      if (key && source) this.texByKey.set(key, source);
    }
  }

  radii(r) {
    const a = Array.isArray(r) ? r : [0, 0, 0, 0];
    return 'FVector4(' + N.f(a[0]) + ', ' + N.f(a[1]) + ', ' + N.f(a[2]) + ', ' + N.f(a[3]) + ')';
  }

  /** Register a brush expression; returns its index into BrushStore. */
  brushIndex(item, label) {
    if (!item) return -1;
    let expr;
    const key = item.texture ? String(item.texture) : '';
    if (key && this.texByKey.has(key)) {
      expr = 'H2USlate::TextureBrush(' + N.txt(this.texByKey.get(key)) + ', ' + N.lc(item.tint) + ', ' + this.radii(item.radii) + ')';
    } else {
      if (key) {
        N.warn(this.warnings, 'texture ' + key + ' (' + label + ') is not in the layout asset list; drawn as a flat fill');
      }
      expr = 'H2USlate::BoxBrush(' + N.lc(item.tint) + ', ' + this.radii(item.radii) + ', ' + N.f(item.outlineWidth) + ', ' + N.lc(item.outlineColor) + ')';
    }
    this.brushExprs.push(expr);
    return this.brushExprs.length - 1;
  }

  /** Four state brushes in code - the whole point of the Slate path: no baked hover/pressed PNG. */
  buttonStyle(props, label) {
    const normal = N.propsBrush(props, 'WidgetStyle.Normal');
    if (!normal) return -1;
    const names = ['Normal', 'Hovered', 'Pressed', 'Disabled'];
    const idx = {};
    for (const name of names) {
      const b = name === 'Normal' ? normal : N.propsBrush(props, 'WidgetStyle.' + name);
      idx[name] = this.brushIndex(b || normal, label + ' ' + name);
    }
    const lines = [];
    lines.push('{');
    lines.push('    TSharedPtr<FButtonStyle> Style = MakeShared<FButtonStyle>();');
    for (const name of names) lines.push('    Style->' + name + ' = *BrushStore[' + idx[name] + '];');
    lines.push('    StyleStore.Add(Style);');
    lines.push('}');
    this.styleInits.push(lines.join('\n'));
    return this.styleCount++;
  }

  canvasSlot(node) {
    const ld = node.slot && node.slot.LayoutData;
    if (!ld) return null;
    const a = ld.Anchors || { Minimum: [0, 0], Maximum: [0, 0] };
    const o = ld.Offsets || { Left: 0, Top: 0, Right: 0, Bottom: 0 };
    const al = ld.Alignment || [0, 0];
    let out = 'SConstraintCanvas::Slot()';
    out += '.Anchors(FAnchors(' + N.f(a.Minimum[0]) + ', ' + N.f(a.Minimum[1]) + ', ' + N.f(a.Maximum[0]) + ', ' + N.f(a.Maximum[1]) + '))';
    out += '.Offset(FMargin(' + N.f(o.Left) + ', ' + N.f(o.Top) + ', ' + N.f(o.Right) + ', ' + N.f(o.Bottom) + '))';
    out += '.Alignment(FVector2D(' + N.f(al[0]) + ', ' + N.f(al[1]) + '))';
    out += '.AutoSize(' + (node.slot.bAutoSize === true ? 'true' : 'false') + ')';
    return out;
  }

  /**
   * FMargin for a slot. When the parent is a box panel and the measured gap is known, the gap WINS:
   * the design's own margin is already baked into the measured positions, so adding both would count
   * it twice.
   */
  paddingOf(node, gap) {
    const pad = Array.isArray(node.slot && node.slot.Padding) ? node.slot.Padding : [0, 0, 0, 0];
    const margin = [pad[0] || 0, pad[1] || 0, pad[2] || 0, pad[3] || 0];
    if (gap) {
      // The gap already includes everything the design put between two rows, so the CSS margins are
      // replaced rather than added - keeping the trailing margin would count that space twice (the
      // next child's gap would then start after it again).
      margin[0] = 0;
      margin[1] = 0;
      margin[2] = 0;
      margin[3] = 0;
      if (gap.vertical) margin[1] = gap.leading;
      else margin[0] = gap.leading;
    }
    return margin.some((v) => Math.abs(v) > 0.01)
      ? 'FMargin(' + N.f(margin[0]) + ', ' + N.f(margin[1]) + ', ' + N.f(margin[2]) + ', ' + N.f(margin[3]) + ')'
      : null;
  }

  /**
   * Box slot built from the MEASURED gap, not from the CSS padding chain.
   *
   * Pinning sizes alone was not enough: a box panel stacks its children, so any row whose height
   * differs from the design shifts every row below it - the "nothing lines up" symptom. The gap
   * between two neighbouring nodes is known from their rects, and consuming it as slot padding puts
   * every child on its designed position regardless of what Slate gives the previous one.
   */
  boxSlot(node, vertical, gap) {
    const s = node.slot || {};
    let out = vertical ? 'SVerticalBox::Slot()' : 'SHorizontalBox::Slot()';
    const pad = this.paddingOf(node, gap);
    if (pad) out += '.Padding(' + pad + ')';
    out += '.HAlign(' + (H[s.HorizontalAlignment] || 'HAlign_Fill') + ')';
    out += '.VAlign(' + (V[s.VerticalAlignment] || 'VAlign_Fill') + ')';
    // The size rule is ALWAYS stated. A bare SVerticalBox::Slot() is a FILL slot, not an auto one, so
    // relying on the default made every row share the panel's leftover height equally: measured with a
    // probe of three 40px boxes in a 300px panel they came out 92px each, and on a real page each row
    // grew ~4px and every row below drifted further (60px step where the design says 56).
    const size = s.Size || {};
    if (size.SizeRule === 'Fill') {
      const weight = N.f(size.Value === undefined ? 1 : size.Value);
      out += vertical ? '.FillHeight(' + weight + ')' : '.FillWidth(' + weight + ')';
    } else {
      out += vertical ? '.AutoHeight()' : '.AutoWidth()';
    }
    return out;
  }

  overlaySlot(node) {
    const s = node.slot || {};
    let out = 'SOverlay::Slot()';
    const pad = this.paddingOf(node);
    if (pad) out += '.Padding(' + pad + ')';
    out += '.HAlign(' + (H[s.HorizontalAlignment] || 'HAlign_Fill') + ')';
    out += '.VAlign(' + (V[s.VerticalAlignment] || 'VAlign_Fill') + ')';
    return out;
  }

  /** Join children with the child-slot prefix the parent panel wants. */
  children(node, indent, mode) {
    const kids = node.children || [];
    if (!kids.length) return '';
    const parts = [];
    const pad = indent + '    ';
    const previousMode = this.parentMode;
    this.parentMode = mode;
    // Running end of the previous child on the main axis, so each slot's leading gap can be measured.
    const parentRect = Array.isArray(node.rect) ? node.rect : null;
    let mainEnd = null;
    for (const kid of kids) {
      const body = pad + this.pin(kid, pad, this.node(kid, pad));
      if (mode === 'single') {
        parts.push(body);
        continue;
      }
      let gap = null;
      if ((mode === 'vbox' || mode === 'hbox') && Array.isArray(kid.rect)) {
        const vertical = mode === 'vbox';
        // The FIRST child gets no gap: the parent's own padding/border already put it where the design
        // measured it, and measuring from the parent's rect counted that padding a second time (the
        // first row landed 17px low). Only the distance between two consecutive children is a number
        // the parent does not already apply.
        // Always expressed as a gap, the first child included (leading 0). Keeping the CSS margin on the
        // first slot as well as the measured gap on the next one counted the same 12px twice, which is
        // why the rows marched down the page.
        const lead = mainEnd === null ? 0 : (vertical ? kid.rect[1] : kid.rect[0]) - mainEnd;
        gap = { vertical: vertical, leading: Math.max(0, Math.round(lead * 100) / 100), from: mainEnd, to: kid.rect[1], who: kid.name };
        if (process.env.HTML2UMG_DEBUG_SLATE) N.warn(this.warnings, 'slate gap ' + node.name + ' -> ' + kid.name + ' = ' + gap.leading + ' (from ' + mainEnd + ' to ' + kid.rect[1] + ')');
        mainEnd = vertical ? kid.rect[1] + kid.rect[3] : kid.rect[0] + kid.rect[2];
      }
      if (mode === 'canvas') {
        const slot = this.canvasSlot(kid);
        if (!slot) {
          N.warn(this.warnings, 'canvas child ' + kid.name + ' has no LayoutData; skipped');
          continue;
        }
        parts.push(indent + '+ ' + slot + '\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      } else if (mode === 'vbox' || mode === 'hbox') {
        const slot = this.boxSlot(kid, mode === 'vbox', gap);
        parts.push(indent + '+ ' + slot + '\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      } else if (mode === 'overlay') {
        parts.push(indent + '+ ' + this.overlaySlot(kid) + '\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      } else if (mode === 'switcher') {
        parts.push(indent + '+ SWidgetSwitcher::Slot()\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      } else if (mode === 'scroll') {
        parts.push(indent + '+ SScrollBox::Slot()\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      }
    }
    this.parentMode = previousMode;
    if (mode === 'single' && kids.length > 1) {
      // The design stacks several children inside a single-child container: stack them explicitly
      // instead of silently dropping all but the first.
      const stacked = parts.map((body) => indent + '+ SVerticalBox::Slot()\n' + indent + '  [\n' + body + '\n' + indent + '  ]');
      return indent + 'SNew(SVerticalBox)\n' + stacked.join('\n');
    }
    return parts.join('\n');
  }

  /** The expression for one node, including its own widget arguments. */
  node(node, indent) {
    const cls = String(node.class || '');
    const kind = kindOf(cls);
    const props = node.properties || {};
    const name = String(node.name || '');
    const kids = node.children || [];
    const br = (item) => {
      const i = this.brushIndex(item, name);
      return i < 0 ? 'nullptr' : 'Brush(' + i + ')';
    };
    // The converter keeps a node's paint on the NODE (node.brush); the WBP exporter flattens it into
    // properties (Background.*). Reading only properties silently dropped every container fill in the
    // converter dialect, which drew the whole page black because nothing was painted underneath.
    const nodeBrush = N.normBrush(node.brush);


    // A single-child container takes its child inside [...]; a panel takes "+ Slot()[...]" lines
    // directly after the SNew, which is how the engine itself writes them.
    const wrapChild = (head, body) => {
      if (!body) return head;
      return head + '\n' + indent + '[\n' + body + '\n' + indent + ']';
    };
    const wrapSlots = (head, slots) => {
      if (!slots) return head;
      return head + '\n' + slots;
    };

    if (kind === 'text') {
      const font = {
        path: N.pget(props, 'Font.FontObject'),
        size: Number(N.pget(props, 'Font.Size')),
        typeface: String(N.pget(props, 'Font.TypefaceFontName') || 'Regular'),
        spacing: Number(N.pget(props, 'Font.LetterSpacing') || 0),
      };
      if (!Number.isFinite(font.size) || font.size <= 0) font.size = 12;
      let out = 'SNew(STextBlock)';
      out += '\n' + indent + '.Text(FText::FromString(' + N.txt(String(props.Text !== undefined ? props.Text : '')) + '))';
      out += '\n' + indent + '.Font(H2USlate::Font(' + (font.path ? N.txt(font.path) : 'nullptr') + ', ' + N.f(font.size) + ', FName(' + N.txt(font.typeface) + '), ' + String(font.spacing || 0) + '))';
      const col = N.pget(props, 'ColorAndOpacity');
      if (Array.isArray(col)) out += '\n' + indent + '.ColorAndOpacity(FSlateColor(' + N.lc(col) + '))';
      const just = N.pget(props, 'Justification');
      if (just && N.JUSTIFY[just]) out += '\n' + indent + '.Justification(' + N.JUSTIFY[just] + ')';
      if (N.pget(props, 'AutoWrapText') === true) out += '\n' + indent + '.AutoWrapText(true)';
      const lhp = Number(N.pget(props, 'LineHeightPercentage'));
      if (Number.isFinite(lhp) && Math.abs(lhp - 1) > 0.0005) out += '\n' + indent + '.LineHeightPercentage(' + N.f(lhp) + ')';
      return out;
    }

    if (kind === 'image') {
      const b = nodeBrush || N.propsBrush(props, 'Brush') || N.propsBrush(props, 'Background');
      let out = 'SNew(SImage)';
      if (b) out += '\n' + indent + '.Image(' + br(b) + ')';
      return out;
    }

    if (kind === 'spacer') return 'SNew(SSpacer)';

    if (kind === 'single') {
      const inner = this.children(node, indent + '    ', 'single');
      if (/Border/.test(cls)) {
        const b = nodeBrush || N.propsBrush(props, 'Background');
        let head = 'SNew(SBorder)';
        if (b) head += '\n' + indent + '.BorderImage(' + br(b) + ')';
        // Always explicit: a Border that omits .Padding() did not land where the design put it
        // (measured: the root border inset its child by 2px on every side, shifting the whole page).
        const pad = Array.isArray(N.pget(props, 'Padding')) ? N.pget(props, 'Padding') : [0, 0, 0, 0];
        head += '\n' + indent + '.Padding(FMargin(' + N.f(pad[0] || 0) + ', ' + N.f(pad[1] || 0) + ', ' + N.f(pad[2] || 0) + ', ' + N.f(pad[3] || 0) + '))';
        return wrapChild(head, inner);
      }
      if (/SizeBox/.test(cls)) {
        const over = (key, arg) => {
          const v = Number(N.pget(props, key));
          return Number.isFinite(v) && v > 0 ? '\n' + indent + '.' + arg + '(' + N.f(v) + ')' : '';
        };
        const head = 'SNew(SBox)' + over('MinDesiredWidth', 'MinDesiredWidth') + over('MinDesiredHeight', 'MinDesiredHeight') + over('MaxDesiredWidth', 'MaxDesiredWidth') + over('MaxDesiredHeight', 'MaxDesiredHeight');
        return wrapChild(head, inner);
      }
      if (/ScaleBox/.test(cls)) {
        const head = 'SNew(SScaleBox).Stretch(EStretch::ScaleToFit).StretchDirection(EStretchDirection::DownOnly)';
        return wrapChild(head, inner);
      }
      if (/NamedSlot/.test(cls)) {
        N.warn(this.warnings, 'NamedSlot ' + name + ' has no Slate counterpart; emitted as an SBox placeholder');
        return wrapChild('SNew(SBox)', inner);
      }
      N.warn(this.warnings, 'class ' + cls + ' (' + name + ') has no Slate mapping; emitted as an SBox container');
      return wrapChild('SNew(SBox)', inner);
    }

    if (kind === 'button') {
      const styleIdx = this.buttonStyle(props, name);
      let head = 'SNew(SButton)';
      if (styleIdx >= 0) head += '\n' + indent + '.ButtonStyle(Style(' + styleIdx + '))';
      head += '\n' + indent + '.ContentPadding(FMargin(0.0f))';
      return wrapChild(head, this.children(node, indent + '    ', 'single'));
    }

    if (kind === 'canvas') return wrapSlots('SNew(SConstraintCanvas)', this.children(node, indent + '    ', 'canvas'));
    if (kind === 'overlay') return wrapSlots('SNew(SOverlay)', this.children(node, indent + '    ', 'overlay'));
    if (kind === 'vbox' || (kind === 'box' && /VerticalBox/.test(cls))) return wrapSlots('SNew(SVerticalBox)', this.children(node, indent + '    ', 'vbox'));
    if (kind === 'box') return wrapSlots('SNew(SHorizontalBox)', this.children(node, indent + '    ', 'hbox'));
    if (kind === 'switcher') {
      const idx = Number(N.pget(props, 'ActiveWidgetIndex'));
      let head = 'SNew(SWidgetSwitcher)';
      if (Number.isFinite(idx) && idx > 0) head += '\n' + indent + '.WidgetIndex(' + Math.round(idx) + ')';
      return wrapSlots(head, this.children(node, indent + '    ', 'switcher'));
    }
    if (kind === 'scroll') return wrapSlots('SNew(SScrollBox)', this.children(node, indent + '    ', 'scroll'));

    if (kind === 'slider') {
      let out = 'SNew(SSlider)';
      for (const key of ['Value', 'MinValue', 'MaxValue']) {
        const v = Number(N.pget(props, key));
        if (Number.isFinite(v)) out += '\n' + indent + '.' + key + '(' + N.f(v) + ')';
      }
      const bar = N.pget(props, 'SliderBarColor');
      const handle = N.pget(props, 'SliderHandleColor');
      // The layout records the slider skin's own geometry: the bar's thickness and the thumb's fixed
      // size. A thumb drawn from a stretched brush is a rounded SQUARE, not the round handle the design
      // shows, so both are taken from the layout and the thumb gets a radius of half its size.
      const style = N.pget(props, 'WidgetStyle') || {};
      const barThickness = Number(style.BarThickness) || Number((node.rect || [])[3]) || 20;
      const thumbSize = (style.NormalThumbImage && Array.isArray(style.NormalThumbImage.imageSize))
        ? style.NormalThumbImage.imageSize
        : null;
      const thumbW = thumbSize ? Number(thumbSize[0]) : barThickness;
      const thumbH = thumbSize ? Number(thumbSize[1]) : barThickness;
      if (Array.isArray(bar)) out += '\n' + indent + '.SliderBarColor(' + N.lc(bar) + ')';
      if (Array.isArray(handle)) out += '\n' + indent + '.SliderHandleColor(' + N.lc(handle) + ')';
      // A colour alone does not paint: SSlider draws with FSliderStyle brushes, whose default is the
      // engine's own grey bar. Building the three states in code from the layout's colours is the
      // Slate equivalent of the UMG path's baked slider skin, without the texture.
      if (Array.isArray(bar) && Array.isArray(handle)) {
        const barR = N.round2(barThickness / 2);
        const thumbR = N.round2(Math.min(thumbW, thumbH) / 2);
        // The style's own bar is TRANSPARENT: the track and its fill are drawn underneath (see the
        // SOverlay composition below), and a visible bar here would cover them with a flat pill.
        const barIdx = this.brushIndex({ tint: [0, 0, 0, 0], radii: [barR, barR, barR, barR], outlineWidth: 0, outlineColor: [0, 0, 0, 0] }, name + ' bar');
        // The thumb keeps its own pixel size (a pill bar has no size of its own: it stretches).
        this.brushExprs.push('H2USlate::SizedBoxBrush(' + N.lc(handle) + ', FVector4(' + N.f(thumbR) + ', ' + N.f(thumbR) + ', ' + N.f(thumbR) + ', ' + N.f(thumbR) + '), FVector2D(' + N.f(thumbW) + ', ' + N.f(thumbH) + '))');
        const thumbIdx = this.brushExprs.length - 1;
        const sliderIdx = this.styleCount++;
        const block = [
          '{',
          '    TSharedPtr<FSliderStyle> S = MakeShared<FSliderStyle>();',
          '    S->NormalBarImage = *BrushStore[' + barIdx + '];',
          '    S->HoveredBarImage = *BrushStore[' + barIdx + '];',
          '    S->DisabledBarImage = *BrushStore[' + barIdx + '];',
          '    S->NormalThumbImage = *BrushStore[' + thumbIdx + '];',
          '    S->HoveredThumbImage = *BrushStore[' + thumbIdx + '];',
          '    S->DisabledThumbImage = *BrushStore[' + thumbIdx + '];',
          '    SliderStyleStore.Add(S);',
          '}',
        ];
        this.styleInits.push(block.join('\n'));
        // SSlider's argument is called Style, not SliderStyle.
        out += '\n' + indent + '.Style(SliderStyle(' + sliderIdx + '))';

        // FSliderStyle draws ONE bar behind the thumb and has no notion of a filled portion, so the
        // browser's two-tone track (filled up to the handle, then plain track) cannot be expressed by
        // the style alone. It is composed instead: a full-width track, a fill sized to the value, and
        // the slider itself on top so it still takes input. The fill colour is derived from the
        // layout's bar colour - the design's exact accent lives inside the baked skin, which this
        // path deliberately does not produce.
        const rect = Array.isArray(node.rect) ? node.rect : [0, 0, 0, 0];
        const minV = Number(N.pget(props, 'MinValue'));
        const maxV = Number(N.pget(props, 'MaxValue'));
        const valV = Number(N.pget(props, 'Value'));
        let ratio = 0.5;
        if (Number.isFinite(minV) && Number.isFinite(maxV) && Number.isFinite(valV) && maxV !== minV) {
          ratio = Math.min(1, Math.max(0, (valV - minV) / (maxV - minV)));
        }
        const fillTint = [bar[0], bar[1], bar[2], bar[3]];
        const trackTint = [bar[0] * 0.35, bar[1] * 0.35, bar[2] * 0.35, bar[3]];
        this.brushExprs.push('H2USlate::BoxBrush(' + N.lc(trackTint) + ', FVector4(' + N.f(barR) + ', ' + N.f(barR) + ', ' + N.f(barR) + ', ' + N.f(barR) + '), 0.0f, FLinearColor(0.0f, 0.0f, 0.0f, 0.0f))');
        const trackIdx = this.brushExprs.length - 1;
        this.brushExprs.push('H2USlate::BoxBrush(' + N.lc(fillTint) + ', FVector4(' + N.f(barR) + ', ' + N.f(barR) + ', ' + N.f(barR) + ', ' + N.f(barR) + '), 0.0f, FLinearColor(0.0f, 0.0f, 0.0f, 0.0f))');
        const fillIdx = this.brushExprs.length - 1;
        const fillW = N.round2(rect[2] * ratio);
        const built = [
          'SNew(SOverlay)',
          indent + '+ SOverlay::Slot().VAlign(VAlign_Center)[',
          indent + '    SNew(SBorder).BorderImage(Brush(' + trackIdx + ')).Padding(FMargin(0.0f))',
          indent + ']',
          indent + '+ SOverlay::Slot().VAlign(VAlign_Center).HAlign(HAlign_Left)[',
          indent + '    SNew(SBox).WidthOverride(' + N.f(fillW) + ')[',
          indent + '        SNew(SBorder).BorderImage(Brush(' + fillIdx + ')).Padding(FMargin(0.0f))',
          indent + '    ]',
          indent + ']',
          indent + '+ SOverlay::Slot()[',
          indent + '    ' + out.split('\n').join('\n' + indent + '    '),
          indent + ']',
        ].join('\n');
        return '(' + built + ')';
      }
      return (out);
    }

    if (kind === 'progress') {
      let out = 'SNew(SProgressBar)';
      const pct = Number(N.pget(props, 'Percent'));
      if (Number.isFinite(pct)) out += '\n' + indent + '.Percent(' + N.f(pct) + ')';
      const fill = N.pget(props, 'FillColorAndOpacity');
      if (Array.isArray(fill)) out += '\n' + indent + '.FillColorAndOpacity(' + N.lc(fill) + ')';
      return (out);
    }

    if (kind === 'edit') {
      let out = 'SNew(SEditableTextBox)';
      const text = N.pget(props, 'Text');
      if (typeof text === 'string') out += '\n' + indent + '.Text(FText::FromString(' + N.txt(text) + '))';
      N.warn(this.warnings, 'editable text box ' + name + ' uses the default style (its baked frame is not reproduced)');
      return (out);
    }

    if (kind === 'spin') {
      let out = 'SNew(SSpinBox<float>)';
      for (const key of ['Value', 'MinValue', 'MaxValue', 'Delta']) {
        const v = Number(N.pget(props, key));
        if (Number.isFinite(v)) out += '\n' + indent + '.' + key + '(' + N.f(v) + ')';
      }
      // The design's number is an integer, so the box must not pad it to "3.0": SSpinBox derives its
      // fractional digits from the step, which is 1 here.
      const step = Number(N.pget(props, 'Delta'));
      const value = Number(N.pget(props, 'Value'));
      const integer = (!Number.isFinite(step) || Math.abs(step - Math.round(step)) < 1e-6) &&
        (!Number.isFinite(value) || Math.abs(value - Math.round(value)) < 1e-6);
      if (integer) {
        // DefaultMinFractionalDigits is 1, which is why an integer rendered as "3.0".
        out += '\n' + indent + '.MinFractionalDigits(0)';
        out += '\n' + indent + '.MaxFractionalDigits(0)';
      }
      return (out);
    }

    if (kind === 'check') {
      const state = String(N.pget(props, 'CheckedState') || 'Unchecked');
      const checked = state === 'Checked' ? 'ECheckBoxState::Checked'
        : (state === 'Undetermined' ? 'ECheckBoxState::Undetermined' : 'ECheckBoxState::Unchecked');
      let out = 'SNew(SCheckBox)';
      out += '\n' + indent + '.IsChecked(' + checked + ')';
      N.warn(this.warnings, 'checkbox ' + name + ': FCheckBoxStyle track/knob brushes are not reproduced (default style)');
      return (out);
    }

    if (kind === 'combo') {
      const options = N.pget(props, 'DefaultOptions');
      if (!Array.isArray(options) || !options.length) {
        N.warn(this.warnings, 'combo box ' + name + ' has no options in the layout; emitted as an empty SComboBox');
        return ('SNew(SComboBox<TSharedPtr<FString>>)');
      }
      const slotName = 'ComboOptions' + this.comboCount;
      this.comboCount += 1;
      this.comboInits.push(slotName + '.Add(MakeShared<FString>(' + N.txt(String(N.pget(props, 'SelectedOption') || options[0])) + '));');
      for (const opt of options) {
        this.comboInits.push(slotName + '.Add(MakeShared<FString>(' + N.txt(String(opt)) + '));');
      }
      this.usesCombo = true;
      let out = 'SNew(SComboBox<TSharedPtr<FString>>)';
      out += '\n' + indent + '.OptionsSource(&' + slotName + ')';
      // Without an initial selection SComboBox has nothing to show and renders its "no content"
      // placeholder; the layout's SelectedOption is added first, so index 0 is the selected one.
      out += '\n' + indent + '.InitiallySelectedItem(' + slotName + '.Num() > 0 ? ' + slotName + '[0] : TSharedPtr<FString>())';
      out += '\n' + indent + '.OnGenerateWidget_Lambda([](TSharedPtr<FString> Item) { return SNew(STextBlock).Text(FText::FromString(Item.IsValid() ? *Item : FString())); })';
      return (out);
    }

    N.warn(this.warnings, 'class ' + cls + ' (' + name + ') has no Slate mapping; emitted as an SBox container');
    return wrapChild('SNew(SBox)', this.children(node, indent + '    ', 'single'));
  }

  /** One TArray member per combo box: SComboBox reads its items through a pointer. */
  comboMembers() {
    const out = [];
    for (let i = 0; i < this.comboCount; i += 1) {
      out.push('    TArray<TSharedPtr<FString>> ComboOptions' + i + ';');
    }
    return out;
  }

  /**
   * Pin one node to the box it measured at.
   *
   * The measured geometry IS the specification for a design-to-code generator, so pinning every node
   * is what removes the drift Slate layout introduces when a widget has no intrinsic size (a checkbox
   * row was 21px in the design and 32px in the render, and it accumulated down the page).
   */
  pin(nodeArg, indent, expr) {
    const r = nodeArg.rect;
    if (!Array.isArray(r) || r.length < 4) return expr;
    const slot = nodeArg.slot || {};
    const rule = (slot.Size && slot.Size.SizeRule) || 'Automatic';
    // Which axis the PANEL sizes automatically decides what has to be pinned:
    //   VerticalBox   -> height is auto (or Fill), width comes from the parent when aligned Fill
    //   HorizontalBox -> width is auto (or Fill), height comes from the tallest sibling
    //   Overlay/single-> the child is sized by its own desired size on both axes
    //   Canvas        -> the slot already carries the size
    // "VerticalAlignment: Fill" inside a HorizontalBox means "match the row height", NOT "the parent
    // gives me a height", so alignment alone is not a usable test.
    const mode = this.parentMode;
    let wantW = false;
    let wantH = false;
    if (mode === 'hbox') {
      wantW = rule !== 'Fill';
      wantH = slot.VerticalAlignment !== 'Fill';
    } else if (mode === 'vbox') {
      wantH = rule !== 'Fill';
      wantW = slot.HorizontalAlignment !== 'Fill';
    } else if (mode === 'overlay' || mode === 'single') {
      wantW = true;
      wantH = true;
    }
    let head = 'SNew(SBox)';
    if (wantW && Number(r[2]) > 0) {
      head += '\n' + indent + '.WidthOverride(' + N.f(r[2]) + ')';
    }
    if (wantH && Number(r[3]) > 0) {
      head += '\n' + indent + '.HeightOverride(' + N.f(r[3]) + ')';
    }
    const body = indent + '    ' + expr.split('\n').join('\n' + indent + '    ');
    return head + '\n' + indent + '[\n' + body + '\n' + indent + ']';
  }

  build() {
    const root = this.layout.root || {};
    const tree = '        ' + this.node(root, '        ');
    const brushInits = this.brushExprs.map((e, i) => '    BrushStore.Add(MakeShared<FSlateBrush>(' + e + '));');
    const comboInits = this.comboInits.map((line) => '    ' + line);
    // Styles live in their own store: FButtonStyle and FSliderStyle are different types, so Style(N)
    // cannot be shared between them.
    const inits = brushInits
      .concat(this.styleInits.map((block) => block.split('\n').map((l) => '    ' + l).join('\n')))
      .concat(comboInits);

    const header = [
      '#pragma once',
      '',
      '#include "CoreMinimal.h"',
      '#include "Widgets/SCompoundWidget.h"',
      '#include "Widgets/Layout/SBorder.h"',
      '#include "Widgets/Layout/SBox.h"',
      '#include "Widgets/Layout/SConstraintCanvas.h"',
      '#include "Widgets/Layout/SScaleBox.h"',
      '#include "Widgets/Layout/SScrollBox.h"',
      '#include "Widgets/Layout/SSpacer.h"',
      '#include "Widgets/Layout/SWidgetSwitcher.h"',
      '#include "Widgets/SBoxPanel.h"',
      '#include "Widgets/SOverlay.h"',
      '#include "Widgets/Text/STextBlock.h"',
      '#include "Widgets/Images/SImage.h"',
      '#include "Widgets/Input/SButton.h"',
      '#include "Widgets/Input/SCheckBox.h"',
      '#include "Widgets/Input/SEditableTextBox.h"',
      '#include "Widgets/Input/SSlider.h"',
      '#include "Widgets/Input/SSpinBox.h"',
      '#include "Widgets/Input/SComboBox.h"',
      '#include "Widgets/Notifications/SProgressBar.h"',
      '#include "Styling/SlateTypes.h"',
      '#include "H2USlate.h"',
      '',
      'class ' + this.className + ' : public SCompoundWidget',
      '{',
      'public:',
      '    SLATE_BEGIN_ARGS(' + this.className + ') {}',
      '    SLATE_END_ARGS()',
      '',
      '    void Construct(const FArguments& InArgs);',
      '',
      'private:',
      '    TArray<TSharedPtr<FSlateBrush>> BrushStore;',
      '    TArray<TSharedPtr<FButtonStyle>> StyleStore;',
      '    TArray<TSharedPtr<FSliderStyle>> SliderStyleStore;',
    ].concat(this.comboMembers(), [
      '',
      '    const FSlateBrush* Brush(int32 Index) const { return BrushStore[Index].Get(); }',
      '    const FButtonStyle* Style(int32 Index) const { return StyleStore[Index].Get(); }',
      '    const FSliderStyle* SliderStyle(int32 Index) const { return SliderStyleStore[Index].Get(); }',
      '};',
      '',
    ]).join('\n');

    const source = [
      '#include "' + this.className + '.h"',
      '',
      'void ' + this.className + '::Construct(const FArguments& InArgs)',
      '{',
      inits.join('\n'),
      '',
      '    ChildSlot',
      '    [',
      tree,
      '    ];',
      '}',
      '',
    ].join('\n');

    return { header: header, source: source, helper: HELPER, warnings: this.warnings.slice() };
  }
}

function emitSlate(layout, options) {
  return new SlateEmitter(layout, options).build();
}

module.exports = { SlateEmitter, emitSlate, kindOf };
