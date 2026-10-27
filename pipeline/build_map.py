"""Build the tile map of Paris + inner suburbs -> web/public/data/map.json.

What this script does, step by step:
  1. Download real geography and cache it under pipeline/data/raw/geo/
       - Paris arrondissements and the communes of 92/93/94, with INSEE population
         (geo.api.gouv.fr, Licence Ouverte).
       - Rivers, woods, parks, motorways, railways, main streets, industrial areas
         (OpenStreetMap via the Overpass API, ODbL).
  2. Project everything onto the tile grid from web/shared/config.json
     (264 x 200 tiles of 100 m, same projection as pipeline/common.py).
  3. "Rasterise": decide one tile type per tile, using the tile centre.
     Priority (strongest first):
       water > ring_road > rail > forest > park > street > plaza > industrial > buildings / grass
  4. Fill the districts array (which arrondissement / commune owns each tile)
     and compute metadata per district (population, centroid, label position...).
  5. Write map.json (conforms to MapFile in web/src/types.ts) and a PNG preview.

Usage:
    python pipeline/build_map.py            # uses cached downloads when present
    python pipeline/build_map.py --refresh  # re-download everything

The map is a simplified, cozy pixel-art reading of real geography: one tile = 1 hectare.
"""
from __future__ import annotations

import argparse
import heapq
import json
import math
import re
import sys
import time
from collections import Counter, deque
from pathlib import Path

import httpx
import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, shape
from shapely.ops import polygonize, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BBOX, CONFIG, H, OUT, RAW, TILE, TILE_M, TILE_TYPES, W, WEB_DATA, lonlat_to_xy, write_json  # noqa: E402

GEO_DIR = RAW / "geo"
GEO_DIR.mkdir(parents=True, exist_ok=True)
MAP_JSON = WEB_DATA / "map.json"

USER_AGENT = "TownInABox-hackathon/0.1 (one-off map build)"
DEPTS = ["75", "92", "93", "94"]

# geo.api.gouv.fr queries (verified to return GeoJSON with nom, code, population).
GEO_URLS = {
    "75": "https://geo.api.gouv.fr/communes?type=arrondissement-municipal&codeDepartement=75"
    "&format=geojson&geometry=contour&fields=nom,code,population",
    "92": "https://geo.api.gouv.fr/departements/92/communes?format=geojson&geometry=contour&fields=nom,code,population",
    "93": "https://geo.api.gouv.fr/departements/93/communes?format=geojson&geometry=contour&fields=nom,code,population",
    "94": "https://geo.api.gouv.fr/departements/94/communes?format=geojson&geometry=contour&fields=nom,code,population",
}
GEO_FILES = {"75": "arr75.geojson", "92": "com92.geojson", "93": "com93.geojson", "94": "com94.geojson"}

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# One single, polite Overpass query for the whole bounding box.
OVERPASS_QUERY = """[out:json][timeout:300][maxsize:1073741824][bbox:{s},{w},{n},{e}];
(
  way["waterway"~"^(river|canal)$"];
  way["natural"="water"];
  relation["natural"="water"];
  way["waterway"="riverbank"];
  relation["waterway"="riverbank"];
  way["landuse"="forest"];
  relation["landuse"="forest"];
  way["natural"="wood"];
  relation["natural"="wood"];
  way["leisure"~"^(park|golf_course|stadium)$"];
  relation["leisure"~"^(park|golf_course|stadium)$"];
  way["landuse"="cemetery"];
  relation["landuse"="cemetery"];
  way["highway"~"^(motorway|trunk|primary|secondary)$"];
  way["railway"="rail"];
  way["landuse"~"^(railway|industrial|commercial)$"];
  relation["landuse"~"^(railway|industrial|commercial)$"];
  way["place"="square"];
  relation["place"="square"];
  way["highway"="pedestrian"]["area"="yes"];
  relation["highway"="pedestrian"];
);
out geom;
""".format(s=BBOX["latMin"], w=BBOX["lonMin"], n=BBOX["latMax"], e=BBOX["lonMax"])

SOURCES = [
    {
        "name": "Paris arrondissements and communes of 92/93/94 with INSEE population (API Géo, geo.api.gouv.fr)",
        "url": "https://geo.api.gouv.fr/decoupage-administratif",
        "license": "Licence Ouverte / Open Licence 2.0 (Etalab)",
    },
    {
        "name": "Rivers, woods, parks, roads, railways, land use: © OpenStreetMap contributors (via Overpass API)",
        "url": "https://www.openstreetmap.org/copyright",
        "license": "ODbL 1.0",
    },
]

