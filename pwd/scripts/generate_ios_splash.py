#!/usr/bin/env python3
"""Build launch.png and per-device iOS splash PNGs (#121018 + centered app icon)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

PWD = Path(__file__).resolve().parents[1]
ICON = PWD / "icon-512.png"
LAUNCH = PWD / "launch.png"
SPLASH = PWD / "splash"

BG = (18, 16, 24)

PORTRAIT = (
    "640x1136",
    "750x1334",
    "1125x2436",
    "1170x2532",
    "1179x2556",
    "1242x2208",
    "828x1792",
    "1242x2688",
    "1284x2778",
    "1290x2796",
)
LANDSCAPE = (
    "1136x640",
    "1334x750",
    "2436x1125",
    "2532x1170",
    "2556x1179",
    "2208x1242",
    "1792x828",
    "2688x1242",
    "2778x1284",
    "2796x1290",
)


def compose_launch(width: int, height: int) -> Image.Image:
    canvas = Image.new("RGB", (width, height), BG)
    icon = Image.open(ICON).convert("RGBA")
    edge = min(width, height)
    size = max(128, int(edge * 0.34))
    icon = icon.resize((size, size), Image.Resampling.LANCZOS)
    x = (width - size) // 2
    y = (height - size) // 2
    canvas.paste(icon, (x, y), icon)
    return canvas


def resize_with_sips(src: Path, out: Path, width: int, height: int) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["sips", "-z", str(height), str(width), str(src), "--out", str(out)],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def main() -> int:
    if not ICON.is_file():
        print(f"error: missing {ICON}", file=sys.stderr)
        return 1

    launch = compose_launch(1290, 2796)
    launch.save(LAUNCH)
    SPLASH.mkdir(parents=True, exist_ok=True)

    for size in (*PORTRAIT, *LANDSCAPE):
        w, h = (int(part) for part in size.split("x"))
        resize_with_sips(LAUNCH, SPLASH / f"splash-{size}.png", w, h)

    print(f"Wrote {LAUNCH.name} and {len(PORTRAIT) + len(LANDSCAPE)} splash images to {SPLASH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
