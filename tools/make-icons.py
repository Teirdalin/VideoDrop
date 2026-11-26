"""Generate the original toolbar icon without external assets. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "extension" / "icons"
out.mkdir(parents=True, exist_ok=True)
scale = 4
image = Image.new("RGBA", (128 * scale, 128 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 504, 504), radius=136, fill="#247768")
def line(points, color, width):
    points = [(x * scale, y * scale) for x, y in points]
    draw.line(points, fill=color, width=width * scale, joint="curve")
    for x, y in points:
        r = width * scale / 2
        draw.ellipse((x-r, y-r, x+r, y+r), fill=color)
line([(64, 25), (64, 74)], "#ffffff", 9)
line([(45, 57), (64, 76), (83, 57)], "#ffffff", 9)
line([(32, 82), (32, 96), (96, 96), (96, 82)], "#b9dfc0", 8)
for size in (16, 32, 48, 128):
    if size == 128:
        store_icon = Image.new("RGBA", (128, 128))
        store_icon.alpha_composite(image.resize((96, 96), Image.Resampling.LANCZOS), (16, 16))
        store_icon.save(out / "128.png")
    else:
        image.resize((size, size), Image.Resampling.LANCZOS).save(out / f"{size}.png")
print(f"Generated four original icons in {out}")