# Small tuning knobs (in tiles; 1 tile = 100 m, 1 tile^2 = 1 hectare).
PARK_MIN_HA = 2.0  # parks at least this big become 'park'
SMALL_PARK_MIN_HA = 0.3  # smaller squares/gardens become 'grass'
PLAZA_MIN_HA = 0.4  # pedestrian squares at least this big become 'plaza'
WATER_MIN_HA = 0.3  # ignore tiny ponds/fountains
RIVER_WIDEN_TILES = 0.3  # widen river polygons by 30 m per bank (Seine ~130 m -> ~2 tiles)
SEED = 20261030  # fixed seed: the map is identical on every run


# ---------------------------------------------------------------------------
# 1. Downloads (cached)
# ---------------------------------------------------------------------------

def download_geo(refresh: bool) -> dict[str, dict]:
    """Boundaries + population per département (GeoJSON FeatureCollections)."""
    out = {}
    for dept, url in GEO_URLS.items():
        path = GEO_DIR / GEO_FILES[dept]
        if refresh or not path.exists():
            print(f"  downloading boundaries for {dept} ...")
            r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
            r.raise_for_status()
            path.write_bytes(r.content)
        out[dept] = json.loads(path.read_text(encoding="utf-8"))
    return out


def download_osm(refresh: bool) -> dict:
    """All OSM features for the bbox, in one Overpass query (about 50 MB)."""
    path = GEO_DIR / "osm.json"
    (GEO_DIR / "overpass_query.txt").write_text(OVERPASS_QUERY, encoding="utf-8")
    if refresh or not path.exists():
        last_error = None
        for endpoint in OVERPASS_ENDPOINTS:
            for attempt in range(2):
                print(f"  Overpass query -> {endpoint} (attempt {attempt + 1}) ...")
                try:
                    r = httpx.post(endpoint, data={"data": OVERPASS_QUERY},
                                   headers={"User-Agent": USER_AGENT}, timeout=420)
                    if r.status_code == 200 and r.content.lstrip().startswith(b"{"):
                        path.write_bytes(r.content)
                        break
                    last_error = f"HTTP {r.status_code}"
                except httpx.HTTPError as exc:  # network trouble: try again / next mirror
                    last_error = repr(exc)
                time.sleep(20)  # be polite before retrying
            if path.exists():
                break
        if not path.exists():
            raise SystemExit(f"Overpass download failed ({last_error}). Try again later.")
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("remark"):
        print("  WARNING Overpass remark:", data["remark"])
    return data


def load_persona_communes(refresh: bool) -> set[str] | None:
    """Distinct `commune` values of the NVIDIA persona dataset for our 4 départements.

    Used only to check that District.fullName matches the dataset spelling.
    Cheap query (2 columns) with DuckDB over HTTP; cached as persona_communes.json.
    """
    path = GEO_DIR / "persona_communes.json"
    if refresh or not path.exists():
        try:
            import duckdb

            from common import PERSONA_PARQUET_URLS

            print("  querying persona dataset commune names (DuckDB) ...")
            con = duckdb.connect()
            con.execute("INSTALL httpfs; LOAD httpfs;")
            rows = con.execute(
                f"""SELECT departement, commune, count(*) AS n
                    FROM read_parquet({PERSONA_PARQUET_URLS!r})
                    WHERE departement IN ('Paris','Hauts-de-Seine','Seine-Saint-Denis','Val-de-Marne')
                    GROUP BY 1, 2 ORDER BY 1, 2"""
            ).fetchall()
            path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:  # optional check only
            print("  (skipping persona name check:", repr(exc), ")")
            return None
    rows = json.loads(path.read_text(encoding="utf-8"))
    return {r[1] for r in rows}


# ---------------------------------------------------------------------------
# 2. Geometry helpers (everything is converted to TILE coordinates)
# ---------------------------------------------------------------------------

def to_tiles(geom):
    """lon/lat geometry -> tile-coordinate geometry (x right, y down)."""
    lon_span = BBOX["lonMax"] - BBOX["lonMin"]
    lat_span = BBOX["latMax"] - BBOX["latMin"]

    def f(c):
        x = (c[:, 0] - BBOX["lonMin"]) / lon_span * W
        y = (BBOX["latMax"] - c[:, 1]) / lat_span * H
        return np.column_stack([x, y])

    return shapely.transform(geom, f)


