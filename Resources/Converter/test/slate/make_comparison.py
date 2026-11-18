#!/usr/bin/env python3
"""Side-by-side comparison of a browser screenshot and a Slate render.

    python test/slate/make_comparison.py <browser.png> <slate.png> <out.png> [--label NAME]

Writes one image with three panels: browser, Slate, and the per-pixel difference (amplified), plus a
header line with the differing-pixel count. This is the picture that goes with the numbers.
"""

import sys
from PIL import Image, ImageChops, ImageDraw


def diff_panel(a, b):
    """Amplified absolute difference, so a small colour drift is visible."""
    d = ImageChops.difference(a, b).convert("L")
    d = d.point(lambda v: min(255, v * 4))
    return d.convert("RGB")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    label = ""
    for i, a in enumerate(sys.argv[1:]):
        if a == "--label" and i + 2 < len(sys.argv):
            label = sys.argv[i + 2]
    if len(args) < 3:
        print("usage: make_comparison.py <browser.png> <slate.png> <out.png> [--label NAME]")
        return 1
    browser_p, slate_p, out_p = args[0], args[1], args[2]

    a = Image.open(browser_p).convert("RGB")
    b = Image.open(slate_p).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)

    w, h = a.size
    gap = 8
    header = 26
    canvas = Image.new("RGB", (w * 3 + gap * 2, h + header), (24, 26, 30))
    canvas.paste(a, (0, header))
    canvas.paste(b, (w + gap, header))
    d = diff_panel(a, b)
    canvas.paste(d, (w * 2 + gap * 2, header))

    differing = 0
    for pa, pb in zip(a.getdata(), b.getdata()):
        if pa != pb:
            differing += 1
    pct = 100.0 * differing / float(w * h)

    draw = ImageDraw.Draw(canvas)
    draw.text((6, 6), "%s  browser" % (label or "view"), fill=(230, 235, 240))
    draw.text((w + gap + 6, 6), "slate", fill=(230, 235, 240))
    draw.text((w * 2 + gap * 2 + 6, 6),
              "difference x4   %.2f%% of %d px" % (pct, w * h), fill=(230, 235, 240))
    canvas.save(out_p)
    print("%s: %.2f%% differing -> %s" % (label or out_p, pct, out_p))
    return 0


if __name__ == "__main__":
    sys.exit(main())
