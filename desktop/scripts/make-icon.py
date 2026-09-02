"""Render the Desde app icon master: a Chillax "D" on the brand teal squircle."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

REPO = Path(sys.argv[1])
OUT = Path(sys.argv[2])
SS = 4                      # supersample factor
S = 1024                    # final canvas
TEAL = (0, 145, 138, 255)   # oklch(0.575 0.135 190) -> sRGB
INSET = 100                 # macOS Big Sur: 824pt shape on a 1024pt canvas
N = 5.0                     # superellipse exponent — Apple's continuous corner

# Chillax is a variable font; pin wght 500 to match `wordmark.tsx`, which sets
# `font-medium` and documents that the weight is a design decision, not a default.
woff2 = REPO / "src/styles/fonts/Chillax-Variable.woff2"
tmp_ttf = OUT.parent / ".chillax-500.ttf"
f = TTFont(woff2, fontNumber=0)
f = instancer.instantiateVariableFont(f, {"wght": 500})
f.flavor = None
f.save(tmp_ttf)

canvas = S * SS
img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

# The squircle, drawn as a real superellipse rather than a rounded rectangle:
# a rounded rect reads as subtly wrong beside every other icon in the Dock.
half = (S - 2 * INSET) / 2 * SS
cx = cy = canvas / 2
mask = Image.new("L", (canvas, canvas), 0)
mp = mask.load()
for y in range(canvas):
    dy = abs(y - cy) / half
    if dy > 1:
        continue
    # Solve |dx|^N = 1 - |dy|^N for the row's half-width; fill that span.
    span = (1 - dy ** N) ** (1 / N) * half
    x0, x1 = int(cx - span), int(cx + span)
    for x in range(max(0, x0), min(canvas, x1 + 1)):
        mp[x, y] = 255
img.paste(Image.new("RGBA", (canvas, canvas), TEAL), (0, 0), mask)

# The "D", optically centred on the shape (metric centring sits it low and left).
draw = ImageDraw.Draw(img)
font = ImageFont.truetype(str(tmp_ttf), int(560 * SS))
l, t, r, b = draw.textbbox((0, 0), "D", font=font)
draw.text((cx - (l + r) / 2, cy - (t + b) / 2), "D", font=font, fill=(255, 255, 255, 255))

img.resize((S, S), Image.LANCZOS).save(OUT)
tmp_ttf.unlink()
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