def way_coords(member_or_way) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in member_or_way.get("geometry", []) if p]


def element_line(e):
    """The centre line of an OSM way (tile coords) or None."""
    pts = way_coords(e)
    if len(pts) < 2:
        return None
    return to_tiles(LineString(pts))


def element_area(e):
    """Polygon of a closed OSM way or a multipolygon relation (tile coords) or None."""
    try:
        if e["type"] == "way":
            pts = way_coords(e)
            if len(pts) < 4 or pts[0] != pts[-1]:
                return None
            poly = Polygon(pts)
        else:
            outers, inners = [], []
            for m in e.get("members", []):
                if m.get("type") != "way":
                    continue
                pts = way_coords(m)
                if len(pts) < 2:
                    continue
                (inners if m.get("role") == "inner" else outers).append(LineString(pts))
            if not outers:
                return None
            poly = unary_union(list(polygonize(unary_union(outers))))
            if inners:
                holes = unary_union(list(polygonize(unary_union(inners))))
                poly = poly.difference(holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return None
        return to_tiles(poly)
    except Exception:  # broken relation in OSM: just skip it
        return None


# Tile centres, used to test "is this tile inside that polygon?"
CX, CY = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)


def window(bounds, pad=0.0):
    """Index ranges of tile centres that can fall inside a geometry's bounds."""
    minx, miny, maxx, maxy = bounds
    x0 = max(0, int(math.floor(minx - pad - 0.5)))
    x1 = min(W, int(math.ceil(maxx + pad + 0.5)))
    y0 = max(0, int(math.floor(miny - pad - 0.5)))
    y1 = min(H, int(math.ceil(maxy + pad + 0.5)))
    return x0, x1, y0, y1


def raster_polygons(geoms) -> np.ndarray:
    """Boolean mask: tiles whose centre lies inside any of the polygons."""
    mask = np.zeros((H, W), dtype=bool)
    for g in geoms:
        x0, x1, y0, y1 = window(g.bounds)
        if x0 >= x1 or y0 >= y1:
            continue
        shapely.prepare(g)
        inside = shapely.contains_xy(g, CX[y0:y1, x0:x1], CY[y0:y1, x0:x1])
        mask[y0:y1, x0:x1] |= inside
    return mask


def raster_coverage(geoms, threshold: float, n: int = 4) -> np.ndarray:
    """Boolean mask: tiles at least `threshold` covered by the polygons.

    We test an n x n grid of sample points inside every tile. Used for water, so that a
    130 m wide river becomes about 2 tiles wide while big islands stay land.
    """
    union = unary_union(geoms)
    count = np.zeros((H, W), dtype=np.int32)
    shapely.prepare(union)
    x0, x1, y0, y1 = window(union.bounds, pad=1)
    for i in range(n):
        for j in range(n):
            ox, oy = (i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5  # offset from the tile centre
            count[y0:y1, x0:x1] += shapely.contains_xy(
                union, CX[y0:y1, x0:x1] + ox, CY[y0:y1, x0:x1] + oy)
    return count >= threshold * n * n


def raster_lines(geoms) -> np.ndarray:
    """Boolean mask: every tile a line passes through, as a 1-tile wide, 4-connected path.

    We walk along each line in small steps; when the walk jumps diagonally from one
    tile to the next, we add the tile in between so roads/rivers never have gaps.
    """
    mask = np.zeros((H, W), dtype=bool)
    for g in geoms:
        g = shapely.segmentize(g, 0.2)
        parts = g.geoms if hasattr(g, "geoms") else [g]
        for part in parts:
            c = np.asarray(part.coords)
            if len(c) < 2:
                continue
            cells = np.floor(c).astype(int)
            # tiles where we stepped diagonally: add the corner tile the line crossed first
            d = np.diff(cells, axis=0)
            diag = np.nonzero((d[:, 0] != 0) & (d[:, 1] != 0))[0]
            extra = []
            for i in diag:
                (ax, ay), (bx, by) = cells[i], cells[i + 1]
                p, q = c[i], c[i + 1]
                bound_x = max(ax, bx)  # vertical grid line between the two tiles
                bound_y = max(ay, by)
                tx = (bound_x - p[0]) / (q[0] - p[0]) if q[0] != p[0] else 1.0
                ty = (bound_y - p[1]) / (q[1] - p[1]) if q[1] != p[1] else 1.0
                extra.append((bx, ay) if tx < ty else (ax, by))
            allc = np.vstack([cells, np.array(extra, dtype=int).reshape(-1, 2)])
            ok = (allc[:, 0] >= 0) & (allc[:, 0] < W) & (allc[:, 1] >= 0) & (allc[:, 1] < H)
            allc = allc[ok]
            mask[allc[:, 1], allc[:, 0]] = True
    return mask


def smooth_noise(rng: np.random.Generator, cell: float) -> np.ndarray:
    """Smooth random field (value noise): neighbouring tiles get similar values, so
    things decided by it (like tower blocks) come in clusters instead of salt-and-pepper."""
    gh, gw = int(H / cell) + 3, int(W / cell) + 3
    g = rng.random((gh, gw))
    ys = (np.arange(H) + 0.5) / cell
    xs = (np.arange(W) + 0.5) / cell
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    fy, fx = ys - y0, xs - x0
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)  # smoothstep
    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x0 + 1)]
    c = g[np.ix_(y0 + 1, x0)]
    d = g[np.ix_(y0 + 1, x0 + 1)]
    top = a + (b - a) * fx[None, :]
    bot = c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def to_uniform(values: np.ndarray, where: np.ndarray) -> np.ndarray:
    """Rank-transform a field to uniform 0..1 on the selected tiles (so a 30% threshold means 30%)."""
    out = np.ones_like(values)
    v = values[where]
    ranks = np.argsort(np.argsort(v))
    out[where] = (ranks + 0.5) / max(1, len(v))
    return out


