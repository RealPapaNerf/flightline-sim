#!/usr/bin/env python3
"""Draw the Flightline app icons (original artwork): a plank wing climbing over a
horizon line. Run from the repo root: python3 tools/make_icons.py"""
import math
import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)

INK = (15, 21, 25)
PANEL = (27, 37, 43)
YELLOW = (245, 194, 66)
SKY = (124, 203, 230)


def draw(size, art_scale):
    S = 1024
    im = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(im)
    c = S / 2
    k = art_scale

    def P(x, y, ang=0):
        # rotate a point (units: fraction of S around centre) to show a climb
        a = math.radians(ang)
        xr, yr = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)
        return (c + xr * S * k, c + yr * S * k)

    # soft disc behind the art
    r = 0.44 * S * k
    d.ellipse([c - r, c - r, c + r, c + r], fill=PANEL)
    # horizon line, slightly below centre
    hy = c + 0.17 * S * k
    d.line([(c - 0.36 * S * k, hy), (c + 0.36 * S * k, hy)], fill=SKY, width=int(22 * k))
    # plank wing planform seen from above, nose up-right
    wing = [P(0.0, -0.26), P(0.33, -0.02), P(0.33, 0.04), P(0.04, -0.01), P(-0.04, -0.01), P(-0.33, 0.04), P(-0.33, -0.02)]
    d.polygon(wing, fill=YELLOW)
    # centre pod
    d.polygon([P(-0.032, -0.23), P(0.032, -0.23), P(0.028, 0.02), P(-0.028, 0.02)], fill=(212, 160, 40))
    return im.resize((size, size), Image.LANCZOS)


draw(192, 1.0).save(OUT / "icon-192.png")
draw(512, 1.0).save(OUT / "icon-512.png")
draw(512, 0.78).save(OUT / "icon-maskable-512.png")  # art inside the maskable safe zone
print("icons written to", OUT)
