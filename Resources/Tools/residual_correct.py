#!/usr/bin/env python3
"""Residual correction for Html2UMG: turn a rendered geometry dump into a corrections file.

The converter measures the design in Chromium once and never looks back, so every
per-element size difference accumulates down a vertical flow (a 7081px document drifted
660px that way; --pin-flow fixes it but freezes every leaf, which breaks flex pages).

This script closes that loop *offline*: it compares the geometry UMG actually arranged
(written by the editor command Html2UMG.ImportRenderGeometry) against the rects Chromium
measured (the converter snapshot), and emits

  * corrections.json  - what to change (pin heights / slot offsets), keyed by widget name
  * report.md         - why, per element, ranked, with the skipped reasons spelled out

It deliberately does NOT touch the converter. Wiring it in is a separate change; see
Docs/Html2UMG_Residual_Correction.md (section 5).

Usage:
    python residual_correct.py --layout C:/out/cjk-after/layout.json \
        --geo C:/out/cjk-after/geo.json [--snapshot C:/out/cjk-after/snap.json] \
        [--out corrections.json] [--report report.md] [--top 20]

    # snapshot is auto-discovered next to layout.json (snap.json / snapshot.json)
    # synthetic end-to-end check, no editor and no dump needed:
    python residual_correct.py --self-test

Exit codes: 0 = wrote outputs (or self-test passed), 2 = bad input / missing file.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from collections import Counter, OrderedDict
from pathlib import Path

GENERATOR = "html2umg-residual-correct/0.1.0"
TICK = chr(96)


# ---------------------------------------------------------------------------
# Widget naming - a mirror of Resources/Converter/src/names.js
# (kept in sync by hand; the geometry dump carries the final names, this is only
#  used to find the *family* of nodes that belongs to one DOM element.)
# ---------------------------------------------------------------------------

_LEGAL_RE = re.compile(r"[^A-Za-z0-9_]")
_STATE_CLASS_RE = re.compile(
    r"^(?:is-|has-|active$|selected$|hover|focus|open$|disabled$|hidden$|visible$|show$|hide)",
    re.IGNORECASE,
)


def sanitize(raw):
    s = _LEGAL_RE.sub("_", str(raw if raw is not None else ""))
    s = re.sub(r"_+", "_", s)
    s = re.sub(r"^_+", "", s)
    s = re.sub(r"_+$", "", s)
    if not s:
        return "Widget"
    if re.match(r"^[0-9]", s):
        s = "W" + s
    return s


def to_identifier(raw):
    s = str(raw if raw is not None else "").strip()
    if not s:
        return ""
    s = re.sub(r"^\s*[.#]", "", s)
    tokens = [t for t in re.split(r"[^A-Za-z0-9]+", s) if t]
    out = ""
    for token in tokens:
        if re.match(r"^[0-9]", token):
            out += token
        elif re.match(r"^[A-Z0-9]{2,4}$", token):
            out += token
        elif re.match(r"[a-z]", token[0]) and re.search(r"[A-Z]", token[1:]):
            out += token[0].upper() + token[1:]
        else:
            out += token[0].upper() + token[1:]
    return sanitize(out)


def base_name(el):
    """names.js baseName: data-ue-name > id > first semantic class > tag."""
    ue = el.get("ue") or el.get("dataUe") or {}
    if ue.get("name"):
        n = to_identifier(ue["name"])
        if n:
            return n
    if el.get("id"):
        n = to_identifier(el["id"])
        if n:
            return n
    for cls in el.get("cls") or []:
        if _STATE_CLASS_RE.match(cls):
            continue
        n = to_identifier(cls)
        if n:
            return n
    return to_identifier(el.get("tag") or "Widget") or "Widget"


def element_label(el):
    """mapper.label(): tag#id.firstClass - human-facing only."""
    out = el.get("tag") or "?"
    if el.get("id"):
        out += "#" + str(el["id"])
    cls = [c for c in (el.get("cls") or []) if not re.match(r"^(is-|has-)", c)]
    semantic = cls[0] if cls else ((el.get("cls") or [None])[0])
    if semantic:
        out += "." + semantic
    return out


# ---------------------------------------------------------------------------
# CSS helpers (the snapshot keeps computed style in cs, authored in decl)
# ---------------------------------------------------------------------------

_PX_RE = re.compile(r"^(-?\d+(?:\.\d+)?)px$")