# ---------------------------------------------------------------------------
# 3. Classify OSM elements
# ---------------------------------------------------------------------------

PERIPH_RE = re.compile(r"p[ée]riph[ée]rique", re.IGNORECASE)


def is_underground(t: dict) -> bool:
    return (
        t.get("tunnel") in ("yes", "culvert", "building_passage", "covered")
        or t.get("covered") == "yes"
        or t.get("location") in ("underground", "underwater")
    )


def classify_osm(osm: dict) -> dict[str, list]:
    """Sort OSM elements into buckets of tile-coordinate geometries."""
    b: dict[str, list] = {k: [] for k in (
        "water_area", "river_area", "river_line", "canal_line", "seine_line", "forest", "park", "small_park",
        "stadium", "plaza", "industrial", "railyard", "rail", "periph", "motorway",
        "street_main", "street_secondary")}
    for e in osm["elements"]:
        t = e.get("tags", {})
        if not t:
            continue
        hw, ww, nat, lu, lei = t.get("highway"), t.get("waterway"), t.get("natural"), t.get("landuse"), t.get("leisure")

        # --- lines ---
        if e["type"] == "way":
            # The Seine and Marne are never underground here; a few tiny pieces under bridges are
            # tagged as culverts in OSM, and skipping them would cut the river in two.
            big_river = ww == "river" and re.search(r"\b(seine|marne)\b", t.get("name", ""), re.IGNORECASE)
            if ww in ("river", "canal") and (big_river or not is_underground(t)):
                line = element_line(e)
                if line is not None:
                    b["river_line" if ww == "river" else "canal_line"].append(line)
                    if ww == "river" and "seine" in t.get("name", "").lower():
                        b["seine_line"].append(line)
            if hw in ("motorway", "trunk", "primary", "secondary") and t.get("area") != "yes":
                line = element_line(e)
                if line is not None:
                    if PERIPH_RE.search(t.get("name", "")) or PERIPH_RE.search(t.get("official_name", "")):
                        b["periph"].append(line)  # keep covered sections: the ring must stay closed
                    elif is_underground(t):
                        pass
                    elif hw == "motorway" or t.get("motorroad") == "yes":
                        b["motorway"].append(line)
                    else:
                        # trunk/primary vs secondary; where each is drawn is decided later
                        b["street_secondary" if hw == "secondary" else "street_main"].append(line)
            if t.get("railway") == "rail" and not is_underground(t):
                if t.get("service") not in ("siding", "spur", "yard", "crossover") and \
                        t.get("usage") not in ("industrial", "military", "tourism", "test"):
                    line = element_line(e)
                    if line is not None:
                        b["rail"].append(line)

        # --- areas ---
        wants_area = (
            nat == "water" or ww == "riverbank" or lu in ("forest", "cemetery", "railway", "industrial", "commercial")
            or nat == "wood" or lei in ("park", "golf_course", "stadium") or t.get("place") == "square"
            or hw == "pedestrian"
        )
        if not wants_area:
            continue
        if e["type"] == "way" and hw == "pedestrian" and t.get("area") != "yes":
            continue
        area = element_area(e)
        if area is None:
            continue
        ha = area.area  # 1 tile^2 = 1 hectare
        if (nat == "water" or ww == "riverbank") and not is_underground(t) and ha >= WATER_MIN_HA:
            is_river = ww == "riverbank" or t.get("water") == "river"
            b["river_area" if is_river else "water_area"].append(area)
        if lu == "forest" or nat == "wood":
            b["forest"].append(area)
        if lei in ("park", "golf_course") or lu == "cemetery":
            if ha >= PARK_MIN_HA:
                b["park"].append(area)
            elif ha >= SMALL_PARK_MIN_HA:
                b["small_park"].append(area)
        if lei == "stadium" and ha >= 1.0:
            b["stadium"].append(area)
        if (t.get("place") == "square" or hw == "pedestrian") and ha >= PLAZA_MIN_HA:
            # skip long thin pedestrian strips (quays, malls): keep compact squares only
            compact = 4 * math.pi * area.area / max(area.length, 1e-9) ** 2
            if compact > 0.25:
                b["plaza"].append(area)
        if lu in ("industrial", "commercial") and ha >= 1.0:
            b["industrial"].append(area)
        if lu == "railway" and ha >= 1.0:
            b["railyard"].append(area)
    return b


