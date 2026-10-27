"""Quick PNG preview of map.json (no image library needed: just zlib + struct).

Each tile becomes a small square of flat colour; district borders are drawn darker and
landmarks as red dots. Used to eyeball the map while tuning pipeline/build_map.py.

Usage:
    python pipeline/map_preview.py                 # reads web/public/data/map.json
    python pipeline/map_preview.py --scale 4 --out pipeline/out/map_preview_big.png
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, WEB_DATA, read_json  # noqa: E402

# Simple flat colours per tile type (preview only; the web renderer draws the real pixel art).
COLOURS = {
    "outside": (196, 190, 170),
    "water": (64, 132, 200),
    "grass": (150, 200, 110),
    "park": (96, 172, 80),
    "forest": (40, 110, 50),
    "plaza": (226, 214, 180),
    "haussmann": (214, 188, 150),
    "suburb_house": (206, 130, 110),
    "suburb_tower": (150, 140, 160),
    "industrial": (160, 150, 120),
    "ring_road": (60, 60, 60),
    "rail": (120, 80, 60),
    "street": (245, 245, 235),
}


def png_bytes(rgb: np.ndarray) -> bytes:
    """Encode an (h, w, 3) uint8 array as a PNG file."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))  # filter byte 0 per row

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def render(map_file: dict, scale: int = 3, borders: bool = True) -> np.ndarray:
    w, h = map_file["width"], map_file["height"]
    tiles = np.array(map_file["tiles"]).reshape(h, w)
    dist = np.array(map_file["districts"]).reshape(h, w)
    palette = np.array([COLOURS.get(n, (255, 0, 255)) for n in map_file["tileTypes"]], dtype=np.uint8)
    img = palette[tiles]  # (h, w, 3)
    img = np.repeat(np.repeat(img, scale, axis=0), scale, axis=1)
    if borders:
        # darken the pixels on the right/bottom edge of a tile whose neighbour is another district
        edge_r = np.zeros((h, w), dtype=bool)
        edge_b = np.zeros((h, w), dtype=bool)
        edge_r[:, :-1] = dist[:, :-1] != dist[:, 1:]
        edge_b[:-1, :] = dist[:-1, :] != dist[1:, :]
        for y, x in zip(*np.nonzero(edge_r)):
            px = img[y * scale:(y + 1) * scale, (x + 1) * scale - 1]
            px[:] = (px * 0.45).astype(np.uint8)
        for y, x in zip(*np.nonzero(edge_b)):
            px = img[(y + 1) * scale - 1, x * scale:(x + 1) * scale]
            px[:] = (px * 0.45).astype(np.uint8)
    for lm in map_file.get("landmarks", []):
        cx, cy = int(lm["x"] * scale), int(lm["y"] * scale)
        img[max(0, cy - 3):cy + 4, max(0, cx - 3):cx + 4] = (220, 30, 30)
    seine = map_file.get("seine") or []
    for x, y in seine:  # Seine polyline vertices as small cyan dots
        cx, cy = int(x * scale), int(y * scale)
        img[max(0, cy - 1):cy + 1, max(0, cx - 1):cx + 1] = (0, 230, 255)
    return img


def write_preview(map_file: dict, out_path: Path, scale: int = 3, borders: bool = True) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(png_bytes(render(map_file, scale, borders)))
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default=str(WEB_DATA / "map.json"))
    ap.add_argument("--out", default=str(OUT / "map_preview.png"))
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--no-borders", action="store_true")
    ap.add_argument("--crop", default="", help="x0,y0,x1,y1 in tiles (optional zoomed crop)")
    args = ap.parse_args()
    m = read_json(Path(args.map))
    if args.crop:
        x0, y0, x1, y1 = (int(v) for v in args.crop.split(","))
        img = render(m, args.scale, not args.no_borders)[y0 * args.scale:y1 * args.scale, x0 * args.scale:x1 * args.scale]
        Path(args.out).write_bytes(png_bytes(np.ascontiguousarray(img)))
        print("wrote", args.out)
    else:
        print("wrote", write_preview(m, Path(args.out), args.scale, not args.no_borders))


if __name__ == "__main__":
    main()