def css_px(value):
    """'132px' -> 132.0; anything else (auto / % / calc / fr) -> None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = _PX_RE.match(str(value).strip())
    return float(m.group(1)) if m else None


def _style_sources(el):
    return (el.get("cs") or {}, el.get("decl") or {})


def is_absolute(el):
    for source in _style_sources(el):
        if str(source.get("position") or "").lower() in ("absolute", "fixed"):
            return True
    return False


def is_percent_sized(el, axis="height"):
    """True when the authored size is a percentage (a Fill child, not a pin target)."""
    authored = (el.get("decl") or {}).get(axis)
    if authored is not None:
        text = str(authored).strip()
        if text.endswith("%"):
            return True
        if text.lower() in ("auto", ""):
            return False
        if css_px(text) is not None:
            return False
    computed = str((el.get("cs") or {}).get(axis) or "").strip()
    return computed.endswith("%")


def is_flex_fill(el):
    """A child that is meant to stretch - pinning it would freeze the layout."""
    for source in _style_sources(el):
        for key in ("flexGrow", "flex-grow", "flex"):
            value = source.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text in ("none", "0", "0 1 auto"):
                continue
            try:
                first = float(re.split(r"[\s,]+", text)[0])
            except (ValueError, IndexError):
                continue
            if first > 0:
                return True
    return is_percent_sized(el, "height")


def declared_height(el):
    """An *authored* px height, if any. Present => the widget already pins itself.

    Only the authored declaration counts: the computed style always resolves height
    to a pixel value, so reading it here would classify every element as "already
    has an explicit height" and nothing would ever be corrected.
    """
    return css_px((el.get("decl") or {}).get("height"))


def has_declared_line_height(el):
    for source in _style_sources(el):
        for key in ("lineHeight", "line-height"):
            value = source.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text.lower() in ("normal", "auto", ""):
                continue
            return True
    return False


def parent_flow(parent):
    """How a parent lays out its children: column | row | grid | table | none."""
    if parent is None:
        return "none"
    cs = parent.get("cs") or {}
    display = str(cs.get("display") or "block").lower()
    if display.startswith("table"):
        # Rows/cells are laid out by the mapper as GridPanel or HorizontalBox; the
        # vertical-flow assumption does not hold inside them.
        return "table"
    if display in ("grid", "inline-grid"):
        return "grid"
    if display in ("flex", "inline-flex"):
        direction = str(cs.get("flexDirection") or "row").lower()
        if direction.startswith("row"):
            return "row"
        return "column"
    return "column"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_json(path, what):
    p = Path(path)
    if not p.is_file():
        raise SystemExit("error: %s not found: %s" % (what, p))
    try:
        with p.open("r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        raise SystemExit("error: %s is not valid JSON (%s): %s" % (what, exc, p))


def discover_snapshot(layout_path):
    folder = Path(layout_path).parent
    for name in ("snap.json", "snapshot.json", "measures.json"):
        candidate = folder / name
        if candidate.is_file():
            return candidate
    matches = sorted(folder.glob("*snap*.json"))
    return matches[0] if matches else None


def load_snapshot(path):
    data = load_json(path, "snapshot")
    primary = data.get("primary") or data
    elements = primary.get("elements")
    if not isinstance(elements, list):
        raise SystemExit("error: snapshot has no 'primary.elements' array: %s" % path)
    return primary, elements


def load_geo(path):
    data = load_json(path, "geometry dump")
    widgets = data.get("widgets")
    if not isinstance(widgets, list):
        raise SystemExit("error: geometry dump has no 'widgets' array: %s" % path)
    return data, {w.get("name"): w for w in widgets if w.get("name")}


# ---------------------------------------------------------------------------
# Layout tree
# ---------------------------------------------------------------------------

class LayoutNode(object):
    __slots__ = ("name", "cls", "source", "depth", "parent")

    def __init__(self, name, cls, source, depth, parent):
        self.name = name
        self.cls = cls
        self.source = source
        self.depth = depth
        self.parent = parent


def flatten_layout(root):
    out = []

    def walk(node, depth, parent):
        if not isinstance(node, dict):
            return
        out.append(LayoutNode(node.get("name"), node.get("class"), node.get("source"),
                              depth, parent))
        for child in node.get("children") or []:
            walk(child, depth + 1, node.get("name"))

    walk(root, 0, None)
    return out


# ---------------------------------------------------------------------------
# DOM element  <->  widget family matching
# ---------------------------------------------------------------------------

class Match(object):
    """One DOM element and the widget that stands for its box."""

    __slots__ = ("index", "element", "name", "cls", "expected", "actual",
                 "dh", "dy", "dw", "dx", "depth", "is_root_role")

    def __init__(self, index, element, name, cls, expected, actual, is_root_role=False, depth=0):
        self.index = index
        self.element = element
        self.name = name
        self.cls = cls
        self.expected = expected          # [x, y, w, h] from Chromium
        self.actual = actual              # [x, y, w, h] from Slate
        self.is_root_role = is_root_role
        self.depth = depth
        self.dw = actual[2] - expected[2]
        self.dh = actual[3] - expected[3]
        self.dx = actual[0] - expected[0]
        self.dy = actual[1] - expected[1]


def match_boxes(elements, nodes, geo, root_name):
    """Pair every DOM element with the shallowest widget in its name family.

    The converter emits a *family* of widgets per element (Card_Size / Card /
    Card_Content); the outermost one is the element box. Element k of a given base
    name owns the family rooted at Base (k = 0) or Base_k.
    """
    occurrences = Counter()
    matches, unmatched, unpainted, missing = [], [], [], []
    root_matched = False

    for el in elements:
        index = el.get("i")
        tag = (el.get("tag") or "").lower()
        if tag in ("html", "body"):
            if root_matched:
                continue
            # The UMG root stands for the document, not for the element box: its
            # height is the viewport by design, so it is never a correction target.
            widget = geo.get(root_name)
            if widget and widget.get("painted"):
                root_matched = True
                expected = el.get("rect") or [0, 0, 0, 0]
                matches.append(Match(index, el, root_name, widget.get("class"), expected,
                                     [widget["x"], widget["y"], widget["w"], widget["h"]],
                                     True, 0))
            continue

        base = base_name(el)
        k = occurrences[base]
        occurrences[base] += 1
        root = base if k == 0 else "%s_%d" % (base, k)
        family = [n for n in nodes if n.name == root or (n.name or "").startswith(root + "_")]
        if not family:
            unmatched.append({"element": index, "tag": el.get("tag"), "base": base,
                              "expectedName": root})
            continue
        family.sort(key=lambda n: n.depth)
        outer = family[0]
        widget = geo.get(outer.name)
        if not widget:
            missing.append({"element": index, "name": outer.name, "base": base})
            continue
        if not widget.get("painted"):
            unpainted.append({"element": index, "name": outer.name, "base": base})
            continue
        expected = el.get("rect") or [0, 0, 0, 0]
        matches.append(Match(index, el, outer.name, widget.get("class"), expected,
                             [widget["x"], widget["y"], widget["w"], widget["h"]],
                             False, outer.depth))
    return matches, unmatched, unpainted, missing


# ---------------------------------------------------------------------------
# Heuristics: which residuals are "document-flow accumulation"
# ---------------------------------------------------------------------------

CONTAINER_CLASSES = {
    "VerticalBox", "HorizontalBox", "WrapBox", "GridPanel", "UniformGridPanel",
    "Border", "SizeBox", "Overlay", "CanvasPanel", "ScrollBox", "ScaleBox",
    "UserWidget", "WidgetBlueprint", "Widget",
}
TEXT_CLASSES = {"TextBlock", "RichTextBlock", "EditableText", "EditableTextBox"}


def kind_of(cls):
    if cls in TEXT_CLASSES:
        return "text"
    if cls in CONTAINER_CLASSES:
        return "container"
    return "other"


def line_count_ratio(match):
    """(expectedLines, actualLines) when the difference is a whole number of lines.

    A 66px block rendering 22px in an 22px line box is a wrap defect, not a size
    declaration. Returns None when the ratio is not close to an integer >= 2.
    """
    expected, actual = match.expected[3], match.actual[3]
    if expected <= 0 or actual <= 0:
        return None
    ratio = expected / actual
    whole = round(ratio)
    if whole < 2 or abs(ratio - whole) > 0.12:
        return None
    return (int(whole), 1)


class Analysis(object):
    def __init__(self):
        self.pins = OrderedDict()       # widget name -> correction record
        self.offsets = OrderedDict()    # widget name -> {"padTop": ...}
        self.skipped = []               # [{"name","reason",...}]
        self.evidence = []              # [container accumulation rows]
        self.rows = []                  # every Match, for the top-N table


def analyze(matches, elements, tolerance, min_drift, allow_text_pin, root_name):
    by_index = {el.get("i"): el for el in elements}
    matched = {m.index: m for m in matches}
    result = Analysis()
    result.rows = list(matches)

    def children_of(element):
        kids = element.get("k")
        if isinstance(kids, list):
            return [k for k in kids if k in matched]
        return [m.index for m in matches
                if (by_index.get(m.index) or {}).get("p") == element.get("i")]

    def predecessors(match):
        """Siblings that sit before this element in the same parent flow."""
        parent_el = by_index.get(match.element.get("p"))
        if parent_el is None:
            return None, []
        siblings = [matched[idx] for idx in children_of(parent_el)]
        siblings = [s for s in siblings if not is_absolute(s.element)]
        siblings.sort(key=lambda s: (s.expected[1], s.expected[0]))
        position = next((i for i, s in enumerate(siblings) if s.index == match.index), None)
        return position, (siblings[:position] if position is not None else [])

    reported_root = False
    flow_state = {}
    for match in sorted(matches, key=lambda m: (m.depth, m.index)):
        el = match.element
        if match.is_root_role or match.name == root_name:
            if not reported_root:
                result.skipped.append({"name": match.name, "reason": "root-is-viewport-sized"})
                reported_root = True
            continue
        if is_absolute(el):
            result.skipped.append({"name": match.name, "reason": "absolute-positioned"})
            continue

        position, before = predecessors(match)
        cumulative_dh = sum(s.dh for s in before)
        explained_dy = match.dy - cumulative_dh if position is not None else match.dy
        explained = abs(explained_dy) <= max(tolerance, 0.25 * abs(match.dy))

        parent_el = by_index.get(el.get("p"))
        flow = parent_flow(parent_el)

        if flow == "grid":
            result.skipped.append({"name": match.name, "reason": "grid-parent"})
            continue
        if flow == "row":
            result.skipped.append({"name": match.name, "reason": "horizontal-flow-parent"})
            continue
        if flow == "table":
            result.skipped.append({"name": match.name, "reason": "table-flow-parent"})
            continue
        if is_flex_fill(el):
            result.skipped.append({"name": match.name, "reason": "flex-fill-or-percent-child"})
            continue

        explicit_h = declared_height(el)
        kind = kind_of(match.cls)
        height_off = abs(match.dh) > tolerance
        offset_off = abs(explained_dy) > tolerance

        if explicit_h is not None:
            # A declared px height means the widget already carries a SizeBox
            # override. A mismatch there is a conversion defect (slot/SizeBox
            # interaction), not accumulation - papering it over would hide a bug.
            if height_off:
                result.skipped.append({"name": match.name, "reason": "explicit-height-mismatch",
                                       "declared": explicit_h,
                                       "expected": round(match.expected[3], 2),
                                       "actual": round(match.actual[3], 2)})
            else:
                result.skipped.append({"name": match.name, "reason": "within-tolerance"})
            if offset_off and flow == "column":
                record_offset(result, match, explained_dy, position,
                              (parent_el or {}).get("i"), flow_state, tolerance)
            continue

        if not height_off and not offset_off:
            result.skipped.append({"name": match.name, "reason": "within-tolerance"})
            continue

        # ---- may we pin this element's box? ----
        if height_off:
            lines = line_count_ratio(match)
            if kind == "text" and lines is not None:
                # ... regardless of a declared line-height: 66px in a 22px line box is
                # three lines that did not wrap, not a size declaration.
                result.skipped.append({"name": match.name, "reason": "text-line-count-mismatch",
                                       "expectedLines": lines[0], "actualLines": lines[1],
                                       "expectedHeight": round(match.expected[3], 2),
                                       "actualHeight": round(match.actual[3], 2),
                                       "deltaY": round(match.dy, 2)})
            elif kind == "text" and not allow_text_pin and not has_declared_line_height(el):
                result.skipped.append({"name": match.name, "reason": "text-pin-disabled"})
            elif abs(match.dh) < min_drift and not explained:
                result.skipped.append({"name": match.name, "reason": "drift-below-minimum"})
            else:
                reason = ("cumulative-flow" if (position and abs(cumulative_dh) >= min_drift and explained)
                          else "own-box-height")
                if kind == "text" and has_declared_line_height(el):
                    reason = "text-line-box"
                result.pins[match.name] = OrderedDict(
                    pinHeight=round(match.expected[3], 2),
                    actualHeight=round(match.actual[3], 2),
                    deltaHeight=round(match.dh, 2),
                    deltaY=round(match.dy, 2),
                    kind=kind,
                    widgetClass=match.cls,
                    source=element_label(el),
                    reason=reason,
                    expectedRect=[round(v, 2) for v in match.expected],
                    actualRect=[round(v, 2) for v in match.actual],
                )
                if kind == "container" and len(before) + 1 >= 1:
                    result.evidence.append(OrderedDict(
                        name=match.name,
                        source=element_label(el),
                        predecessors=len(before),
                        deltaHeight=round(match.dh, 2),
                        predecessorDeltaSum=round(cumulative_dh, 2),
                        unexplainedDeltaY=round(explained_dy, 2),
                        verdict="explained-by-accumulation" if explained and before else "own-height",
                    ))

        if offset_off:
            record_offset(result, match, explained_dy, position,
                          (parent_el or {}).get("i"), flow_state, tolerance)

    return result


def record_offset(result, match, unexplained_dy, position, parent_index, flow_state, tolerance):
    """A position the pinned heights do not explain needs a slot nudge.

    Only the *change* in unexplained drift is a real offset: a whole group sitting
    8px low is one offset on the first child, not 8px on every sibling.
    """
    previous = flow_state.get(parent_index, 0.0)
    flow_state[parent_index] = unexplained_dy
    delta = unexplained_dy - previous
    if abs(delta) <= tolerance:
        return
    if match.name in result.offsets:
        return
    result.offsets[match.name] = OrderedDict(
        padTop=round(delta, 2),
        deltaY=round(match.dy, 2),
        source=element_label(match.element),
        reason="first-child-offset" if position == 0 else "unexplained-shift",
    )


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

def build_payload(layout_path, geo_path, snapshot_path, geo, analysis, args):
    counts = Counter(entry["reason"] for entry in analysis.skipped)
    return OrderedDict(
        version=1,
        generator=GENERATOR,
        inputs=OrderedDict(
            layout=str(Path(layout_path).resolve()),
            geometry=str(Path(geo_path).resolve()),
            snapshot=str(Path(snapshot_path).resolve()) if snapshot_path else None,
            blueprint=geo.get("blueprint"),
            viewport=OrderedDict(width=geo.get("width"), height=geo.get("height")),
        ),
        tolerance=OrderedDict(absPx=args.tolerance, minDriftPx=args.min_drift,
                              textPin=bool(args.text_pin)),
        summary=OrderedDict(
            matched=len(analysis.rows),
            pinned=len(analysis.pins),
            slotOffsets=len(analysis.offsets),
            skipped=len(analysis.skipped),
            skippedByReason=OrderedDict(counts.most_common()),
        ),
        nodes=analysis.pins,
        slotOffsets=analysis.offsets,
        skipped=analysis.skipped,
    )


SKIP_TEXT = {
    "root-is-viewport-sized": "根（html/body）按设计就是视口高度，不参与修正",
    "absolute-positioned": "绝对定位元素由锚点决定，不属文档流",
    "flex-fill-or-percent-child": "flex-grow / 百分比子项，钉高会破坏响应式",
    "grid-parent": "Grid 槽位由网格决定",
    "horizontal-flow-parent": "横向流容器，高度不累积",
    "table-flow-parent": "表格单元（GridPanel/HBox 语义），不走竖向流",
    "within-tolerance": "误差在容差内",
    "explicit-height-mismatch": "CSS 有显式高度却渲染不符 —— 转换缺陷，不能用钉高掩盖",
    "text-pin-disabled": "文本钉高被关闭（--no-text-pin）",
    "text-drift-not-cumulative": "文本高度不符但下方未位移 —— 多为换行/字体度量问题",
    "text-line-count-mismatch": "文本行数不符（换行/字体度量缺陷，钉高只会留下空行）",
    "drift-below-minimum": "误差小于最小显著漂移",
    "no-widget-with-this-name": "找不到同名控件（命名规则不一致）",
    "widget-not-in-geometry-dump": "几何 dump 里没有该控件",
    "widget-never-painted": "控件未绘制（几何为 0）",
}


def render_report(payload, analysis, args, layout_path, geo_path, snapshot_path):
    lines = []
    add = lines.append
    add("# Html2UMG 残差修正报表")
    add("")
    add("由 `%s` 离线生成（不跑编辑器）。" % GENERATOR)
    add("")
    add("| 输入 | 路径 |")
    add("|---|---|")
    add("| layout.json | `%s` |" % Path(layout_path).resolve())
    add("| geo.json | `%s` |" % Path(geo_path).resolve())
    add("| snapshot | `%s` |"
        % (Path(snapshot_path).resolve() if snapshot_path else "（缺失）"))
    viewport = payload["inputs"]["viewport"]
    add("| 视口 | %sx%s |" % (viewport.get("width"), viewport.get("height")))
    add("| 容差 / 最小显著漂移 | %.2fpx / %.2fpx |" % (args.tolerance, args.min_drift))
    add("")

    summary = payload["summary"]
    add("## 1. 结论")
    add("")
    add("匹配 %d 个元素 → **钉高 %d**、**槽位偏移 %d**、跳过 %d。"
        % (summary["matched"], summary["pinned"], summary["slotOffsets"], summary["skipped"]))
    add("")
    if not summary["pinned"] and not summary["slotOffsets"]:
        add("> 这一页没有需要修正的元素：布局已收敛，或残差都是不能用钉高掩盖的那一类。")
        add("")

    if analysis.pins:
        add("## 2. 钉高（corrections.json → nodes）")
        add("")
        add("| 控件 | 类 | 来源 | 期望高 | 实测高 | Δh | 判据 |")
        add("|---|---|---|---|---|---|---|")
        for name, rec in analysis.pins.items():
            add("| `%s` | %s | `%s` | %.1f | %.1f | %+.1f | %s |"
                % (name, rec["widgetClass"], rec["source"], rec["pinHeight"],
                   rec["actualHeight"], rec["deltaHeight"], rec["reason"]))
        add("")

    if analysis.offsets:
        add("## 3. 槽位偏移（corrections.json → slotOffsets）")
        add("")
        add("| 控件 | 来源 | padTop | Δy | 判据 |")
        add("|---|---|---|---|---|")
        for name, rec in analysis.offsets.items():
            add("| `%s` | `%s` | %+.2f | %+.2f | %s |"
                % (name, rec["source"], rec["padTop"], rec["deltaY"], rec["reason"]))
        add("")

    if analysis.evidence:
        add("## 4. 累计判据证据（容器级）")
        add("")
        add("| 容器 | 来源 | 前序兄弟数 | Δh | 前序兄弟 Δh 之和 | 残余 Δy | 判定 |")
        add("|---|---|---|---|---|---|---|")
        for row in analysis.evidence:
            add("| `%s` | `%s` | %d | %+.1f | %+.1f | %+.1f | %s |"
                % (row["name"], row["source"], row["predecessors"], row["deltaHeight"],
                   row["predecessorDeltaSum"], row["unexplainedDeltaY"], row["verdict"]))
        add("")

    line_defects = [s for s in analysis.skipped if s["reason"] == "text-line-count-mismatch"]
    if line_defects:
        add("## 4.1 文本行数不符（这是缺陷，不是可钉的尺寸）")
        add("")
        add("| 控件 | 期望行 | 实测行 | 期望高 | 实测高 | Δy |")
        add("|---|---|---|---|---|---|")
        for entry in line_defects:
            add("| `%s` | %d | %d | %.1f | %.1f | %+.1f |"
                % (entry.get("name"), entry.get("expectedLines", 0), entry.get("actualLines", 0),
                   entry.get("expectedHeight", 0.0), entry.get("actualHeight", 0.0),
                   entry.get("deltaY", 0.0)))
        add("")
        add("> 这些元素**不产生修正**：行数差 1 行只能靠字体度量/换行策略修，钉高只会把空行留在原地。")
        add("")

    rows = [m for m in analysis.rows if not m.is_root_role]
    rows.sort(key=lambda m: -max(abs(m.dh), abs(m.dy)))
    add("## 5. Top %d 偏差元素（不含根）" % args.top)
    add("")
    add("| 控件 | 类 | 来源 | 期望 rect (x,y,w,h) | 实测 rect | Δw | Δh | Δx | Δy |")
    add("|---|---|---|---|---|---|---|---|---|")
    for m in rows[: args.top]:
        add("| `%s` | %s | `%s` | %.0f,%.0f,%.0f,%.0f | "
            "%.0f,%.0f,%.0f,%.0f | %+.1f | %+.1f | %+.1f | %+.1f |"
            % (m.name, m.cls, element_label(m.element),
               m.expected[0], m.expected[1], m.expected[2], m.expected[3],
               m.actual[0], m.actual[1], m.actual[2], m.actual[3],
               m.dw, m.dh, m.dx, m.dy))
    add("")

    if analysis.skipped:
        add("## 6. 跳过原因统计")
        add("")
        add("| 原因 | 说明 | 数量 | 示例 |")
        add("|---|---|---|---|")
        for reason, count in Counter(s["reason"] for s in analysis.skipped).most_common():
            examples = [s["name"] for s in analysis.skipped if s["reason"] == reason][:3]
            add("| `%s` | %s | %d | %s |"
                % (reason, SKIP_TEXT.get(reason, ""), count,
                   ", ".join("`%s`" % e for e in examples)))
        add("")

    add("## 7. 怎么用这份结果")
    add("")
    add("1. `corrections.json` 的 `nodes.<控件名>.pinHeight` = 该控件应被钉住的")
    add("   CSS 高度；`slotOffsets.<控件名>.padTop` = 其父槽位在主轴上应补的 padding。")
    add("2. 键是**控件名**（与几何 dump、WBP 里的名字一致），可以按名字落到 mapper 的节点上。")
    add("3. 本工具**不接进** `cli/convert.js`；接入方式见")
    add("   `Docs/Html2UMG_Residual_Correction.md` 第 5 节。")
    add("")
    return "\n".join(lines) + "\n"


def patch_layout(layout, pins, out_path):
    """Stopgap wiring: apply pinHeight to SizeBox nodes of an existing layout.json.

    A SizeBox already has HeightOverride, so the correction can be expressed without
    touching the converter. Anything else (TextBlock, Border, HorizontalBox) can only
    be pinned by the mapper, which owns the synthetic SizeBox wrapper - those pins are
    reported, not applied. Returns (patched, unsupported).
    """
    import copy

    patched, unsupported = [], []

    def walk(node):
        if not isinstance(node, dict):
            return
        name = node.get("name")
        record = pins.get(name)
        if record is not None:
            if node.get("class") == "SizeBox":
                properties = node.setdefault("properties", {})
                properties["HeightOverride"] = record["pinHeight"]
                properties["bOverride_HeightOverride"] = True
                patched.append(name)
            elif node.get("class") in ("TextBlock", "RichTextBlock"):
                unsupported.append((name, "text", record["pinHeight"]))
            else:
                unsupported.append((name, node.get("class"), record["pinHeight"]))
        for child in node.get("children") or []:
            walk(child)

    result = copy.deepcopy(layout)
    walk(result.get("root"))
    Path(out_path).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                              encoding="utf-8")
    return patched, unsupported


def write_outputs(payload, report_text, args, layout_path):
    layout_dir = Path(layout_path).parent
    out_path = Path(args.out) if args.out else (layout_dir / "corrections.json")
    report_path = Path(args.report) if args.report else (layout_dir / "residual_report.md")
    for path, text in ((out_path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n"),
                       (report_path, report_text)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return out_path, report_path


# ---------------------------------------------------------------------------
# Self test - synthetic fixtures, no editor and no dump needed
# ---------------------------------------------------------------------------

def self_test():
    layout = {
        "contractVersion": 1,
        "root": {
            "name": "Root", "class": "Border", "source": "body",
            "children": [{
                "name": "Root_Content", "class": "VerticalBox", "source": "body",
                "children": [
                    {"name": "Header_Size", "class": "SizeBox", "source": "div.header",
                     "properties": {"HeightOverride": 60},
                     "children": [{"name": "Header", "class": "Border", "source": "div.header"}]},
                    {"name": "Card_Size", "class": "SizeBox", "source": "div.card",
                     "children": [{"name": "Card", "class": "Border", "source": "div.card"}]},
                    {"name": "Row_Size", "class": "SizeBox", "source": "div.row",
                     "children": [{"name": "Row", "class": "HorizontalBox", "source": "div.row"}]},
                ],
            }],
        },
    }

    def el(i, p, tag, cls, rect, display="block", direction="row", height=None,
           position="static", grow=None):
        cs = {"display": display, "position": position, "flexDirection": direction,
              "height": height if height else "auto"}
        decl = {}
        if height is not None:
            decl["height"] = height
        if grow is not None:
            cs["flexGrow"] = str(grow)
            decl["flex-grow"] = str(grow)
        return {"i": i, "p": p, "k": [], "tag": tag, "id": "", "cls": cls,
                "rect": rect, "cs": cs, "decl": decl}

    elements = [el(0, -1, "body", [], [0, 0, 800, 400], display="flex", direction="column")]
    elements.append(el(1, 0, "div", ["header"], [0, 0, 800, 60], height="60px"))
    elements.append(el(2, 0, "div", ["card"], [0, 60, 800, 100]))
    elements.append(el(3, 0, "div", ["row"], [0, 160, 800, 40], display="flex", direction="row"))
    elements[0]["k"] = [1, 2, 3]
    snapshot = {"primary": {"viewport": {"width": 800, "height": 400}, "elements": elements}}

    geo = {"blueprint": "/Game/Test/WBP_Residual", "width": 800, "height": 400, "widgets": [
        {"name": "Root", "class": "Border", "x": 0, "y": 0, "w": 800, "h": 400, "painted": True},
        {"name": "Root_Content", "class": "VerticalBox", "parent": "Root",
         "x": 0, "y": 0, "w": 800, "h": 400, "painted": True},
        {"name": "Header_Size", "class": "SizeBox", "parent": "Root_Content",
         "x": 0, "y": 0, "w": 800, "h": 60, "painted": True},
        {"name": "Header", "class": "Border", "parent": "Header_Size",
         "x": 0, "y": 0, "w": 800, "h": 60, "painted": True},
        {"name": "Card_Size", "class": "SizeBox", "parent": "Root_Content",
         "x": 0, "y": 60, "w": 800, "h": 78, "painted": True},
        {"name": "Card", "class": "Border", "parent": "Card_Size",
         "x": 0, "y": 60, "w": 800, "h": 78, "painted": True},
        {"name": "Row_Size", "class": "SizeBox", "parent": "Root_Content",
         "x": 0, "y": 138, "w": 800, "h": 40, "painted": True},
        {"name": "Row", "class": "HorizontalBox", "parent": "Row_Size",
         "x": 0, "y": 138, "w": 800, "h": 40, "painted": True},
    ]}

    tmp = Path(tempfile.mkdtemp(prefix="h2u-residual-"))
    try:
        layout_path = tmp / "layout.json"
        geo_path = tmp / "geo.json"
        snap_path = tmp / "snap.json"
        layout_path.write_text(json.dumps(layout), encoding="utf-8")
        geo_path.write_text(json.dumps(geo), encoding="utf-8")
        snap_path.write_text(json.dumps(snapshot), encoding="utf-8")

        nodes = flatten_layout(layout["root"])
        _, elements = load_snapshot(snap_path)
        _, geo_index = load_geo(geo_path)
        matches, unmatched, unpainted, missing = match_boxes(elements, nodes, geo_index, "Root")
        assert len(matches) == 4, "expected body+header+card+row, got %d" % len(matches)
        assert not missing and not unpainted, (missing, unpainted)

        analysis = analyze(matches, elements, tolerance=0.5, min_drift=2.0,
                           allow_text_pin=True, root_name="Root")
        assert "Card_Size" in analysis.pins, "auto-height card should be pinned: %s" % list(analysis.pins)
        assert analysis.pins["Card_Size"]["pinHeight"] == 100.0
        assert "Root" not in analysis.pins
        assert "Row_Size" not in analysis.pins, "row children are not a pin target"
        assert any(s["reason"] == "root-is-viewport-sized" for s in analysis.skipped)
        skipped = {s["name"]: s["reason"] for s in analysis.skipped}
        assert skipped.get("Header_Size") in ("within-tolerance", "explicit-height-mismatch"), skipped

        # An unpainted widget must never be read as "laid out at 0,0".
        geo["widgets"][4]["painted"] = False
        geo_path.write_text(json.dumps(geo), encoding="utf-8")
        _, geo_index = load_geo(geo_path)
        matches, unmatched, unpainted, missing = match_boxes(elements, nodes, geo_index, "Root")
        assert unpainted and unpainted[0]["name"] == "Card_Size", unpainted

        payload = build_payload(layout_path, geo_path, snap_path, geo, analysis,
                                argparse.Namespace(tolerance=0.5, min_drift=2.0, text_pin=True))
        report = render_report(payload, analysis,
                               argparse.Namespace(tolerance=0.5, min_drift=2.0, top=10,
                                                  text_pin=True),
                               layout_path, geo_path, snap_path)
        assert "钉高" in report and "Card_Size" in report
        assert TICK in report, "markdown code spans must survive"
        print("self-test OK")
        return 0
    finally:
        for child in tmp.rglob("*"):
            if child.is_file():
                child.unlink()
        for child in sorted(tmp.rglob("*"), reverse=True):
            if child.is_dir():
                child.rmdir()
        tmp.rmdir()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Diff a geometry dump against the converter snapshot and emit corrections.")
    parser.add_argument("--layout", help="layout.json written by cli/convert.js")
    parser.add_argument("--geo", help="geo.json written by Html2UMG.ImportRenderGeometry")
    parser.add_argument("--snapshot", help="snapshot json (auto-discovered next to layout.json)")
    parser.add_argument("--out", help="corrections.json path (default: next to layout.json)")
    parser.add_argument("--report", help="markdown report path (default: next to layout.json)")
    parser.add_argument("--top", type=int, default=20, help="rows in the top-N table (default 20)")
    parser.add_argument("--tolerance", type=float, default=0.5,
                        help="ignore deltas at or below this many px (default 0.5)")
    parser.add_argument("--min-drift", type=float, default=2.0,
                        help="drift worth correcting at all, in px (default 2.0)")
    parser.add_argument("--no-text-pin", dest="text_pin", action="store_false",
                        help="never pin a TextBlock height (only containers)")
    parser.add_argument("--patch-layout", metavar="OUT",
                        help="also write a patched layout.json (SizeBox pins only - stopgap "
                             "until the mapper takes --corrections)")
    parser.add_argument("--self-test", action="store_true", help="run the synthetic fixture test")
    parser.set_defaults(text_pin=True)
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.layout or not args.geo:
        print("error: --layout and --geo are required (or use --self-test)", file=sys.stderr)
        return 2

    snapshot_path = Path(args.snapshot) if args.snapshot else discover_snapshot(args.layout)
    if snapshot_path is None:
        print("error: no snapshot found next to %s; pass --snapshot (the converter writes it "
              "with --dump-snapshot)" % args.layout, file=sys.stderr)
        return 2

    layout = load_json(args.layout, "layout.json")
    root = layout.get("root")
    if not isinstance(root, dict):
        raise SystemExit("error: layout.json has no 'root' node: %s" % args.layout)
    geo, geo_index = load_geo(args.geo)
    _, elements = load_snapshot(snapshot_path)

    nodes = flatten_layout(root)
    root_name = root.get("name") or "Root"
    matches, unmatched, unpainted, missing = match_boxes(elements, nodes, geo_index, root_name)
    if not matches:
        print("error: no DOM element matched a widget - is this geo.json from the same "
              "layout.json?", file=sys.stderr)
        return 2

    analysis = analyze(matches, elements, tolerance=args.tolerance, min_drift=args.min_drift,
                       allow_text_pin=args.text_pin, root_name=root_name)
    for entry in unmatched:
        analysis.skipped.append({"name": entry.get("expectedName"),
                                 "reason": "no-widget-with-this-name",
                                 "element": entry.get("tag")})
    for entry in missing:
        analysis.skipped.append({"name": entry.get("name"),
                                 "reason": "widget-not-in-geometry-dump"})
    for entry in unpainted:
        analysis.skipped.append({"name": entry.get("name"), "reason": "widget-never-painted"})

    payload = build_payload(args.layout, args.geo, snapshot_path, geo, analysis, args)
    report = render_report(payload, analysis, args, args.layout, args.geo, snapshot_path)
    out_path, report_path = write_outputs(payload, report, args, args.layout)

    print("matched %d elements -> %d pin(s), %d slot offset(s), %d skipped"
          % (len(matches), len(analysis.pins), len(analysis.offsets), len(analysis.skipped)))
    print("wrote %s" % out_path)
    print("wrote %s" % report_path)
    if args.patch_layout:
        patched, unsupported = patch_layout(layout, analysis.pins, args.patch_layout)
        print("wrote %s (%d SizeBox pin(s) applied, %d pin(s) need the mapper)"
              % (args.patch_layout, len(patched), len(unsupported)))
        if unsupported:
            preview = ", ".join("%s(%s)" % (n, c) for n, c, _ in unsupported[:6])
            print("  not patchable here: %s%s"
                  % (preview, " ..." if len(unsupported) > 6 else ""))
    if unmatched:
        print("note: %d element(s) had no same-named widget: %s"
              % (len(unmatched), ", ".join(sorted({u["base"] for u in unmatched})[:6])),
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
