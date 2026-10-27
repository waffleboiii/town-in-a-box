"""Shared paths, grid config and projection for the Town-in-a-Box pipeline.

The grid/bbox live in web/shared/config.json so Python and TypeScript agree.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PIPELINE = REPO / "pipeline"
RAW = PIPELINE / "data" / "raw"
GROUND_TRUTH = PIPELINE / "data" / "ground_truth"
OUT = PIPELINE / "out"
WEB = REPO / "web"
WEB_DATA = WEB / "public" / "data"
SHARED = WEB / "shared"

for _d in (RAW, GROUND_TRUTH, OUT, WEB_DATA, WEB_DATA / "scenarios"):
    _d.mkdir(parents=True, exist_ok=True)

CONFIG = json.loads((SHARED / "config.json").read_text(encoding="utf-8"))
BBOX = CONFIG["bbox"]
W = CONFIG["gridWidth"]
H = CONFIG["gridHeight"]
TILE_M = CONFIG["tileMeters"]
TILE_TYPES: list[str] = CONFIG["tileTypes"]
TILE = {name: i for i, name in enumerate(TILE_TYPES)}

PERSONA_PARQUET_URLS = [
    f"https://huggingface.co/datasets/nvidia/Nemotron-Personas-France/resolve/main/data/train-{i:05d}-of-00012.parquet"
    for i in range(12)
]


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    """Continuous tile coordinates (see web/src/types.ts)."""
    x = (lon - BBOX["lonMin"]) / (BBOX["lonMax"] - BBOX["lonMin"]) * W
    y = (BBOX["latMax"] - lat) / (BBOX["latMax"] - BBOX["latMin"]) * H
    return x, y


def xy_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = BBOX["lonMin"] + x / W * (BBOX["lonMax"] - BBOX["lonMin"])
    lat = BBOX["latMax"] - y / H * (BBOX["latMax"] - BBOX["latMin"])
    return lon, lat


def tile_distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1]) * TILE_M


def load_env() -> None:
    """Load the repo-root .env (API keys). Never print key values."""
    try:
        from dotenv import load_dotenv

        load_dotenv(REPO / ".env")
    except ImportError:
        pass


def env(name: str, default: str | None = None) -> str | None:
    load_env()
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def write_json(path: Path, obj, *, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))