# ---------------------------------------------------------------------------
# 4. Districts
# ---------------------------------------------------------------------------

def paris_short_name(code: str) -> str:
    n = int(code[-2:])
    return "1er" if n == 1 else f"{n}e"


def paris_sector(code: str) -> str:
    n = int(code[-2:])
    return "Paris Centre" if n <= 4 else f"{n}e"


def build_districts(geo: dict[str, dict]):
    """Return (districts array HxW, list of kept districts with their tile masks).

    Order: Paris 1er..20e first (idx 1..20), then suburb communes sorted by INSEE code.
    Suburb communes with no tile inside the grid are dropped.
    """
    feats = []
    for dept in DEPTS:
        for f in geo[dept]["features"]:
            p = f["properties"]
            feats.append({
                "code": p["code"], "nom": p["nom"], "population": int(p.get("population") or 0),
                "dept": dept, "geom": to_tiles(shape(f["geometry"])),
            })
    paris = sorted([f for f in feats if f["dept"] == "75"], key=lambda f: f["code"])
    suburbs = sorted([f for f in feats if f["dept"] != "75"], key=lambda f: f["code"])
    assert len(paris) == 20, f"expected 20 arrondissements, got {len(paris)}"

    # Which tiles does each commune own? (tile centre inside the polygon)
    for f in paris + suburbs:
        f["mask"] = raster_polygons([f["geom"]])
    kept = paris + [f for f in suburbs if f["mask"].any()]

    districts = np.zeros((H, W), dtype=np.int32)
    for idx, f in enumerate(kept, start=1):
        districts[f["mask"] & (districts == 0)] = idx
        f["idx"] = idx
    for f in kept:
        f["mask"] = districts == f["idx"]
        f["area_ha"] = f["geom"].area  # whole commune (also the part outside the grid)
    return districts, kept


# ---------------------------------------------------------------------------
# 5. Main build
# ---------------------------------------------------------------------------

def seine_polyline(lines: list) -> list[list[float]]:
    """Longest path through the Seine centre-line network, clipped to the grid, simplified."""
    if not lines:
        return []
    grid = shapely.box(0, 0, W, H)
    # Build a graph whose nodes are line vertices (rounded), edges weighted by length.
    graph: dict[tuple, list[tuple[tuple, float]]] = {}
    for g in lines:
        g = g.intersection(grid)
        parts = g.geoms if hasattr(g, "geoms") else [g]
        for part in parts:
            if part.geom_type != "LineString" or part.is_empty:
                continue
            pts = [(round(x, 3), round(y, 3)) for x, y in part.coords]
            for a, c in zip(pts, pts[1:]):
                if a == c:
                    continue
                d = math.dist(a, c)
                graph.setdefault(a, []).append((c, d))
                graph.setdefault(c, []).append((a, d))
    ends = [n for n, nb in graph.items() if len(nb) == 1]

    def dijkstra(src):
        dist, prev = {src: 0.0}, {}
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18):
                continue
            for v, w in graph[u]:
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v], prev[v] = nd, u
                    heapq.heappush(pq, (nd, v))
        return dist, prev

    best = (0.0, None, None, None)
    for s in ends:
        dist, prev = dijkstra(s)
        far = max((n for n in ends if n in dist), key=lambda n: dist[n], default=None)
        if far is not None and dist[far] > best[0]:
            best = (dist[far], s, far, prev)
    _, s, far, prev = best
    if far is None:
        return []
    path = [far]
    while path[-1] != s:
        path.append(prev[path[-1]])
    line = LineString(path).simplify(0.4)
    return [[round(x, 1), round(y, 1)] for x, y in line.coords]


