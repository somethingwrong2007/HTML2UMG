# HTML2UMG

Turn HTML/CSS designs into native UMG widget blueprints. No browser at runtime — the output is an
ordinary Widget Blueprint you can keep editing in the UMG Designer and bind to C++ or Blueprint
with `BindWidget`.

>中文版: [README.zh-CN.md](README.zh-CN.md)

```
design.html  --[Node + a local Chromium]-->  design.json  --[UE editor module]-->  WBP_Asset
             needed at convert time         diffable intermediate        zero runtime dependency
```

A full re-import overwrites **layout** changes made by hand in the Designer. To change layout, edit
the HTML (or the JSON); graph logic in the blueprint is untouched.

Deeper documentation lives in `Docs/`:

- `Html2UMG_Approach.md` — why this route, compared with the alternatives
- `Html2UMG_LayoutContract.md` — the complete JSON contract (read this before hand-writing JSON)
- `Html2UMG_ResponsiveContract.md` — how to write HTML/CSS that survives responsive conversion
- `Html2UMG_RelativeSize.md` — how `min(px, %)` / `clamp()` are reduced to run-time constraints
- `Html2UMG_Anchoring.md` — what each UMG positioning mechanism can and cannot express
- `Html2UMG_FontMetrics.md` — font metrics, line-height conversion, CJK typography

## Requirements

- Engine: Unreal Engine 5.8
- Editor platform: Windows
- Output platform: anything UMG supports
- Only the *HTML → JSON* step needs Node.js 22+ and any local Chromium browser (Edge / Chrome /
  Brave / Vivaldi). Importing an existing `.json` needs neither Node nor a browser.

## Install

1. Put the plugin in the project's `Plugins/Html2UMG/` and enable it in the `.uproject` plugin list.
2. Build:

```bat
"<EnginePath>\Engine\Build\BatchFiles\Build.bat" <Project>Editor Win64 Development \\
    -Project="<Project>.uproject" -WaitMutex
```

3. In the editor, confirm Edit > Plugins > Editor shows "HTML to UMG" enabled.

The entry point is Tools > HTML to UMG, or the console command `Html2UMG.Open`.

## Three ways to use it

### 1. The panel

Tools > HTML to UMG: pick an `.html`, optionally change the target blueprint path and viewport, then
Convert + Import. Picking the file converts it immediately, so you see warnings and the font list
before pressing Import — nothing pollutes the project early.

### 2. Command line: JSON only

```bat
node Plugins\Html2UMG\Resources\Converter\cli\convert.js design.html -o design.json ^
     --viewport 1920x1080 --probe 1440x1080,2560x1080 --shot design.png
```

| Option | Meaning |
|---|---|
| `-o, --out` | Output path, defaults to the input name with `.json` |
| `--viewport WxH` | Measurement viewport, default 1920x1080 |
| `--probe W1xH1,...` | Extra viewports, used to infer anchors |
| `--shot <png>` | Reference screenshot for fidelity comparison |
| `--blueprint <path>` | Overrides `data-ue-blueprint` |
| `--assets <dir>` | Texture/font output directory, default `assets` |
| `--layout <exact\|responsive>` | `exact` (default) bakes the design at `--viewport`; `responsive` emits constraints Slate resolves at run time |
| `--components <file.json>` | Component registry: CSS selectors → widget blueprint paths |
| `--scale-box <fit\|fill\|fitx\|fity>` | Wraps the root in a ScaleBox (common for full-screen menus, not for HUDs) |
| `--bake` / `--no-bake` | Bake native control parts into textures, on by default |
| `--bake-scale <n>` | Rasterisation scale for baked parts, default 2, max 4 |
| `--browser <exe>` | Use a specific browser |
| `--strict` | Exit 2 when any warning was produced (CI) |
| `--dump-snapshot <file>` | Dump the raw DOM snapshot for debugging |

Exit codes: 0 success, 1 failure, 2 warnings under `--strict`.

All output is **stock UMG** — the plugin ships no runtime module, so a converted blueprint keeps
working after the plugin is removed from the project.

### 3. Headless import

```bat
UnrealEditor-Cmd.exe <Project>.uproject -run=Html2UMG ^
    -html="D:\design.html" -blueprint="/Game/UI/WBP_Screen" ^
    -out-png="D:\umg.png" -unattended -nosplash
```

Or from Python:

```python
import unreal
opts = unreal.Html2UMGImportOptions()
opts.set_editor_property("blueprint_path", "/Game/UI/WBP_Screen")
opts.set_editor_property("import_fonts", True)
r = unreal.Html2UMGBlueprintLibrary.import_from_json(r"D:\design.json", opts)
print(r.success, r.widgets_created, r.properties_set)
```

UE strips the `b` prefix, so `bSuccess` is `success` in Python.

## What the HTML may look like

The converter reads computed style, not class names, so Tailwind, shadcn or any other source can be
fed in directly — no template convention required.

### Widget mapping

