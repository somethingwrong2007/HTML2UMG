#!/usr/bin/env python3
"""Verify that the anchors/offsets in a layout actually reproduce the browser's layout.

    anchor_check.py layout.json snapshot.json [--tolerance 3] [--verbose]

`layout.json`    produced by the converter
`snapshot.json`  produced by the same run with `--dump-snapshot` (needs --probe viewports)

For every node that carries a CanvasPanelSlot it:
  1. finds the source element in the primary snapshot,
  2. derives the rect UMG would produce at each probe viewport, using UMG's own
     CanvasPanelSlot maths (point anchors use Right/Bottom as width/height, stretched
     anchors use them as margins),
  3. compares it with the rect the browser actually produced at that viewport.

A device-independent layout keeps the error small at *every* probe. A node that was
"pinned" instead of stretched matches at the design size and then drifts - which is
exactly the failure this reports.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def source_key(source: str) -> tuple[str, str, str]:
    """'div#header.toolbar' -> ('div', 'header', 'toolbar'); 'div.card' -> ('div', '', 'card')."""
    text = (source or "").strip()
    tag = text.split("#")[0].split(".")[0] or "*"
    ident = ""
    if "#" in text:
        ident = text.split("#", 1)[1].split(".")[0]
    klass = text.split(".", 1)[1] if "." in text and tag else ""
    return tag, ident, klass


def containing_block(elements: list[dict], element: dict, view_w: float, view_h: float) -> list[float]:
    """Rect that an absolutely positioned element's offsets resolve against.

    CSS rule: the nearest *positioned* ancestor, otherwise the viewport (initial containing
    block). Using the plain DOM parent instead is wrong whenever the parent is statically
    positioned - which is the common case - and turns into hundreds of px of false error.
    """
    index = element.get("p")
    guard = 0
    while isinstance(index, int) and 0 <= index < len(elements) and guard < 512:
        ancestor = elements[index]
        position = ((ancestor.get("cs") or {}).get("position") or "static")
        if position != "static":
            rect = ancestor.get("rect")
            if rect:
                return [float(v) for v in rect]
        index = ancestor.get("p")
        guard += 1
    return [0.0, 0.0, float(view_w), float(view_h)]


def find_element(elements: list[dict], target: dict) -> dict | None:
    """Match a snapshot element record by (tag, id) then by (tag, classes)."""
    tag = target.get("tag")
    ident = target.get("id") or ""
    for element in elements:
        if element.get("tag") != tag:
            continue
        if ident:
            if (element.get("id") or "") == ident:
                return element
        elif not element.get("id"):
            target_classes = set(target.get("cls") or [])
            if target_classes and set(element.get("cls") or []) == target_classes:
                return element
    return None


def predict_rect(layout_data: dict, parent_w: float, parent_h: float) -> tuple[float, float, float, float]:
    """UMG UCanvasPanelSlot geometry -> (x, y, w, h) in the parent's local space."""
    anchors = layout_data.get("Anchors") or {}
    offsets = layout_data.get("Offsets") or {}
    alignment = layout_data.get("Alignment") or [0.0, 0.0]

    min_x, min_y = (anchors.get("Minimum") or [0, 0])[:2]
    max_x, max_y = (anchors.get("Maximum") or [0, 0])[:2]

    left = float(offsets.get("Left", 0.0) or 0.0)
    top = float(offsets.get("Top", 0.0) or 0.0)
    right = float(offsets.get("Right", 0.0) or 0.0)
    bottom = float(offsets.get("Bottom", 0.0) or 0.0)
    align_x = float(alignment[0]) if len(alignment) > 0 else 0.0
    align_y = float(alignment[1]) if len(alignment) > 1 else 0.0

    # Authoritative maths, copied from SConstraintCanvas::ArrangeLayeredChildren (UE 5.8):
    #   point axis : SlotSize = (Offset.Right, Offset.Bottom); pos = anchorPx + Offset.Left - Size*Alignment
    #   stretched  : pos = anchorPx.Min + Offset.Left; size = anchorPx.Max - pos - Offset.Right
    # i.e. for a point anchor Right/Bottom are the SIZE, for a stretched anchor they are a
    # positive margin on the far edge. Getting this backwards makes every report wrong.
    if abs(max_x - min_x) < 1e-6:
        width = right
        x = min_x * parent_w + left - align_x * width
    else:
        x = min_x * parent_w + left
        width = max_x * parent_w - x - right

    if abs(max_y - min_y) < 1e-6:
        height = bottom
        y = min_y * parent_h + top - align_y * height
    else:
        y = min_y * parent_h + top
        height = max_y * parent_h - y - bottom

    return x, y, width, height