def build(refresh: bool) -> dict:
    t0 = time.time()
    print("1/5 downloads (cached under pipeline/data/raw/geo/)")
    geo = download_geo(refresh)
    osm = download_osm(refresh)
    persona_communes = load_persona_communes(refresh)

    print("2/5 districts")
    districts, kept = build_districts(geo)
    in_district = districts > 0
    is_paris = (districts >= 1) & (districts <= 20)
    is_suburb = districts > 20

    print("3/5 classify OpenStreetMap features")
    b = classify_osm(osm)
    for k, v in b.items():
        print(f"    {k:26s} {len(v):6d}")

    print("4/5 rasterise")
    rng = np.random.default_rng(SEED)
    tiles = np.full((H, W), TILE["grass"], dtype=np.int32)

    # --- buildings: Paris = haussmann; suburbs = houses / towers by commune density ---
    tiles[is_paris] = TILE["haussmann"]
    density = np.zeros((H, W))  # inhabitants per km2 of the owning commune
    for f in kept:
        dens = f["population"] / max(f["area_ha"] / 100.0, 0.01)
        f["density"] = dens
        density[f["mask"]] = dens
    tower_noise = to_uniform(0.65 * smooth_noise(rng, 7.0) + 0.35 * smooth_noise(rng, 2.5), is_suburb)
    grass_noise = to_uniform(0.5 * smooth_noise(rng, 4.0) + 0.5 * smooth_noise(rng, 1.5), in_district)
    p_tower = np.interp(density, [0, 3000, 7000, 12000, 20000, 30000], [0.02, 0.07, 0.2, 0.32, 0.42, 0.45])
    p_grass = np.interp(density, [0, 1500, 4000, 8000, 15000], [0.32, 0.2, 0.11, 0.06, 0.04])
    sub_house = is_suburb & (tower_noise >= p_tower)
    sub_tower = is_suburb & (tower_noise < p_tower)
    tiles[sub_house] = TILE["suburb_house"]
    tiles[sub_tower] = TILE["suburb_tower"]
    # La Défense: a dense cluster of towers around the business district landmark
    lm = {l["id"]: l for l in CONFIG["landmarks"]}
    dx, dy = lonlat_to_xy(lm["defense"]["lon"], lm["defense"]["lat"])
    near_def = ((CX - dx) ** 2 + (CY - dy) ** 2 <= 6.5 ** 2) & is_suburb
    tiles[near_def] = TILE["suburb_tower"]
    # grass gaps (more in leafy low-density communes; very few in Paris)
    gaps = in_district & ~near_def & (grass_noise < np.where(is_paris, 0.0, p_grass))
    tiles[gaps] = TILE["grass"]

    # --- OSM layers, painted from weakest to strongest priority ---
    tiles[raster_polygons(b["small_park"]) & in_district] = TILE["grass"]
    tiles[raster_polygons(b["industrial"]) & in_district] = TILE["industrial"]
    tiles[raster_polygons(b["plaza"] + b["stadium"]) & in_district] = TILE["plaza"]

    # streets: Paris gets trunk/primary/secondary (the radiating avenues); suburbs only trunk/primary
    street = (raster_lines(b["street_main"]) & in_district) | (raster_lines(b["street_secondary"]) & is_paris)
    tiles[street] = TILE["street"]
    tiles[raster_polygons(b["park"]) & in_district] = TILE["park"]
    tiles[raster_polygons(b["forest"]) & in_district] = TILE["forest"]
    rail = raster_lines(b["rail"]) | raster_polygons(b["railyard"])
    tiles[rail & in_district] = TILE["rail"]
    ring = raster_lines(b["periph"] + b["motorway"])
    tiles[ring & in_district] = TILE["ring_road"]

    # Outside the 4 départements: plain decorative terrain
    tiles[~in_district] = TILE["outside"]

    # Water last (strongest): tiles >= 30% covered by lake/canal polygons or by the river polygons
    # (Seine, Marne) widened by 30 m per bank so they read as proper rivers at 100 m per tile,
    # plus the river and canal centre lines traced tile by tile (so rivers never break up).
    rivers_wide = [g.buffer(RIVER_WIDEN_TILES) for g in b["river_area"]]
    water = raster_coverage(b["water_area"] + rivers_wide, threshold=0.3) \
        | raster_lines(b["river_line"] + b["canal_line"])
    tiles[water] = TILE["water"]

    # Landmarks: give each one an open paved tile to stand on (a sprite is drawn there),
    # except the Iron tower (stays in its park) and the business district (stays among towers).
    landmarks = []
    for l in CONFIG["landmarks"]:
        x, y = lonlat_to_xy(l["lon"], l["lat"])
        ix, iy = int(x), int(y)
        if l["id"] not in ("eiffel", "defense"):
            tiles[iy, ix] = TILE["plaza"]
        landmarks.append({"id": l["id"], "name": l["name"], "nameFr": l["nameFr"], "kind": l["kind"],
                          "x": round(x, 2), "y": round(y, 2)})
    # The stadium gets a 3 x 3 paved footprint
    x, y = lonlat_to_xy(lm["stade"]["lon"], lm["stade"]["lat"])
    ix, iy = int(x), int(y)
    for yy in range(iy - 1, iy + 2):
        for xx in range(ix - 1, ix + 2):
            if tiles[yy, xx] != TILE["water"]:
                tiles[yy, xx] = TILE["plaza"]

    print("5/5 district metadata")
    district_list = []
    land_types = {TILE["haussmann"], TILE["suburb_house"], TILE["suburb_tower"], TILE["plaza"], TILE["grass"],
                  TILE["park"], TILE["industrial"]}
    mismatches = []
    for f in kept:
        ys, xs = np.nonzero(districts == f["idx"])
        cx, cy = float(xs.mean() + 0.5), float(ys.mean() + 0.5)
        # label position: the land tile of this district closest to the centroid
        is_land = np.isin(tiles[ys, xs], list(land_types))
        lx, ly = (xs[is_land], ys[is_land]) if is_land.any() else (xs, ys)
        k = int(np.argmin((lx + 0.5 - cx) ** 2 + (ly + 0.5 - cy) ** 2))
        is_arr = f["dept"] == "75"
        d = {
            "idx": f["idx"],
            "code": f["code"],
            "name": paris_short_name(f["code"]) if is_arr else f["nom"],
            "fullName": f["nom"],  # e.g. 'Paris 10e Arrondissement' (same spelling as the persona dataset)
            "kind": "arrondissement" if is_arr else "commune",
            "dept": f["dept"],
        }
        if is_arr:
            d["sector"] = paris_sector(f["code"])
        d.update({
            "population": f["population"],
            "centroid": [round(cx, 2), round(cy, 2)],
            "labelPos": [float(lx[k]) + 0.5, float(ly[k]) + 0.5],
            "tileCount": int(len(xs)),
        })
        # Extras (not in types.ts yet): share of the commune's area inside the grid, and the
        # population living there assuming even density. 32 communes are cut by the map edge
        # (e.g. Antony: 1% inside), so the population sampler should use populationInGrid.
        share = round(min(1.0, len(xs) / max(f["area_ha"], 1e-9)), 3)
        d["gridShare"] = share
        d["populationInGrid"] = int(round(f["population"] * share))
        district_list.append(d)
        if persona_communes is not None and f["nom"] not in persona_communes:
            mismatches.append(f["nom"])
    if persona_communes is not None:
        print(f"    persona dataset name check: {len(kept) - len(mismatches)}/{len(kept)} match"
              + (f"; NOT in dataset: {mismatches}" if mismatches else ""))

    seine = seine_polyline(b["seine_line"])

    map_file = {
        "version": 1,
        "width": W,
        "height": H,
        "tilePx": CONFIG["tilePx"],
        "tileMeters": TILE_M,
        "bbox": dict(BBOX),
        "tileTypes": list(TILE_TYPES),
        "tiles": tiles.ravel().astype(int).tolist(),
        "districts": districts.ravel().astype(int).tolist(),
        "districtList": district_list,
        "landmarks": landmarks,
        "seine": seine,
        "sources": SOURCES,
    }
    print(f"    built in {time.time() - t0:.1f} s")
    return map_file