| HTML | UMG |
|---|---|
| `<div>` / layout container | `VerticalBox` / `HorizontalBox` / `WrapBox` / `CanvasPanel` / `GridPanel` |
| Text | `TextBlock` |
| `<img>` / `background-image` | `Border` or `Image` + imported texture |
| `<button>` | `UButton` (hover / pressed / disabled states) |
| `<input type=text>` | `EditableTextBox` |
| `<input type=number>` | **`SpinBox`**: `min`/`max`/`step`/`value` map to `MinValue`/`MaxValue`/`Delta`/`Value`; decimals are inferred (an integer field shows `45`, not `45.0`). The arrows come from `FSpinBoxStyle.ArrowsImage`, which the engine's default style already provides — the browser's spinner is UA-drawn and only appears on hover, so there is nothing to bake |
| `<textarea>` | Multi-line `EditableTextBox` |
| `<select>` | `ComboBoxString` (with options) |
| `<input type=checkbox>` | `CheckBox` (including checked state) |
| `<input type=range>` | `Slider` (min/max/value) |
| `<progress>` | `ProgressBar` |
| Absolutely positioned element | `CanvasPanel` child with anchors and offsets |

A native `<select>` accepts very little styling, so real designs draw dropdowns with divs;
`data-ue-control="combobox"` forces those into a real `UComboBoxString`.

**A "stepper" and a SpinBox are different things.** `<input type=number>` is a text field with a UA
spinner → `SpinBox` (arrows drawn by the engine style). The `−` value `＋` stepper in a design system
is **two buttons plus a text**, i.e. `Button` + `TextBlock`; the symbols are literal glyphs
(`−` U+2212 / `＋` U+FF0B) that follow the font, so no icon asset is involved.
`test/18-inputs.html` shows all three cases on one page.

### Reusing components you already imported

Three ways, from most convenient to most explicit:

| Approach | How | Result |
|---|---|---|
| **Registry** (recommended) | `--components test/components.json`, the page says `.slotcard` | Becomes a `WBP_SlotCard` instance |
| Explicit instance | `data-ue-widget="/Game/.../WBP_SlotCard"` | Same, overriding the registry for one element |
| Fragment | `data-ue-partial="fragments/x.html"` | An inline subtree (author-time reuse) |

A component page declares slots with `data-ue-named-slot="Body"`; a consuming page fills them with
`data-ue-slot="Body"`. Registry matching, slot filling and name-collision handling are described in
`Docs/Html2UMG_LayoutContract.md` §10.

Acceptance pages: `test/19a-slot-card.html` (a component with two slots) and
`test/19b-component-registry.html` (two instances, each filling different content).

### Styles

It is not only structure: the widgets' style structs are written into the asset — e.g.
`ComboBoxString`'s `WidgetStyle.ComboButtonStyle` and `ItemStyle` brushes, `CheckBox`'s
`UncheckedImage` / `CheckedImage`, `Slider`'s `NormalBarImage` / `NormalThumbImage` /
`BarThickness`, `ProgressBar`'s `FillImage`, and so on.

A button's four states are read from the page's `:hover` / `:active` / `:disabled` rules, so
hover and press look the way the HTML says. Click behaviour is not converted — put it in the graph.

### `data-*` attributes

| Attribute | Effect |
|---|---|
| `data-ue-name` | The generated widget name; this is what `BindWidget` matches |
| `data-ue-class` | Force a specific UMG class for the element. A **bare class name** works (`Overlay`, `CommonAnimatedSwitcher`): the importer tries `/Script/<every loaded module>.<Name>`; a full script path or a blueprint asset path works too |
| `data-ue-widget` | Reuse an existing widget blueprint (instance) |
| `data-ue-component` | Name a component from the registry |
| `data-ue-inline` | Force this element to expand instead of being reused |
| `data-ue-named-slot` | Declare a `NamedSlot` in a component page |
| `data-ue-slot` | Fill a `NamedSlot` from a consuming page |
| `data-ue-switcher` | Container whose children are switcher pages |
| `data-ue-variable="false"` | Do not create a blueprint variable |
| `data-ue-blueprint` | On the root element: target asset path |
| `data-ue-font-map` | On the root element: font family → font asset path |

## Anchors and responsivity

Anchors for absolutely positioned elements are inferred from multi-viewport probes, not by converting
pixel offsets into ratios. The deciding factor is the CSS edge constraint: `left:312px; right:40px`
is a horizontal stretch, while `left:25%` is a proportional anchor. Turning pixel constraints into
ratios happens to be right at the design resolution and drifts on every other device.

`SConstraintCanvas`'s formula (UE 5.8 `SConstraintCanvas.cpp`) is worth memorising — wrong anchors
almost always come from not following it:

```
point anchor: size = (Offsets.Right, Offsets.Bottom)
              pos  = anchorPx + Offsets.Left - size * Alignment
stretch:      pos  = anchorPx.Min + Offsets.Left
              size = anchorPx.Max - pos - Offsets.Right   // Right is a positive inset here
```

A single viewport cannot tell "left aligned" from "centred"; passing `--probe` with a few more
viewports is noticeably more accurate.

## Page switching: WidgetSwitcher, preferring the CommonUI variant