def collect_nodes(node: dict, out: list[dict]) -> None:
    layout_data = (node.get("slot") or {}).get("LayoutData")
    if layout_data:
        out.append({"name": node.get("name"), "class": node.get("class"), "source": node.get("source"), "layout": layout_data})
    for child in node.get("children") or []:
        collect_nodes(child, out)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Check anchors across probe viewports.")
    parser.add_argument("layout")
    parser.add_argument("snapshot")
    parser.add_argument("--tolerance", type=float, default=3.0, help="max px error per edge (default 3)")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--fail-on-error", action="store_true")
    args = parser.parse_args(argv)

    with open(args.layout, encoding="utf-8") as handle:
        layout = json.load(handle)
    with open(args.snapshot, encoding="utf-8") as handle:
        snapshot = json.load(handle)

    primary = snapshot["primary"]
    probes = snapshot.get("probes") or []
    viewports: list[tuple[str, dict]] = []
    for index, probe in enumerate(probes):
        viewport = probe.get("viewport") or {}
        viewports.append((f"probe{index+1} {viewport.get('width')}x{viewport.get('height')}", probe))

    design_w = float((layout.get("viewport") or {}).get("width") or primary["viewport"]["width"])
    design_h = float((layout.get("viewport") or {}).get("height") or primary["viewport"]["height"])

    print(f"design viewport : {design_w:.0f}x{design_h:.0f}")
    print(f"probe viewports : {len(probes)}")
    print(f"tolerance       : {args.tolerance} px per edge")
    print()

    nodes: list[dict] = []
    collect_nodes(layout["root"], nodes)

    checked = 0
    findings: list[dict] = []

    for node in nodes:
        tag, ident, klass = source_key(node["source"] or "")
        target = {"tag": tag, "id": ident, "cls": (klass.split(".") if klass else [])}
        element = find_element(primary["elements"], target)
        if element is None:
            if args.verbose:
                print(f"  skip {node['name']}: source '{node['source']}' not found in the snapshot")
            continue

        # The coordinate space a slot resolves in is the CSS containing block: the nearest
        # POSITIONED ancestor, otherwise the viewport. (Using the plain DOM parent is wrong
        # whenever that parent is statically positioned - the common case.)
        parent_rect = containing_block(primary["elements"], element, design_w, design_h)

        primary_rect = element.get("rect") or [0, 0, 0, 0]
        parent_w = float(parent_rect[2]) if parent_rect else design_w
        parent_h = float(parent_rect[3]) if parent_rect else design_h
        parent_x = float(parent_rect[0]) if parent_rect else 0.0
        parent_y = float(parent_rect[1]) if parent_rect else 0.0

        px, py, pw, ph = predict_rect(node["layout"], parent_w, parent_h)
        predicted = (parent_x + px, parent_y + py, pw, ph)
        base_error = max(abs(predicted[i] - primary_rect[i]) for i in range(4))
        checked += 1
        if base_error > args.tolerance:
            findings.append({"name": node["name"], "where": "design viewport", "source": node["source"],
                             "predicted": predicted, "actual": primary_rect, "error": base_error,
                             "layout": node["layout"]})

        # Now the real test: predict at each probe and compare with what the browser did there.
        for label, probe in viewports:
            probe_elements = probe.get("elements") or []
            probe_element = find_element(probe_elements, target)
            if probe_element is None:
                continue
            probe_viewport = probe.get("viewport") or {}
            probe_w = float(probe_viewport.get("width") or design_w)
            probe_h = float(probe_viewport.get("height") or design_h)

            probe_parent_rect = containing_block(probe_elements, probe_element, probe_w, probe_h)

            # A parent that itself resizes cannot be predicted from one anchor set; the browser
            # rect is used so the check stays meaningful for nested panels.
            pparent_w = float(probe_parent_rect[2]) if probe_parent_rect else probe_w
            pparent_h = float(probe_parent_rect[3]) if probe_parent_rect else probe_h
            pparent_x = float(probe_parent_rect[0]) if probe_parent_rect else 0.0
            pparent_y = float(probe_parent_rect[1]) if probe_parent_rect else 0.0

            qx, qy, qw, qh = predict_rect(node["layout"], pparent_w, pparent_h)
            predicted_probe = (pparent_x + qx, pparent_y + qy, qw, qh)
            actual_probe = probe_element.get("rect") or [0, 0, 0, 0]
            error = max(abs(predicted_probe[i] - actual_probe[i]) for i in range(4))
            if error > args.tolerance:
                findings.append({"name": node["name"], "where": label, "source": node["source"],
                                 "predicted": predicted_probe, "actual": actual_probe, "error": error,
                                 "layout": node["layout"]})

    findings.sort(key=lambda item: -item["error"])
    print(f"nodes with a CanvasPanelSlot : {checked}")
    print(f"nodes off tolerance          : {len({f['name'] for f in findings})}")
    print()

    if findings:
        print("WORST OFFENDERS")
        for item in findings[:14]:
            anchors = item["layout"].get("Anchors") or {}
            print(f"  {item['name']:<18} {item['where']:<18} err {item['error']:7.1f}px  "
                  f"anchors {anchors.get('Minimum')}->{anchors.get('Maximum')}")
            print(f"      predicted {[round(v, 1) for v in item['predicted']]}")
            print(f"      actual    {[round(v, 1) for v in item['actual']]}")
    else:
        print("RESULT: CLEAN - every slot reproduces the browser rect at every probe viewport")

    if args.fail_on_error and findings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
