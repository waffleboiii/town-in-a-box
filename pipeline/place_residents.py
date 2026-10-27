"""Put the residents on the tile map: district index, home tile and work tile.

Run:   pipeline/.venv/Scripts/python.exe pipeline/place_residents.py
       (build_population.py calls this automatically at the end)
Reads:  pipeline/out/population_full.json   (from build_population.py: district CODES, no tiles)
        web/public/data/map.json            (from build_map.py)
Writes: web/public/data/population.json     (PopulationFile, see web/src/types.ts)
        pipeline/out/population_full.json   (same file, now with districtIdx / home / work added)

If map.json does not exist yet, a rough development map is made from the commune outlines
(pipeline/out/dev/population/map_dev.json) so the rest of the app can be tested; re-run this script
once the real map exists, because district indexes and tiles will change.

Placement rules (all seeded, deterministic):
  home: a building tile (haussmann / suburb_house / suburb_tower) inside the resident's district,
        spread out (a minimum spacing that depends on how many residents share the district),
        unique where possible; social-housing tenants prefer towers, suburban owners with families prefer houses.
  work: a tile in the work district. Job hubs and universities come with a [lon, lat] anchor
        (e.g. La Défense, Saint-Denis Pleyel) and the tile is picked near it. Manual workers prefer industrial tiles.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from common import CONFIG, OUT, RAW, TILE, TILE_TYPES, WEB_DATA, H, W, lonlat_to_xy, read_json, write_json

SEED = 20261026
FULL_PATH = OUT / "population_full.json"
MAP_PATH = WEB_DATA / "map.json"
POP_PATH = WEB_DATA / "population.json"
DEV_DIR = OUT / "dev" / "population"
DEV_MAP = DEV_DIR / "map_dev.json"

HOME_TYPES = ("haussmann", "suburb_house", "suburb_tower")
FALLBACK_TYPES = ("street", "plaza", "grass", "industrial", "park")
WORK_TYPES = ("haussmann", "suburb_tower", "plaza", "street", "industrial", "suburb_house")

# Exactly the fields of `Resident` in web/src/types.ts, in that order.
RESIDENT_FIELDS = [
    "id", "uuid", "name", "sex", "age", "ageBand", "occupation", "occupationGroup", "occupationEn", "education",
    "educationRank", "household", "householdRaw", "maritalStatus", "districtIdx", "districtSource", "home", "work",
    "workDistrictIdx", "commuteMode", "imputed", "eligibleParis", "participationBase", "participationPropensity", "weight", "groupIds",
    "personaFr", "personaEn", "look",
]


# ----------------------------------------------------------------------------------------------
# Development map (only when the real map.json is missing)
# ----------------------------------------------------------------------------------------------
def build_dev_map() -> dict:
    """Rasterise the geo.api.gouv.fr outlines onto the grid; tile types are rough (Paris = haussmann, suburbs =
    houses with some towers). Good enough to test placement, NOT for the demo."""
    import shapely
    from shapely.geometry import shape

    full = read_json(FULL_PATH)
    geo = {}
    for name in ("geo_arrondissements_75.json", "geo_communes_92.json", "geo_communes_93.json", "geo_communes_94.json"):
        for c in json.loads((RAW / "insee" / name).read_text(encoding="utf-8")):
            geo[c["code"]] = shape(c["contour"])
    xs, ys = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    lon = CONFIG["bbox"]["lonMin"] + xs / W * (CONFIG["bbox"]["lonMax"] - CONFIG["bbox"]["lonMin"])
    lat = CONFIG["bbox"]["latMax"] - ys / H * (CONFIG["bbox"]["latMax"] - CONFIG["bbox"]["latMin"])
    districts = np.zeros((H, W), dtype=int)
    tiles = np.full((H, W), TILE["outside"], dtype=int)
    rng = np.random.default_rng(1)
    dlist = []
    for idx, d in enumerate(full["districts"], start=1):
        g = geo.get(d["code"])
        if g is None:
            continue
        inside = shapely.contains_xy(g, lon, lat)
        districts[inside] = idx
        if d["dept"] == "75":
            tiles[inside] = TILE["haussmann"]
        else:
            r = rng.random(inside.sum())
            tiles[inside] = np.where(r < 0.25, TILE["suburb_tower"], np.where(r < 0.9, TILE["suburb_house"], TILE["street"]))
        ty, tx = np.where(inside)
        cx, cy = (float(tx.mean()), float(ty.mean())) if len(tx) else lonlat_to_xy(*d["centre"])
        dlist.append({
            "idx": idx, "code": d["code"], "name": d["name"], "fullName": d["fullName"], "kind": d["kind"], "dept": d["dept"],
            "population": d["population"], "centroid": [round(cx, 2), round(cy, 2)], "labelPos": [round(cx, 2), round(cy, 2)],
            "tileCount": int(inside.sum()),
        })
    m = {
        "version": 1, "width": W, "height": H, "tilePx": CONFIG["tilePx"], "tileMeters": CONFIG["tileMeters"],
        "bbox": CONFIG["bbox"], "tileTypes": TILE_TYPES, "tiles": tiles.ravel().tolist(), "districts": districts.ravel().tolist(),
        "districtList": dlist, "landmarks": [], "sources": [{"name": "DEV MAP from geo.api.gouv.fr outlines", "url": "", "license": ""}],
    }
    write_json(DEV_MAP, m)
    print(f"[place] wrote development map {DEV_MAP}")
    return m


# ----------------------------------------------------------------------------------------------
# Placement
# ----------------------------------------------------------------------------------------------
def home_preference(r: dict, tile_type: str) -> float:
    """How well a building type suits this resident (only a preference; any building tile is allowed)."""
    tenure = r["imputed"]["tenure"]
    suburb = not r["districtCode"].startswith("75")
    w = 1.0
    if tile_type == "suburb_tower":
        w = 3.0 if tenure == "social_renter" else 1.0
        if tenure == "owner" and suburb:
            w = 0.5
    elif tile_type == "suburb_house":
        if tenure == "owner" and r["household"] in ("couple_kids", "couple_no_kids"):
            w = 3.0
        elif tenure == "social_renter":
            w = 0.3
    elif tile_type == "haussmann":
        w = 1.5 if not suburb else 1.0
    return w


def work_preference(r: dict, tile_type: str) -> float:
    g = r["occupationGroup"]
    if g == "ouvriers":
        return {"industrial": 5.0, "street": 1.0, "suburb_tower": 0.8}.get(tile_type, 0.5)
    if g == "artisans":
        return {"street": 2.0, "haussmann": 1.5, "plaza": 1.5}.get(tile_type, 0.8)
    return {"haussmann": 2.0, "suburb_tower": 2.0, "plaza": 1.5, "street": 0.8, "industrial": 0.5}.get(tile_type, 0.3)


class Grid:
    def __init__(self, m: dict):
        self.w, self.h = m["width"], m["height"]
        self.types = m["tileTypes"]
        self.tiles = np.array(m["tiles"]).reshape(self.h, self.w)
        self.dist = np.array(m["districts"]).reshape(self.h, self.w)
        self.code_to_idx = {d["code"]: d["idx"] for d in m["districtList"]}
        self.centroid = {d["idx"]: d["centroid"] for d in m["districtList"]}
        self.by_district: dict[int, list[tuple[int, int, str]]] = {}
        ys, xs = np.nonzero(self.dist)
        for x, y in zip(xs.tolist(), ys.tolist()):
            self.by_district.setdefault(int(self.dist[y, x]), []).append((x, y, self.types[int(self.tiles[y, x])]))

    def candidates(self, idx: int, kinds: tuple[str, ...]) -> list[tuple[int, int, str]]:
        return [c for c in self.by_district.get(idx, []) if c[2] in kinds]

    def district_idx(self, code: str | None, lonlat=None) -> int | None:
        if code is None:
            return None
        if code in self.code_to_idx:
            return self.code_to_idx[code]
        if lonlat:  # unknown code: use the district under the point, else the nearest centroid
            x, y = lonlat_to_xy(*lonlat)
            xi, yi = int(min(self.w - 1, max(0, x))), int(min(self.h - 1, max(0, y)))
            if self.dist[yi, xi]:
                return int(self.dist[yi, xi])
            return min(self.centroid, key=lambda k: math.hypot(self.centroid[k][0] - x, self.centroid[k][1] - y))
        return None


def place_homes(grid: Grid, residents: list[dict], rng: np.random.Generator, stats: dict) -> None:
    by_d: dict[int, list[dict]] = {}
    for r in residents:
        by_d.setdefault(r["districtIdx"], []).append(r)
    for idx, group in by_d.items():
        cands = grid.candidates(idx, HOME_TYPES) or grid.candidates(idx, FALLBACK_TYPES) or grid.by_district.get(idx, [])
        if not cands:
            stats["no_tiles"].append(idx)
            cx, cy = grid.centroid[idx]
            for r in group:
                r["home"] = [int(cx), int(cy)]
            continue
        pts = np.array([(c[0], c[1]) for c in cands], dtype=float)
        # minimum spacing: what an even spread of len(group) points over the candidate area would give, x0.8
        spacing = max(1.0, 0.8 * math.sqrt(len(cands) / (len(group) * math.pi)))
        used = np.zeros(len(cands), dtype=int)
        chosen: list[tuple[float, float]] = []
        order = rng.permutation(len(group))
        for j in order:
            r = group[j]
            trial = rng.choice(len(cands), size=min(len(cands), 40), replace=False)
            best, best_score = None, -1.0
            for t in trial:
                score = home_preference(r, cands[t][2]) * (0.05 ** used[t])
                if chosen:
                    dmin = float(np.min(np.hypot(*(np.array(chosen) - pts[t]).T)))
                    if dmin < spacing:
                        score *= 0.1 * (dmin / spacing) + 0.01
                score *= 0.9 + 0.2 * rng.random()  # tie-break
                if score > best_score:
                    best, best_score = t, score
            used[best] += 1
            chosen.append(tuple(pts[best]))
            r["home"] = [int(cands[best][0]), int(cands[best][1])]
            r["_homeType"] = cands[best][2]
        stats["shared_home_tiles"] += int((used > 1).sum())


def place_work(grid: Grid, r: dict, rng: np.random.Generator, stats: dict) -> None:
    code = r.get("workDistrictCode")
    if not code:
        r["work"], r["workDistrictIdx"] = None, None
        return
    idx = grid.district_idx(code, r.get("workAnchor"))
    if idx is None or idx not in grid.by_district:
        stats["work_unplaced"] += 1
        r["work"], r["workDistrictIdx"] = None, None
        return
    cands = grid.candidates(idx, WORK_TYPES) or grid.by_district[idx]
    pts = np.array([(c[0], c[1]) for c in cands], dtype=float)
    wts = np.array([work_preference(r, c[2]) for c in cands])
    if r.get("workAnchor"):
        ax, ay = lonlat_to_xy(*r["workAnchor"])
        d = np.hypot(pts[:, 0] + 0.5 - ax, pts[:, 1] + 0.5 - ay)
        wts = wts * np.exp(-d / 3.0)  # within a few hundred metres of the hub
    elif idx == r["districtIdx"]:
        d = np.hypot(pts[:, 0] - r["home"][0], pts[:, 1] - r["home"][1])
        wts = wts * np.where(d < 2, 0.05, 1.0)  # not on the home tile itself
    k = int(rng.choice(len(cands), p=wts / wts.sum()))
    r["work"] = [int(cands[k][0]), int(cands[k][1])]
    r["workDistrictIdx"] = int(idx)


def main(map_path: Path | None = None) -> dict:
    rng = np.random.default_rng(SEED)
    full = read_json(FULL_PATH)
    mp = Path(map_path) if map_path else MAP_PATH
    dev = False
    if mp.exists():
        m = read_json(mp)
    else:
        print(f"[place] WARNING: {mp} not found - using a development map. Re-run place_residents.py after build_map.py.")
        m = read_json(DEV_MAP) if DEV_MAP.exists() else build_dev_map()
        dev = True
    grid = Grid(m)
    residents = full["residents"]
    stats = {"no_tiles": [], "shared_home_tiles": 0, "work_unplaced": 0, "unknown_home_code": 0}
    dcentre = {d["code"]: d["centre"] for d in full["districts"]}
    for r in residents:
        if r["districtCode"] not in grid.code_to_idx:
            stats["unknown_home_code"] += 1
        r["districtIdx"] = grid.district_idx(r["districtCode"], dcentre.get(r["districtCode"]))
    place_homes(grid, residents, rng, stats)
    for r in residents:
        place_work(grid, r, rng, stats)

    # slim PopulationFile for the web app
    slim = []
    for r in residents:
        rec = {k: r.get(k) for k in RESIDENT_FIELDS}
        slim.append(rec)
    method = dict(full["method"])
    placement = (
        f"Homes: building tiles inside the district, spread out; work: tile in the work district near the job hub. "
        f"Map: {'DEVELOPMENT map (re-run place_residents.py with the real map.json!)' if dev else 'web/public/data/map.json'}."
    )
    method["sampling"] = method["sampling"] + " " + placement
    out = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(slim),
        "residents": slim,
        "groups": full["groups"],
        "method": {k: method[k] for k in ("sampling", "raking", "imputation", "knownDatasetIssues")},
        "sources": full["sources"],
    }
    write_json(POP_PATH, out)
    # keep the full file in sync (tiles added; '_homeType' is internal)
    for r in residents:
        r["homeTileType"] = r.pop("_homeType", None)
    full["placement"] = {"map": str(mp if not dev else DEV_MAP), "dev": dev, **{k: v for k, v in stats.items()}}
    write_json(FULL_PATH, full)
    size = POP_PATH.stat().st_size / 1e6
    print(f"[place] {len(slim)} residents -> {POP_PATH} ({size:.2f} MB); stats {stats}")
    return {"stats": stats, "dev": dev, "sizeMB": size}


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else None
    main(Path(arg) if arg else None)