Tabbed / multi-page screens are usually "several pages in one spot, only one visible". Add
`data-ue-switcher` to the container and its **children become the pages**:

```html
<div class="viewer" data-ue-switcher data-ue-name="Viewer">
  <div class="on" data-ue-name="ViewerA">View A</div>
  <div data-ue-name="ViewerB">View B</div>
</div>
```

- Hidden pages (`display:none`) are **still measured**: the snapshot temporarily lays them out by
  their padding box and restores them immediately, so they arrive in UMG as complete pages with real
  layout rather than empty shells;
- `ActiveWidgetIndex` is the index of the page that was visible in the browser;
- The emitted class name is the semantic `PageSwitcher`; **the importer decides which engine class to
  use**, so the JSON stays project independent:

| Project state | Resolves to |
|---|---|
| CommonUI enabled (`CommonUIConfig` / `CommonUI`) | `/Script/CommonUI.CommonAnimatedSwitcher` (with page transitions) |
| Not enabled | `/Script/UMG.WidgetSwitcher` (fallback) |

The import log states which one was used. Both are `UWidgetSwitcher` subclasses with identical slot
semantics, so the layout does not fork on "has CommonUI".

## Animation: not converted, but reported honestly

CSS `transition` / `@keyframes` are out of scope. Not out of laziness: UMG motion is a
`UWidgetAnimation` (a Sequencer asset) driven from the graph, while the interesting part of CSS is
event-driven state transitions (hover/focus/press) — a static converter has nowhere to put that graph.
Generating only "enter/loop keyframes" would mean building tracks and bindings per widget, for far
less value than the complexity.

So it **reports** instead:

```
approximated: CSS motion is not converted - 2 rule(s) with transition (.tab, .btn); @keyframes spin. ...
```

It reads the **authored rules**, not computed style — a stabilisation stylesheet
(`* { transition: none !important }`) is injected before the snapshot, so computed values would never
show them.

Page transitions are a free exception: CommonUI's `CommonAnimatedSwitcher` animates page changes.

## Automatic naming

Priority: `data-ue-name` > `#id` > `class` > `tag`, converted to PascalCase, globally unique and
legal.

One element may become several widgets (`SizeBox` for size, `Border` for the background, a container
for content). **The main node gets the clean name** (`SettingsPanel`); the others get short role
suffixes: `_Box`, `_Inner`, `_BG`, `_Blur`, `_Scroll`, `_Row`, `_Flow`, `_Text`. A suffix is one
word and is **derived from the element's own name**, so they never stack:

```
good: SettingsPanel / SettingsPanel_Box / SettingsPanel_Inner
bad:  SettingsPanel_Size_PctWrap_Content_Text   (what old versions produced)
```

For anything you need to bind, set `data-ue-name` explicitly: that is the `BindWidget` key, so
renaming is a contract change.

**Re-importing into a blueprint that already has a graph** (events and variables already bound) needs
names kept verbatim: add `data-ue-name-verbatim` on the element, or pass `--name-verbatim` for the
whole page.

```html
<div data-ue-name="Button_Left" data-ue-name-verbatim>…</div>
```

Only then do `BndEvt__..._Button_Left_K2Node_ComponentBoundEvent_3` and a variable named
`TextBlock_Switch` survive; without it the name is PascalCased to `ButtonLeft`. A duplicate verbatim
name raises an error-level warning (the second becomes `Button_Left_1`, which breaks the binding just
as badly, so it must be loud). Acceptance page: `test/20-verbatim-names.html`.

## The widget tree gets simplified

The builder composes every element as `SizeBox -> Border -> [ScrollBox] -> content` plus role wrappers.
That is correct but deeper than it needs to be, so conversion ends with a pass that removes **only
layers it can prove change nothing**:

| Rule | Shape | Why it is exact |
|---|---|---|
| R1 | a `SizeBox` in a CanvasPanel slot | the slot's anchors + offsets already fix the rectangle and Slate ignores Width/HeightOverride there; kept unless the override agrees with the measured rect within 1px, and the hoisted child then computes an identical slot |
| R4 | a `SizeBox` with no override at all | a pure container, equal to its parent's slot |
| R5 | a `Border` that paints nothing (transparent brush, no padding, no clipping, no slider overhang) | it produces no pixels |

Two hard limits:

1. **Only generated role wrappers are removed** (`_Box`, `_BG`, `_Pad`, `_Inner`, `_Scroll`, ...). A name
   the author wrote (`data-ue-name` / `#id` / class) is a contract with the blueprint graph and is always
   kept - an earlier, looser rule also deleted author names like `BoxLeft` / `BoxRight`.
2. **A rounded box whose corner is saturated keeps its wrapper**: not removed when `drawAs=RoundedBox`
   and `maxCornerRadius + outlineWidth >= half the smaller side`.

