#!/usr/bin/env python3
"""Numeric visual audit for Html2UMG: turn "it looks wrong" into a ranked list of elements.

This is the script counterpart to pngdiff.py. pngdiff answers "how different is it";
this answers "WHERE, WHICH ELEMENT, and in WHAT way", without anyone having to look at
a picture:

  1. global differing-pixel ratio
  2. an ASCII density map, so the shape of the error is visible in a terminal
  3. a per-element ranking: every browser element rect is projected onto the diff mask,
     so the worst offenders come first (this is what localises a defect to a control)
  4. accent-colour probes: a control whose baked texture is not being drawn shows up as
     "expected colour present in the browser, absent in the render"

Usage:
    python visual_audit.py browser.png umg.png --snapshot snap.json [--top 20]
    python visual_audit.py browser.png umg.png --snapshot snap.json --shift -48 -48

--snapshot is the file written by the converter's --dump-snapshot. Without it stages 1-2
and 4 still run; only the per-element ranking (stage 3) needs the element rects.

Exit code: 0 always (this is a report, not a gate). Use pngdiff.py --max-diff to gate CI.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from collections import Counter

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover
    print("error: needs Pillow and numpy", file=sys.stderr)
    raise SystemExit(2)

# Colours worth asserting on: if the browser shows them and the render does not, the
# control's baked texture (or its tint) is wrong. Extend per project as needed.
ACCENTS = [
    ("slider/select blue", (63, 169, 245)),
    ("checkbox green", (63, 185, 80)),
    ("radio orange", (210, 153, 34)),
    ("progress green", (0, 128, 0)),
    ("primary button blue", (31, 111, 235)),
]

ASCII = " .:-=+*#%@"


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)


def shifted(image: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """Translate image by (dx, dy), zero-filling the vacated edge."""
    h, w, _ = image.shape
    out = np.zeros_like(image)
    ys0, ys1 = max(0, dy), min(h, h + dy)
    xs0, xs1 = max(0, dx), min(w, w + dx)
    out[ys0:ys1, xs0:xs1] = image[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
    return out


def density_map(mask: np.ndarray, width: int = 110) -> None:
    h, w = mask.shape
    cols = min(width, w)
    rows = max(1, int(cols * h / w * 0.46))
    ch, cw = h / rows, w / cols
    print(f"\n=== diff density map ({int(cw)}x{int(ch)} px per cell) ===")
    for gy in range(rows):
        line = ""
        for gx in range(cols):
            block = mask[int(gy * ch):int((gy + 1) * ch), int(gx * cw):int((gx + 1) * cw)]
            line += ASCII[min(len(ASCII) - 1, int(block.mean() * len(ASCII) * 2.2))]
        print(f"{int(gy * ch):5d} {line}")


def best_shift(ref: np.ndarray, cand: np.ndarray, radius: int = 64, step: int = 4) -> tuple[int, int]:
    """Coarse-to-fine search for the offset that best aligns cand onto ref.

    A non-zero result means the whole layout is translated, which in this pipeline almost
    always means a container padding was applied on top of absolute child coordinates.
    """
    def score(dx: int, dy: int) -> float:
        moved = shifted(cand, dx, dy)
        # Ignore the zero-filled edge so it does not dominate the score.
        h, w, _ = ref.shape
        m = min(abs(dx) + 2, w), min(abs(dy) + 2, h)
        core = (slice(m[1], h - m[1]), slice(m[0], w - m[0]))
        return float((np.abs(ref[core] - moved[core]).max(axis=2) > 8).mean())

    best = (0, 0)
    best_score = score(0, 0)
    coarse = range(-radius, radius + 1, step)
    for dy in coarse:
        for dx in coarse:
            s = score(dx, dy)
            if s < best_score:
                best, best_score = (dx, dy), s
    bx, by = best
    for dy in range(by - step, by + step + 1):
        for dx in range(bx - step, bx + step + 1):
            s = score(dx, dy)
            if s < best_score:
                best, best_score = (dx, dy), s
    return best, best_score


def element_ranking(mask: np.ndarray, snapshot: str, top: int) -> None:
    with io.open(snapshot, encoding="utf-8") as handle:
        data = json.load(handle)
    primary = data.get("primary", data)
    elements = primary.get("elements", [])
    if not elements:
        print("snapshot has no elements; skipping per-element ranking")
        return

    h, w = mask.shape
    rows = []
    for element in elements:
        x, y, ew, eh = (int(v) for v in element.get("rect", [0, 0, 0, 0]))
        if ew < 4 or eh < 4:
            continue
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(w, x + ew), min(h, y + eh)
        if x1 <= x0 or y1 <= y0:
            continue
        block = mask[y0:y1, x0:x1]
        label = element.get("tag", "?")
        if element.get("id"):
            label += "#" + element["id"]
        classes = element.get("cls") or []
        if classes:
            label += "." + ".".join(classes)
        rows.append((block.mean(), label, (x, y, ew, eh), int(block.sum())))

    rows.sort(reverse=True)
    print(f"\n=== per-element diff ranking (worst {min(top, len(rows))} of {len(rows)}) ===")
    print(f"{'element':<40}{'diff%':>8}{'px':>9}   rect x,y,w,h")
    for fraction, label, rect, count in rows[:top]:
        print(f"{label:<40}{fraction * 100:7.1f}%{count:9d}   {rect}")


def colour_probes(ref: np.ndarray, cand: np.ndarray, tolerance: int = 6) -> None:
    print("\n=== accent colour probes ===")
    print(f"{'colour':<24}{'browser':>10}{'render':>10}   verdict")
    for name, colour in ACCENTS:
        target = np.array(colour, dtype=np.int16)
        in_ref = int((np.abs(ref - target).max(axis=2) <= tolerance).sum())
        in_cand = int((np.abs(cand - target).max(axis=2) <= tolerance).sum())
        if in_ref > 50 and in_cand == 0:
            verdict = "MISSING in render - baked texture not drawn / tinted away"
        elif in_ref > 50 and in_cand < in_ref * 0.3:
            verdict = "mostly missing - check state or tint"
        elif in_ref > 50:
            verdict = "present"
        else:
            verdict = "not in reference"
        print(f"{name:<24}{in_ref:>10}{in_cand:>10}   {verdict}")




def _content_bands(present, min_run: int = 2):
    """Contiguous index ranges where `present` is true, ignoring runs shorter than min_run."""
    bands = []
    start = None
    for index, value in enumerate(present):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start >= min_run:
                bands.append((start, index - 1))
            start = None
    if start is not None:
        bands.append((start, len(present) - 1))
    return bands


def structural_alignment(ref: np.ndarray, cand: np.ndarray, threshold: int = 10, limit: int = 40,
                        strip: tuple[int, int] | None = None):
    """Compare ROW bands of visible content between the two images.

    A pixel ratio is a poor proxy for layout error in a dark UI: sliding dark-on-dark content a
    hundred pixels can change very few pixels while being glaringly wrong to a person. Band
    alignment asks the layout question directly - does the same content row start at the same y -
    so a progressive per-row drift shows up as a growing dy column.
    """
    if strip is not None:
        x0, x1 = max(0, strip[0]), min(ref.shape[1], strip[1])
        ref = ref[:, x0:x1]
        cand = cand[:, x0:x1]
        print(f"\n(strip x {x0}..{x1 - 1}; pass --strip to focus a column when the page is one band)")
    background = np.bincount(ref.reshape(-1, 3).dot([1, 256, 65536])).argmax()
    bg = np.array([background & 0xFF, (background >> 8) & 0xFF, (background >> 16) & 0xFF])
    ref_rows = (np.abs(ref - bg).max(axis=2) > threshold).any(axis=1)
    cand_rows = (np.abs(cand - bg).max(axis=2) > threshold).any(axis=1)
    ref_bands = _content_bands(ref_rows)
    cand_bands = _content_bands(cand_rows)
    print(f"\n=== vertical band alignment (background rgb{tuple(int(v) for v in bg)}) ===")
    print(f"{'browser band':<20}{'render band':<20}{'dy':>6}{'d-height':>10}")
    worst = 0
    for index in range(min(len(ref_bands), len(cand_bands), limit)):
        rb, cb = ref_bands[index], cand_bands[index]
        dy = cb[0] - rb[0]
        dh = (cb[1] - cb[0]) - (rb[1] - rb[0])
        worst = max(worst, abs(dy))
        flag = '   <<<' if abs(dy) > 8 or abs(dh) > 8 else ''
        print(f"{str(rb):<20}{str(cb):<20}{dy:+6d}{dh:+10d}{flag}")
    if len(ref_bands) != len(cand_bands):
        print(f"  note: {len(ref_bands)} bands in the reference vs {len(cand_bands)} in the render")
    print(f"  worst |dy| = {worst}px")


def edge_match(ref: np.ndarray, cand: np.ndarray, tolerance: int = 2, threshold: int = 24) -> float:
    """Fraction of reference edges that have a render edge within `tolerance` pixels."""
    def edges(image):
        grey = image.mean(axis=2)
        gx = np.zeros_like(grey)
        gy = np.zeros_like(grey)
        gx[:, 1:-1] = np.abs(grey[:, 2:] - grey[:, :-2])
        gy[1:-1, :] = np.abs(grey[2:, :] - grey[:-2, :])
        return (np.maximum(gx, gy) > threshold)

    ref_edges = edges(ref)
    cand_edges = edges(cand)
    if not ref_edges.any():
        return 1.0
    grown = cand_edges.copy()
    for dy in range(-tolerance, tolerance + 1):
        for dx in range(-tolerance, tolerance + 1):
            grown |= np.roll(np.roll(cand_edges, dy, axis=0), dx, axis=1)
    return float((ref_edges & grown).sum()) / float(ref_edges.sum())

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Numeric visual audit of an Html2UMG render.")
    parser.add_argument("reference", help="browser screenshot (ground truth)")
    parser.add_argument("candidate", help="UMG render")
    parser.add_argument("--snapshot", default=None, help="converter --dump-snapshot json (for per-element ranking)")
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--shift", nargs=2, type=int, metavar=("DX", "DY"), default=None,
                        help="compensate a known translation before diffing")
    parser.add_argument("--no-map", action="store_true", help="skip the ASCII density map")
    parser.add_argument("--threshold", type=int, default=8)
    parser.add_argument("--tolerance", type=int, default=6, help="colour probe tolerance")
    parser.add_argument("--edge-tolerance", type=int, default=2, help="pixel slack for the edge match")
    parser.add_argument("--no-structure", action="store_true", help="skip edge match and band alignment")
    parser.add_argument("--strip", nargs=2, type=int, metavar=("X0", "X1"), default=None,
                        help="column strip used for band alignment, e.g. --strip 89 790 (a panel interior)")
    args = parser.parse_args(argv)

    for path in (args.reference, args.candidate):
        if not os.path.isfile(path):
            print(f"error: not found: {path}", file=sys.stderr)
            return 2

    ref = load(args.reference)
    cand = load(args.candidate)
    if ref.shape != cand.shape:
        print(f"note: size mismatch {ref.shape[1]}x{ref.shape[0]} vs {cand.shape[1]}x{cand.shape[0]}; "
              f"resizing candidate")
        cand = np.asarray(Image.open(args.candidate).convert("RGB").resize(
            (ref.shape[1], ref.shape[0]), Image.LANCZOS), dtype=np.int16)

    if args.shift:
        cand = shifted(cand, args.shift[0], args.shift[1])
    else:
        (dx, dy), aligned = best_shift(ref, cand)
        baseline = float((np.abs(ref - cand).max(axis=2) > args.threshold).mean())
        if (dx, dy) != (0, 0):
            print(f"translation detected: render is off by ({dx}, {dy}) px  "
                  f"[{baseline * 100:.2f}% -> {aligned * 100:.2f}% after compensation]")
            print("  a uniform offset usually means container padding was applied on top of "
                  "absolute child coordinates")
        cand = shifted(cand, dx, dy)

    mask = np.abs(ref - cand).max(axis=2) > args.threshold
    print(f"\nreference : {args.reference}")
    print(f"candidate : {args.candidate}")
    print(f"threshold : per-channel delta > {args.threshold}")
    print(f"differing : {int(mask.sum())} / {mask.size} px = {mask.mean() * 100:.2f}%")

    if not args.no_map:
        density_map(mask)
    if args.snapshot:
        element_ranking(mask, args.snapshot, args.top)
    colour_probes(ref, cand, args.tolerance)
    if not args.no_structure:
        print(f"\nstructural edge match (reference edges found in the render within {args.edge_tolerance}px): "
              f"{edge_match(ref, cand, args.edge_tolerance) * 100:.1f}%")
        structural_alignment(ref, cand, args.threshold, strip=tuple(args.strip) if args.strip else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))