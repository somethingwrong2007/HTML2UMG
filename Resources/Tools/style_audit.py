#!/usr/bin/env python3
"""Audit that the colours / borders written in a layout.json actually landed in the asset.

    style_audit.py layout.json dump.json [--tolerance 0.02] [--verbose] [--fail-on-mismatch]

`dump.json` comes from the editor:

    Html2UMG.DumpWidgets <blueprintPath> --json=<dump.json>

It is a flat `{"blueprint": "...", "widgets": [{"class","name","properties":{dotted.path: value}}]}`.
This script flattens the layout contract's nested `properties` / `brush` blocks into the same
dotted paths and compares them pairwise, so a missing colour shows up as a named difference
instead of "it looked fine".

Leaf conventions that are compared:
  colour / vector / margin -> list of numbers (tolerance per component)
  number                   -> tolerance
  enum / string            -> case-insensitive exact
  bool                     -> exact
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

# brush-ish keys in the contract, mapped to the reflected FSlateBrush fields.
BRUSH_LEAF_MAP = {
    "tint": "TintColor",
    "cornerRadii": "OutlineSettings.CornerRadii",
    "outlineWidth": "OutlineSettings.Width",
    "outlineColor": "OutlineSettings.Color",
    "drawAs": "DrawAs",
    "margin": "Margin",
    "imageSize": "ImageSize",
    "tiling": "Tiling",
    # The contract names the asset reference "texture"; the reflected field is ResourceObject.
    "texture": "ResourceObject",
}

# Where a node-level "brush" ends up, by widget class.
NODE_BRUSH_PROPERTY = {
    "Border": "Background",
    "Image": "Brush",
    "Button": "WidgetStyle.Normal",
}


def looks_like_brush(obj: dict) -> bool:
    keys = set(obj.keys())
    return bool(keys) and keys.issubset(set(BRUSH_LEAF_MAP) | {"states"}) and bool(
        keys & {"tint", "drawAs", "cornerRadii", "outlineColor", "outlineWidth"}
    )


def flatten(value: Any, prefix: str, out: dict[str, Any]) -> None:
    if isinstance(value, dict):
        if looks_like_brush(value):
            for key, item in value.items():
                if key == "states":
                    continue
                field = BRUSH_LEAF_MAP.get(key)
                if field:
                    out[f"{prefix}.{field}" if prefix else field] = item
            return
        for key, item in value.items():
            flatten(item, f"{prefix}.{key}" if prefix else key, out)
        return
    out[prefix] = value


def collect_layout_nodes(node: dict, out: dict[str, dict]) -> None:
    name = node.get("name")
    if name:
        properties: dict[str, Any] = {}
        flatten(node.get("properties") or {}, "", properties)

        brush = node.get("brush")
        if isinstance(brush, dict):
            widget_class = node.get("class", "")
            base = NODE_BRUSH_PROPERTY.get(widget_class)
            # A style struct that is itself a brush (e.g. ItemStyle.ActiveBrush) is already
            # handled by flatten() because it sits inside `properties`.
            if base and not looks_like_brush({k: v for k, v in (node.get("properties") or {}).items()}):
                flatten(brush, base, properties)
            elif base:
                flatten(brush, base, properties)

        out[name] = {"class": node.get("class", ""), "properties": properties}

    for child in node.get("children") or []:
        collect_layout_nodes(child, out)


def same(actual: Any, expected: Any, tolerance: float) -> bool:
    # "@key" is an asset reference in the layout; the asset holds the resolved object path.
    # Only presence can be compared, not identity, because the mapping belongs to the importer.
    if isinstance(expected, str) and expected.startswith("@"):
        return isinstance(actual, str) and actual.strip() != "" and not actual.startswith("@")
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return abs(float(actual) - float(expected)) <= tolerance
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return False
        return all(
            same(a, e, tolerance) if isinstance(e, (int, float)) else str(a) == str(e)
            for a, e in zip(actual, expected)
        )
    if isinstance(expected, bool) or isinstance(actual, bool):
        return bool(actual) == bool(expected)
    if expected is None:
        return actual is None
    return str(actual).strip().lower() == str(expected).strip().lower()


def short(value: Any, limit: int = 64) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[: limit - 1] + "…"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Compare layout.json styles with the imported asset.")
    parser.add_argument("layout", help="layout.json produced by the converter")
    parser.add_argument("dump", help="dump.json produced by Html2UMG.DumpWidgets --json")
    parser.add_argument("--tolerance", type=float, default=0.02)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--fail-on-mismatch", action="store_true")
    args = parser.parse_args(argv)

    for path in (args.layout, args.dump):
        if not os.path.isfile(path):
            print(f"error: not found: {path}", file=sys.stderr)
            return 2

    with open(args.layout, encoding="utf-8") as handle:
        layout = json.load(handle)
    with open(args.dump, encoding="utf-8") as handle:
        dump = json.load(handle)

    layout_nodes: dict[str, dict] = {}
    collect_layout_nodes(layout["root"], layout_nodes)

    dumped: dict[str, dict] = {}
    for widget in dump.get("widgets", []):
        name = widget.get("name")
        if name:
            dumped[name] = widget

    print(f"blueprint : {dump.get('blueprint', '?')}")
    print(f"layout    : {len(layout_nodes)} nodes, {sum(len(n['properties']) for n in layout_nodes.values())} style keys")
    print(f"asset     : {len(dumped)} widgets")
    print(f"tolerance : {args.tolerance}")
    print()

    matched = compared = 0
    mismatches: list[tuple[str, str, Any, Any]] = []
    missing_widgets: list[str] = []
    missing_keys: list[tuple[str, str, Any]] = []

    for name, info in layout_nodes.items():
        widget = dumped.get(name)
        if widget is None:
            missing_widgets.append(name)
            continue
        actual_props = widget.get("properties") or {}
        for key, expected in info["properties"].items():
            compared += 1
            if key not in actual_props:
                missing_keys.append((name, key, expected))
                continue
            actual = actual_props[key]
            if same(actual, expected, args.tolerance):
                matched += 1
            else:
                mismatches.append((name, key, expected, actual))
        if args.verbose and not info["properties"]:
            print(f"  {name}: no style keys in the layout")

    print(f"checked keys : {compared}")
    print(f"matched      : {matched}")

    if missing_keys:
        print(f"\nNOT PRESENT IN ASSET ({len(missing_keys)}):")
        for name, key, expected in missing_keys[:40]:
            print(f"  {name}.{key} = {short(expected)}")

    if mismatches:
        print(f"\nVALUE MISMATCH ({len(mismatches)}):")
        for name, key, expected, actual in mismatches[:40]:
            print(f"  {name}.{key}")
            print(f"      layout {short(expected)}")
            print(f"      asset  {short(actual)}")

    if missing_widgets:
        print(f"\nWIDGETS NOT IN ASSET ({len(missing_widgets)}):")
        print("  " + ", ".join(missing_widgets[:30]))

    problems = len(missing_keys) + len(mismatches)
    print(f"\nRESULT: {'CLEAN' if problems == 0 else f'{problems} problem(s)'}")
    if args.fail_on_mismatch and problems:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
