"""Stitch harness stills into one contact sheet per asset (runs anywhere with PIL).

Usage: python3 contact_sheet.py <previews_dir/name> [out.png]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ORDER = ["front", "right", "back", "tq", "bust"]


def stitch(folder: Path, out: Path | None = None) -> Path:
    imgs = []
    for v in ORDER:
        p = folder / f"{v}.png"
        if p.exists():
            imgs.append((v, Image.open(p).convert("RGB")))
    if not imgs:
        raise SystemExit(f"no stills in {folder}")
    w, h = imgs[0][1].size
    tw, th = w // 2, h // 2
    sheet = Image.new("RGB", (tw * len(imgs), th + 24), "#14161c")
    d = ImageDraw.Draw(sheet)
    for i, (v, im) in enumerate(imgs):
        sheet.paste(im.resize((tw, th)), (i * tw, 24))
        d.text((i * tw + 8, 6), f"{folder.name}/{v}", fill="#A9B2BD")
    out = out or folder / "contact_sheet.png"
    sheet.save(out)
    return out


if __name__ == "__main__":
    folder = Path(sys.argv[1])
    print(stitch(folder, Path(sys.argv[2]) if len(sys.argv) > 2 else None))