The evidence for limit 2 (every row verified by a byte-for-byte render against `--no-simplify`, with every
widget's geometry bit-identical):

| Page | Wrapper | Size / radius / outline | After removal |
|---|---|---|---|
| 07-anchors | `RightBadge_Box` | 168x36, r18, o1 (18+1 >= 18) | 404 px moved (a ring at the edge) |
| 02-absolute | `StatusPill_Box` | 222x42, r20, o1 (20+1 >= 21) | 494 px moved |
| 02-absolute | `Floating_Box` | 12x12, r6, o0 (6 >= 6) | 52 px moved |
| all the rest | Chip 96x28 r6, CenterBox 360x140 r10, MaxBox 560x40 r8, AltBadge 206x66 r6, BottomBar 422x54 r8, and every non-RoundedBox brush | - | **byte-identical** |

In short: only a rounded box whose radius gets clamped changes its corner anti-aliasing when its
geometry chain changes. One known over-conservative case: `HalfBar` 960x8 r4 satisfies the test and is
kept, although removing it also measured identical - keeping a layer is the safe direction.

Result: 113 layers removed across the 26 component pages (`UpscalingBlock` 223 -> 164, -26%), and 1117 ->
1066 widgets across the fixtures. **All 11 affected pages render byte-identical to the unsimplified
build.** Use `--no-simplify` to reproduce the old output.

## Responsive: one WBP for many sizes

UMG has no flexbox, so "matches the browser" has two meanings and the converter has two modes:

| Mode | Fits | Behaviour |
|---|---|---|
| `--layout=exact` (default) | Fixed design (`html,body` with explicit size, all px) | Bakes at the design size. At other resolutions it **matches the browser**, because the browser does not reflow either (at 1280 it also just clips) |
| `--layout=responsive` | Fluid design (`%`, `flex`, `min/max-width`, two-sided `inset`) | Emits constraints Slate can resolve at run time; it really reflows |

No guessing needed: conversion prints `design: fluid (118/144 boxes rescale with the viewport)` and
records it in `settings.design`. Do not enable responsive for a `rigid` design, nor use exact for a
`fluid` one (measured: responsive on a fixed design degrades 1.4% → 16%; exact on a fluid design at
1280 degrades 2.7% → 34%).

### What each CSS construct becomes

| CSS | UMG |
|---|---|
| Fixed px | SizeBox + edge anchors |
| `width/height: %` | Box slot Fill weight, or a `[spacer][child][spacer]` row (cross axis of a column) |
| `flex: 1` | Fill weight |
| `min/max-width` | SizeBox Min/MaxDesired* (**desired size only**; ignored in a Fill slot at run time) |
| Two-sided `inset` | Canvas slot with a stretched anchor pair |
| Single-child `justify-content: center/end` | Overlay slot (real centring, instead of a baked offset) |
| `flex-wrap: wrap` | WrapBox (`InnerSlotPadding` is the only gap source; slot padding is zeroed) |
| Wrapping text | `AutoWrapText` (native, re-wraps at the allotted width on the second frame) |
| `min(1240px, 92vw)` / `clamp()` | `CanvasPanel` (proportional anchors) + `ScaleBox(ScaleToFit, DownOnly)` + `SizeBox` (clamped px), pure stock UMG |

`position: absolute` is measured against the **padding box** (per the CSS spec), so a container that
hosts a canvas gives its `Border.Padding` to the flow children and lets the CanvasPanel sit exactly on
the padding box — previously the canvas sat on the content box and every overlay was off by one
padding (measured: 24/96 px on 12-responsive).

### Runtime widgets: there are none

This used to ship three runtime widgets. Reading the engine source and measuring multiple frames
showed two were unnecessary — stock UMG already does it, just one frame later:

- `STextBlock::OnPaint` says "we may have been arranged in a different box than what we were cached
  with, which might update wrapping" — it re-wraps at the real allotted width while painting and calls
  `Invalidate(Layout)` when the measured size changed;
- `SWrapBox::Tick` writes the allotted width into `PreferredSize` when `bUseAllottedSize` (i.e.
  `bExplicitWrapSize` is false), and that property is declared `EInvalidateWidgetReason::Layout`, so
  the next prepass recomputes the row count.

Measured (79 CJK characters, SizeBox fixed at 432 wide):

| Group | Frame 1 | Frame 2 |
|---|---|---|
| `AutoWrapText`, no `WrapTextAt` | 17px (1 line, clipped) | **51px (3 lines)** |
| `WrapTextAt=432` | 51px | 51px |

So offline acceptance **must render two frames** (`Html2UMG.RenderFrames`, default 2). A single-frame
screenshot systematically under-measures auto-wrapped text and wrap boxes — that is how the
"text does not wrap / WrapBox height does not follow" conclusions were originally mis-derived.

The third widget is gone as well; the plugin now has **no runtime module at all**
(`Source/Html2UMGRuntime` deleted, no Runtime entry in the `.uplugin`):

| Removed widget | Why it is not needed |
|---|---|
| `H2UTextWrapBox` | `STextBlock::OnPaint` re-wraps and invalidates; settles on frame 2 |
| `H2UWrapBox` | `SWrapBox::Tick` writes the allotted width into `PreferredSize`; the prepass recomputes rows |
| `H2URelativeBox` | Replaced by `CanvasPanel(proportional anchors) → ScaleBox(DownOnly) → SizeBox(px) → content` |

### The mixed-unit size case

`width: 92%; max-width: 1240px` — "a percentage with a pixel clamp" — cannot be expressed by a single
UMG widget: the percentage comes from proportional canvas anchors (which lose the clamp), and the
clamp comes from `SizeBox.MaxDesiredWidth` (which only clamps the desired size and is ignored in a
Fill slot). Measured: a `MaxDesiredWidth=1240` SizeBox inside a 92% slot still came out **1766px** at
1920 — the clamp did nothing at all.

**Three nested layers do work** (and the converter emits them automatically, all stock UMG):

```
CanvasPanel      anchors 0.04..0.96       <- the percentage
  ScaleBox       ScaleToFit + DownOnly    <- shrinks, never magnifies
    SizeBox      WidthOverride=1240, HeightOverride=design height
      content
```

Measured box width: **1240 at 1920, 1177.6 at 1280, 1240 at 2560** — correct at every width.

The cost, stated plainly: below the clamp the content is scaled uniformly (0.9497× at 1280), while a
browser re-lays it out at 1177.6 with unchanged type size. So the pixel difference is 1.89% at 1920
and 10.31% at 1280 (a reflowing version of the same page scored 1.48% / 3.22%). This only matters for
text-dense content whose line breaks depend on width; for an image or a fixed grid under the clamp the
two are pixel-equal.

You can also design around it: percentage only (too wide on ultrawide) or a fixed centred column
(overflows when narrow). Many games' content columns are fixed-width, which makes mixed units
unnecessary.

### Measured fidelity (same WBP, only the render resolution changes; two-frame figures)

| Design | Mode | 1920×1080 | 1280×720 |
|---|---|---|---|
| Fluid (14-fluid-skyline) | responsive, contains `min()`, **zero runtime dependency (current)** | **1.89%** | **10.31%** |
| Fluid | old `H2URelativeBox` (deleted, for reference) | 1.48% | 3.22% |
| Fluid | old "fixed + centred" fallback (reference) | 1.48% | 10.08% |
| Fixed design | exact | 1.45% | 2.42% |
| Long-document page (12-responsive) | responsive, stock UMG only | 6.35% | 11.33% (see below) |

The fluid row deserves a look: the panel is `width: 92%; max-width: 1240px`, rendered at
`x=340 / w=1240` at 1920 and `x=51.2 / w=1177.6` at 1280 — matching the browser value for value. One
bake, right at two resolutions.

The 1280 figure for 12-responsive is not a layout problem: that page is about 1000px tall at 1280,
past the 720 viewport; the browser only captures what is visible while the WBP keeps drawing (it does
not scroll itself). The geometry is exact (`Cards` 992×616, `Zh` 430×66, `OverlayBar` 272/640/976/56).
Use 1920 (6.35%) to judge that page's real fidelity.

### Authoring conventions

To benefit from responsive conversion, the HTML needs some care (`%` / `flex` / `min-max`, a definite
width on text containers, two-sided `inset` for stretch, no fixed px on `body`); the full checklist is
in `Docs/Html2UMG_ResponsiveContract.md`. `test/14-fluid-skyline.html` is a fluid rewrite of a real
fixed-width design: **only CSS changed, not a single DOM node**, and its per-element difference at
1920×1080 is 0 while at 1280 the panel narrows instead of clipping.

### Known limits here

- **Two-frame convergence**: wrapped text and WrapBox rows/heights are correct on the second frame
  (engine behaviour). Invisible at run time, but **single-frame screenshot acceptance sees them
  short** — use `Html2UMG.RenderFrames` (default 2).
- **Mixed-unit sizes**: "percentage + px clamp" in `min()/max()/clamp()` has no single-widget
  expression (see above); the nesting is the workaround and it scales content instead of reflowing it.
- **Half-continuous cases**: percentage + clamp on the *main axis* of a flex row (a Fill share is not
  the parent width, so a percentage of it is 41% of 41%), `vw/vh` measured against the viewport while
  a widget multiplies its parent's allotment, and the padding difference between content box and
  border box — these are approximated with warnings.
- **Long pages do not scroll**: when content is taller than the viewport the browser captures only the
  visible part while the WBP keeps drawing (wrap it in a `ScrollBox`, or pin heights with
  `--pin-flow`).

## Baked native control parts

The `<select>` arrow, a checkbox tick, a slider thumb, a progress fill — the browser draws those from
the OS theme, and Slate's defaults look nothing like them. So these parts are cut out of the browser
by default (`--bake`):

the target part is isolated in the browser (other parts hidden, pseudo state forced), screenshotted,
masked to its `border-radius`, written into the brush's `ResourceObject`, and the widget's own
foreground colour is set to white so the colour is not multiplied twice.

Baking uses the element's own design size, so buttons, checkboxes and dropdowns look the same in UMG
as in the browser instead of "Slate default look plus a tint".

The rounded mask cuts **all four corners** (a bottom-left corner used to keep the page background — a
checked switch baked at 68×36 came out opaque white at `(0,35)`, which UMG drew as a white square
outside the pill). Edges are feathered by one pixel because these textures are baked at 2× and sampled
back down at half size.

## Effects: gradients, blur, shadows

A Slate brush is one colour or one image — no gradients, no backdrop blur — so these are handled by
"can the result be rasterised?":

- **Gradients** (`linear/radial/conic-gradient`) are baked into a texture, corners and border
  included, and drawn as a single Image brush.
- **`backdrop-filter: blur(N)`** maps to UMG's native `BackgroundBlur`, `BlurStrength = N`. It is a
  run-time effect, invisible to offscreen renders — keep that in mind when comparing screenshots.
- **`box-shadow`** outer shadows are baked: the capture area grows by `blur + spread`, the box grows
  with it, and negative slot padding cancels the extra footprint so the element keeps its place in the
  flow. The baked image includes what was behind the element, which is exactly right over a static
  background and shows a seam over animated content. Inner shadows (`inset`) are not supported.

Also unsupported, each with a warning: `clip-path`, `mask-image`, `filter`, `mix-blend-mode`.

### Corners and borders

Slate is narrower than CSS here, so borders are handled in three tiers by "can one outline express it":

**1. Uniform border (same width, same colour, solid)** — the brush outline. One trap: `FSlateBrush`'s
`OutlineSettings` is **only consumed by the rounded-box shader**; a plain `DrawAs=Box` (9-slice) draws
the fill only. So "border but no radius" used to paint no line at all (measured: a 6px border rendered
as none, 14.5% of that swatch's pixels wrong). Now any border forces `RoundedBox` with radius 0 — a
zero-radius rounded rect is a rectangle, and the outline is drawn.

**2. Unequal sides / four colours / non-solid (dashed, dotted, double)** — outline cannot express it.
Non-solid is always baked; unequal sides are baked too while the longest side is under 400px, otherwise
it falls back to "widest side + padding compensation". The area limit matters: a 1920×52 toolbar is
small in area but its screenshot spans the page, dragging another page from 0.57% to 22%.

**3. Different radius per corner** — `FSlateBrushOutlineSettings.CornerRadii` is an FVector4 in
TL/TR/BR/BL order, so `border-radius: 30px 0 30px 0` is expressible without baking.

The remaining difference is **sub-pixel antialiasing**: a 1px edge is about 88% blended in Slate but
solid in the browser, so 1px-border swatches keep 2–3% — visually a slightly darker line.

`Resources/Converter/test/09-borders.html` is the dedicated case (19 swatches: plain radius, pill,
radius + thin border, radius + thick border, single side, two colours, four colours, four radii,
dashed, double, transparent background, nested radius). Current whole-page difference **0.40%**, worst
single swatch 2.8% (that 1px line).

## The other direction: a finished WBP back to HTML

The pipeline's middle layer is one JSON, so going back only has to reach that layer:

```bat
:: 1) export the WBP (editor console command; also writes the textures as png and copies the fonts)
UnrealEditor-Cmd.exe <Project>.uproject \
  -ExecCmds="Html2UMG.ExportLayout /Game/UI/WBP_X --json=C:/out/x.json --assets=C:/out/x_assets --viewport=1920x1080, QUIT_EDITOR" \
  -unattended -windowed -stdout

:: 2) write the HTML (Node, no engine needed)
node Plugins/Html2UMG/Resources/Converter/cli/wbp2html.js C:/out/x.json -o C:/out/x.html

:: 3) round-trip check (WBP -> JSON -> HTML -> JSON, item by item)
node Resources/Tools/layout_diff.js a.json b.json --tolerance 1 --verbose
```

Three conversions have to be undone exactly or the result drifts: colours are **linear** in the JSON
(`FSlateColor`) while CSS is sRGB, the font size is Slate **points** (`px = pt * 4/3`), and line height is
a **multiplier** (`LineHeightPercentage = cssBox / slateBox`, which needs the font metrics - so the
exporter copies the ttf out). Anything CSS cannot draw keeps a marker (`data-ue-class`, `data-ue-widget`,
`data-ue-named-slot`, `data-ue-switcher`) so the re-import rebuilds the same widget.

Measured across 8 component pages: **5 round-trip exactly** (RowSlider, RowSwitch, RowEnum, Progress,
Slider). The other 3 are known limits: a 9-slice brush's Margin trades places with CSS padding, a
texture multiplied by a tint cannot be expressed in CSS, and an empty Overlay with no children has no
signal at all for CSS to carry.

Full write-up, limits included: `Docs/Html2UMG_ReverseExport.md`.

## Verification tools

Conversion is quantifiable; you do not have to judge "looks close" by eye.

```bat
:: Pixel comparison: difference ratio and mean error, plus 4x difference and side-by-side images
python Resources\Tools\pngdiff.py design.png umg.png --out out\ --max-diff 0.05

:: Style audit: dump real property values from the asset and compare them with layout.json
python Resources\Tools\style_audit.py out\layout.json dump.json

:: Anchor audit: compute rectangles per resolution from the formula above and compare with the browser
python Resources\Tools\anchor_check.py out\layout.json snap.json --tolerance 3

:: Per-element error map and a table sorted by tag/id/class; can also check whether an accent colour was drawn
python Resources\Tools\visual_audit.py browser.png umg.png --snapshot snap.json
```

`run_acceptance.py` chains convert → import → render → compare:

```bat
python Resources\Tools\run_acceptance.py --html design.html --blueprint /Game/UI/WBP_Screen
```

**How many frames the acceptance render runs matters.** Offscreen rendering lays out twice by default
(`Html2UMG.RenderFrames`, default 2): wrapped text and WrapBox rows/heights converge on the second
frame (see "Runtime widgets"), and a single pass systematically measures auto-wrapped text as one line.
To reproduce single-frame behaviour: `Html2UMG.RenderFrames 1`; to verify convergence:
`Html2UMG.RenderFrames 3`, whose geometry should equal the two-frame numbers.

Dumping real asset values:

```bat
UnrealEditor.exe <Project>.uproject ^
  -ExecCmds="Html2UMG.DumpWidgets /Game/UI/WBP_Screen --json=C:/w/dump.json, QUIT_EDITOR" ^
  -unattended -nosplash -windowed
```

## Fidelity

`Resources/Converter/test/` holds pages covering different scenarios. The difference ratio is UMG vs
browser at 1920×1080; lower is better:

| Test page | Coverage | Difference |
|---|---|---|
| `02-absolute.html` | Pure absolute positioning, anchor inference | 0.38% |
| `08-effects.html` | Gradients, backdrop-filter, shadows | 0.38% |
| `09-borders.html` | Radii, outlines, dashed, multi-colour borders | 0.40% |
| `07-anchors.html` | Point / horizontal / vertical / four-side stretch / percentage / centre | 0.43% |
| `04-form.html` | A complete form | 1.47% |
| `01-flex.html` | Flex rows/columns, gap, grow, wrap | 1.68% |
| `06-native.html` | Baked native control parts | 1.99% |
| `05-controls.html` | Custom dropdown, checkbox, slider, progress, text input | 2.55% |
| `03-dashboard.html` | Composite HUD, deeper hierarchy | 3.39% |

Texture file names are **content addressing** (`tex_div_card_af5758db.png`: readable stem + 8 hex
digits of a content hash), so several pages can share one `--assets` directory without overwriting
each other and an identical image is stored once. Early versions named by position (`tex_0`,
`tex_1`…) and two pages converted into the same directory silently overwrote each other, leaving the
first page's JSON pointing at the second page's pixels — which invents "it broke" out of nowhere.

Inside the project, **one page, one folder**:

```
/Game/MenuSystem/Skyline/Components/
  WBP_RowSlider/
    WBP_RowSlider.uasset          the blueprint
    assets/                       textures for this page
      tex_input_track_fb250cd6.uasset
      tex_input_thumb_b5f74fdc.uasset
/Game/Html2UMG/Fonts/             shared fonts (one face reused by every page)
```

So a blueprint path `/Game/X/WBP_Foo` becomes `/Game/X/WBP_Foo/WBP_Foo` automatically (re-imports do
not add a second level). Deleting a page = deleting one folder, and textures the page no longer uses
are cleaned up on the next import (only inside that page's own `assets/`, and only when the new layout
does not reference them and they are unreferenced).

The log states where things landed:

```
[info] assets: 2 texture(s) -> /Game/MenuSystem/Skyline/Components/WBP_RowSlider/assets (fonts -> /Game/Html2UMG/Fonts)
```

Cleanup commands (editor console):

| Command | Effect |
|---|---|
| `Html2UMG.PruneAssets /Game/Html2UMG` | Delete **unreferenced** assets under that directory (asset registry based; never deletes what is in use) |
| `Html2UMG.DeleteAsset /Game/UI/WBP_Old` | Delete specific assets (e.g. leftovers from a duplicate import) |

Most remaining error comes from text (glyph rasterisation) and a few details: CSS and Slate define the
text line box differently, and `SBackgroundBlur` produces nothing in an offscreen render.

## What a real design exposed

Beyond the fixtures, a real design (1920×7081 long document, 1358 widgets) was used as a comparison and
exposed more realistic problems.

**Two grid bugs** (mostly responsible for that design going 11.58% → 7.97%):

1. UMG's `GridPanel` has no gap. The old approach added half a gap on both sides of every cell, which
   looks symmetric but **pushed the first column 22px right and ate 44px of width** — a `148px` track
   rendered as 83px, so the second column started 43px early. A gap only exists *between* tracks, so it
   is now added on each cell's trailing edge (except the last row/column).
2. `GridPanel` column width is driven by the widest cell, so px tracks get squeezed by content. Cells
   are now pinned to the `grid-template-columns` px tracks (fr / auto still follow content). After
   pinning, both columns match the browser exactly: `390 / 148`, `582 / 948`.

**`overflow:hidden` now maps to UMG's Clipping** (it used to be "no clipping plus a warning"). A table
inside a rounded panel overflowing is what made this necessary.

**Shadows on auto-sized elements**: reserving room for a shadow used to require explicit width/height,
otherwise it was clipped. The browser's measured size is now the fallback, so cards without fixed sizes
keep their full shadow.

**`::before/::after` are still dropped** (5 occurrences): these decorations need a separate widget.

### Where the residual error sits in such a design

| Region | Difference |
|---|---|
| Top header (0–1000px) | 8.8% / 14.5% |
| Body tables | 3–8% |
| Footer (after 6500px) | 17.8% / 48.9% |

The footer is worst because of **accumulated height**: UMG content is about 660px taller than the
browser (`Wrap` 7748 vs 7081), so drift grows downwards and the last screen is simply misaligned. Those
height differences come from table cells and small text line boxes, added up row by row.

Gaps that remain in real designs, ordered by frequency:

| Count | Gap |
|---|---|
| 22 | Single-edge borders on wide elements (collapsed to four sides, widest wins) |
| 5 | `::before/::after` decorations |
| 4 | Horizontal percentage widths (UMG box slots have no cross-axis weight) |
| 3 | `inset` shadows |
| 3 | Inline small text runs (`<b>` etc.) merged into one TextBlock |

### Single-edge borders: wide elements are baked too

"Widest side + padding compensation" is the only option on wide elements, but early versions avoided
baking them: in one experiment a toolbar with text (1920×52) shifted its text by 1px after baking and
measured worse.

The mistake turned out to be **zeroing the padding compensation at the same time**: the baked texture
already contains the border, so content should fall back to the CSS `padding + border` position, but
clearing the compensation removed that too. Keeping it took the same page from 1.68% to 1.49%, so wide
elements are baked now whenever they are opaque and their longest side is within `--bake-max`.

Elements with a **transparent background** (a table row with only `border-top`, say) are still not
baked: the screenshot would capture whatever is behind them, which is what dragged a page from 0.57% to
22%. Those keep the "widest side + compensation" approximation.

### `--pin-flow`: pin flow children to their measured height

Long documents suffer from **accumulated height**: every block is sized by its content, each one is a
little off, and by the footer the drift is hundreds of pixels (the design is 7081px tall while UMG
renders about 660px taller, so the last screen is misaligned).

`--pin-flow` writes the browser's measured height into `HeightOverride` for every child of a vertical
flow container. The effect goes **both ways**, which is why it is off by default:

| Page | Default | With `--pin-flow` |
|---|---|---|
| Real design (1920×7081 long document) | 7.97% | **4.81%** |
| 01-flex | 1.49% | 0.89% |
| 06-native | 1.99% | 1.84% |
| 07-anchors | 0.43% | 0.31% |
| 04-form | 1.47% | 3.57% |
| 02-absolute | 0.38% | 1.57% |
| 03-dashboard | 3.05% | 8.10% |

In other words: **document-style pages** (long scroll, little flex) benefit clearly; **app-style pages**
(forms, dashboards, flex distribution) get worse because pinned heights fight the distribution. It is a
per-page choice, not a default.

## Known limitations

- A `Border` has one outline, so borders with different widths per side (only a 2px bottom, say) can
  only take the widest side and compensate with padding. Conversion warns.
- Slate has no per-side border and no `border-image`.
- Text `line-height` is approximated through `LineHeightPercentage`; the two engines define the line box
  differently and the ratio has to be derived per font.
- Tables, native scrollbar title bars and other OS-drawn parts are out of scope.
- `position: sticky` is treated as static.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Node.js was not found` | Install Node 22+, or point `HTML2UMG_NODE` at node.exe |
| `no Chromium found` | Pass `--browser` with the Edge/Chrome path |
| `'X' is not a property of Y` | Hand-written JSON set a property that class does not have |
| `'X' appears twice` | Widget names must be unique; that is the `BindWidget` key |
| A `BindWidget` is null | Add `data-ue-name` to the element; near-miss names are suggested in the message |
| Import failed but the asset was saved | The asset is a half-built draft; fix and re-import |
| Textures did not change after re-import | Names are content addressed, so changed pixels change the name; if the name is identical, nothing was re-baked |
| Page switching always shows page one | The container lacks `data-ue-switcher`; or CommonUI is not enabled but you expected transition animation (the log says which class was used) |
| Hidden pages are empty in UMG | That page is not a child of a `data-ue-switcher` container, so the converter had no reason to measure it |
| Generated names are still long | That is an older build's output; `data-ue-name` is used verbatim and automatic names carry one role suffix |

## Directory structure

```
Plugins/Html2UMG/
  Html2UMG.uplugin
  Source/Html2UMG/          editor module: import, panel, console commands, offscreen render
    Public|Private/
      Importer/     JSON -> WidgetBlueprint: tree building, reflection, texture and font import
      Editor/       panel, console commands, blueprint/python API, offscreen rendering
      Html2UMGTypes the contract in C++ plus parsing
  Resources/
    Converter/     Node converter (zero dependencies, drives the local browser over CDP)
      src/         mapper (classification, slots, brushes, grids), bake (control parts and effects),
                   assets (textures/fonts), fontmetrics (metrics), values (CSS value parsing)
      test/        01-19 fixtures plus validate.js contract checks
    Tools/         pngdiff / style_audit / anchor_check / visual_audit / run_acceptance /
                   font_metrics / residual_correct
```