# ---------------------------------------------------------------------------
# 6. Checks (printed, so problems are visible right away)
# ---------------------------------------------------------------------------

def flood_reaches_edge(tiles: np.ndarray, start: tuple[int, int], blocked: set[int]) -> bool:
    """8-connected flood fill from `start` through non-blocked tiles; True if it reaches the grid edge."""
    sx, sy = start
    seen = np.zeros_like(tiles, dtype=bool)
    q = deque([(sx, sy)])
    seen[sy, sx] = True
    while q:
        x, y = q.popleft()
        if x in (0, W - 1) or y in (0, H - 1):
            return True
        for ddx in (-1, 0, 1):
            for ddy in (-1, 0, 1):
                nx, ny = x + ddx, y + ddy
                if 0 <= nx < W and 0 <= ny < H and not seen[ny, nx] and tiles[ny, nx] not in blocked:
                    seen[ny, nx] = True
                    q.append((nx, ny))
    return False


def report(map_file: dict) -> None:
    tiles = np.array(map_file["tiles"]).reshape(H, W)
    counts = Counter(map_file["tiles"])
    print("tile type counts:")
    for i, name in enumerate(TILE_TYPES):
        print(f"    {name:13s} {counts.get(i, 0):6d}  ({100 * counts.get(i, 0) / (W * H):4.1f}%)")
    print(f"districts: {len(map_file['districtList'])} "
          f"({sum(d['kind'] == 'arrondissement' for d in map_file['districtList'])} arrondissements)")
    # Is the périphérique a closed ring? Flood from north and south Paris without crossing ring/water.
    blocked = {TILE["ring_road"], TILE["water"]}
    for label, (lon, lat) in {"north Paris (9e)": (2.338, 48.877), "south Paris (14e)": (2.326, 48.831)}.items():
        x, y = lonlat_to_xy(lon, lat)
        escaped = flood_reaches_edge(tiles, (int(x), int(y)), blocked)
        print(f"    ring check from {label}: {'NOT closed (escaped)' if escaped else 'closed'}")
    # Seine continuity: number of water components touched by the Seine polyline
    water = tiles == TILE["water"]
    lab = np.zeros((H, W), dtype=np.int32)
    comp = 0
    for (x, y) in map_file["seine"]:
        ix, iy = min(W - 1, int(x)), min(H - 1, int(y))
        if water[iy, ix] and lab[iy, ix] == 0:
            comp += 1
            q = deque([(ix, iy)])
            lab[iy, ix] = comp
            while q:
                cx, cy = q.popleft()
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < W and 0 <= ny < H and water[ny, nx] and lab[ny, nx] == 0:
                        lab[ny, nx] = comp
                        q.append((nx, ny))
    print(f"    Seine polyline: {len(map_file['seine'])} points; water components along it (4-connected): {comp}")
    for l in map_file["landmarks"]:
        t = TILE_TYPES[tiles[int(l["y"]), int(l["x"])]]
        print(f"    landmark {l['id']:14s} at ({l['x']:6.1f},{l['y']:6.1f}) on '{t}'")
    # Every district needs homes for its residents: count residential tiles per district.
    dist = np.array(map_file["districts"]).reshape(H, W)
    homes = np.isin(tiles, [TILE["haussmann"], TILE["suburb_house"], TILE["suburb_tower"]])
    few = []
    for d in map_file["districtList"]:
        n = int((homes & (dist == d["idx"])).sum())
        if n < 10:
            few.append(f"{d['name']}={n}")
    print("    districts with < 10 residential tiles:", ", ".join(few) if few else "none")
    cut = [f"{d['name']} ({d['gridShare']:.0%})" for d in map_file["districtList"] if d["gridShare"] < 0.9]
    print(f"    communes only partly inside the grid ({len(cut)}):", ", ".join(cut))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="re-download boundaries and OSM data")
    ap.add_argument("--no-preview", action="store_true", help="skip the PNG preview")
    args = ap.parse_args()

    map_file = build(args.refresh)
    write_json(MAP_JSON, map_file)
    size = MAP_JSON.stat().st_size
    print(f"wrote {MAP_JSON} ({size / 1e6:.2f} MB)")
    report(map_file)
    if not args.no_preview:
        from map_preview import write_preview

        png = write_preview(map_file, OUT / "map_preview.png", scale=3)
        print(f"wrote {png}")
        # zoomed view of central Paris (6 px per tile)
        from map_preview import png_bytes, render

        crop = render(map_file, scale=6)[60 * 6:130 * 6, 80 * 6:190 * 6]
        (OUT / "map_preview_paris.png").write_bytes(png_bytes(np.ascontiguousarray(crop)))
        print(f"wrote {OUT / 'map_preview_paris.png'}")


if __name__ == "__main__":
    main()
