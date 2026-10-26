#!/usr/bin/env python3
"""Compare a browser screenshot against a UMG render and report fidelity.

Usage:
    python pngdiff.py reference.png candidate.png [--out diff.png] [--threshold 8]

Exit code 0 when the differing-pixel ratio is below --max-diff (default: no gate),
1 otherwise. Prints a compact report; writes an amplified diff and a side-by-side
when --out is given.
"""

from __future__ import annotations

import argparse
import os
import sys

from PIL import Image, ImageChops

try:  # Pillow >= 9
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:  # pragma: no cover
    LANCZOS = Image.LANCZOS


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pixel-diff two PNGs.")
    parser.add_argument("reference", help="browser screenshot (ground truth)")
    parser.add_argument("candidate", help="UMG render")
    parser.add_argument("--out", default=None, help="write diff.png / side-by-side.png next to this base path")
    parser.add_argument("--threshold", type=int, default=8,
                        help="per-channel delta above which a pixel counts as different (0-255, default 8)")
    parser.add_argument("--max-diff", type=float, default=None,
                        help="fail when differing ratio (0..1) exceeds this")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    for path in (args.reference, args.candidate):
        if not os.path.isfile(path):
            print(f"error: not found: {path}", file=sys.stderr)
            return 2

    ref = Image.open(args.reference).convert("RGBA")
    cand = Image.open(args.candidate).convert("RGBA")

    resized = False
    if ref.size != cand.size:
        print(f"note: size mismatch {ref.size} vs {cand.size}; resizing candidate to reference")
        cand = cand.resize(ref.size, LANCZOS)
        resized = True

    width, height = ref.size
    total = width * height

    diff = ImageChops.difference(ref, cand)
    # Collapse RGB (+ alpha) into a single "worst channel" mask.
    r, g, b, a = diff.split()
    worst = ImageChops.lighter(ImageChops.lighter(r, g), ImageChops.lighter(b, a))
    histogram = worst.histogram()

    differing = sum(histogram[args.threshold + 1:])
    ratio = differing / total if total else 0.0

    # Mean absolute error across channels, a smoother signal than the hard ratio.
    stat = diff.split()
    sums = [sum(i * v for i, v in enumerate(channel.histogram())) for channel in stat]
    mae = sum(sums) / (total * 4 * 255) if total else 0.0

    print(f"reference : {args.reference}  {width}x{height}")
    print(f"candidate : {args.candidate}{'  (resized)' if resized else ''}")
    print(f"threshold : per-channel delta > {args.threshold}")
    print(f"differing : {differing} / {total} px  = {ratio * 100:.2f}%")
    print(f"mean abs  : {mae * 100:.2f}%")

    if args.out:
        base, _ = os.path.splitext(args.out)
        # Amplify the diff so faint deviations are visible at a glance.
        amplified = worst.point(lambda v: min(255, v * 4))
        heat = Image.merge("RGBA", (amplified, amplified.point(lambda v: v // 4), amplified.point(lambda v: 0), amplified))
        heat.save(base + "_diff.png")

        sheet = Image.new("RGBA", (width * 2 + 8, height), (24, 24, 28, 255))
        sheet.paste(ref, (0, 0))
        sheet.paste(cand, (width + 8, 0))
        sheet.save(base + "_side.png")
        print(f"wrote     : {base}_diff.png, {base}_side.png")

    if args.max_diff is not None and ratio > args.max_diff:
        print(f"FAIL: {ratio * 100:.2f}% > limit {args.max_diff * 100:.2f}%")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
