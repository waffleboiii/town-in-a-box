"""Ground truth for Town-in-a-Box: official vote results, data-centre context and model cutoffs.

What this script does (plain English):
  1. Downloads the OFFICIAL result files of three Paris "votations" from opendata.paris.fr
     (cached under pipeline/data/raw/ground_truth/, which is git-ignored).
  2. Adds up the results by votation sector ('Paris Centre' = 1er-4e, then '5e' ... '20e'),
     and checks that the sectors add up to the officially proclaimed totals and match the
     percentages published on paris.fr.
  3. Merges these numbers with hand-checked facts (exact question wording, rules of each
     measure, who could vote, pre-vote polls), each with its source URL.
  4. Checks the proposed HYPOTHETICAL data-centre site against OpenStreetMap land use.
  5. Writes three files into pipeline/data/ground_truth/:
        votations.json            official results + rules + polls (backtests)
        datacenter_context.json   real context + a clearly hypothetical proposal
        leakage_notes.json        model training cutoffs and out-of-sample candidates

Usage (from the repo root):
  pipeline/.venv/Scripts/python.exe pipeline/fetch_ground_truth.py            # download if needed
  pipeline/.venv/Scripts/python.exe pipeline/fetch_ground_truth.py --offline  # use the cache only

Rules we follow: never invent a number. Every figure has a source URL. Anything we could not
check in a primary source is marked "verified": false (or "secondary source") in the output.
No API key is needed for this script.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from common import BBOX, GROUND_TRUTH, RAW, lonlat_to_xy, write_json

CACHE = RAW / "ground_truth"
OSM_CACHE = CACHE / "osm"
USER_AGENT = "TownInABox-hackathon/0.1 (ground-truth research)"

# ---------------------------------------------------------------------------
# 1. Official result files (Ville de Paris open data, Licence Ouverte / ODbL as stated on the portal)
# ---------------------------------------------------------------------------

OPENDATA = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets"
DOWNLOADS = {
    # Results by votation sector (17 rows) for 2 April 2023.
    "scooters_2023_sectors.xlsx": f"{OPENDATA}/votation-trottinette-2023/attachments/votation_2023_04_02_xlsx",
    # Results by sector, and by polling station (222 rows), for 4 February 2024.
    "suv_2024_sectors.xlsx": f"{OPENDATA}/votation_suv_2024/attachments/votation_suv_2024_02_04_xlsx",
    "suv_2024_bureaux.xlsx": f"{OPENDATA}/votation_suv_2024_bv/attachments/votation_suv_2024_02_04_secteur_bv_xlsx",
    # Results by polling station (218 rows) for 23 March 2025.
    "streets_2025_bureaux.csv": f"{OPENDATA}/votation-donnees-votation-mars2025-pour-ou-contre-vegetaliser-rues/exports/csv?delimiter=%3B",
    # Commune boundaries of Seine-Saint-Denis (to count mapped data centres per commune).
    "communes_93.geojson": "https://geo.api.gouv.fr/departements/93/communes?format=geojson&geometry=contour&fields=nom,code,population",
}

DATASET_PAGES = {
    "scooters_2023": "https://opendata.paris.fr/explore/dataset/votation-trottinette-2023/information/",
    "suv_2024": "https://opendata.paris.fr/explore/dataset/votation_suv_2024/information/",
    "suv_2024_bv": "https://opendata.paris.fr/explore/dataset/votation_suv_2024_bv/information/",
    "streets_2025": "https://opendata.paris.fr/explore/dataset/votation-donnees-votation-mars2025-pour-ou-contre-vegetaliser-rues/information/",
}

# OpenStreetMap queries (Overpass API). One query each, cached, only run if the cache is missing.
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
Q_LANDUSE = """[out:json][timeout:120];
(area["boundary"="administrative"]["admin_level"="8"]["ref:INSEE"~"^(93066|93027|93001|93070|93072)$"];)->.c;
(way["landuse"~"industrial|brownfield|railway"](area.c); relation["landuse"~"industrial|brownfield"](area.c);)->.lu;
(nwr["telecom"="data_center"](48.77,2.17,48.95,2.53); nwr["building"="data_center"](48.77,2.17,48.95,2.53);)->.dc;
.lu out tags geom;
.dc out tags center;"""
Q_SITE = """[out:json][timeout:60];
(
  nwr["power"="substation"]["voltage"~"225000"](48.905,2.38,48.95,2.45);
  nwr["amenity"~"school|kindergarten|childcare"](around:700,{lat},{lon});
  way["highway"~"motorway"](around:500,{lat},{lon});
  way["landuse"="construction"](around:700,{lat},{lon});
);
out tags center;"""


def http_get(url: str, dest: Path, offline: bool) -> Path:
    """Download url to dest once (cache). In --offline mode the cache must already exist."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    if offline:
        raise SystemExit(f"--offline but cache file is missing: {dest}")
    import httpx

    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=120, follow_redirects=True) as c:
        r = c.get(url)
        r.raise_for_status()
        dest.write_bytes(r.content)
    return dest


def overpass(query: str, dest: Path, offline: bool) -> dict | None:
    """Run one Overpass query (cached). Returns None if it cannot be fetched (the check is then skipped)."""
    if dest.exists() and dest.stat().st_size > 1000:
        return json.loads(dest.read_text(encoding="utf-8"))
    if offline:
        return None
    import httpx

    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=150) as c:
                r = c.post(OVERPASS_URL, data={"data": query})
            if r.status_code == 200:
                dest.write_bytes(r.content)
                return r.json()
            print(f"  overpass HTTP {r.status_code}, retrying...")
        except Exception as e:  # network trouble: retry politely
            print(f"  overpass error {e!r}, retrying...")
        time.sleep(10 * (attempt + 1))
    return None


# ---------------------------------------------------------------------------
# 2. A tiny .xlsx reader using only the standard library (no openpyxl in the venv)
# ---------------------------------------------------------------------------

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _safe_xml(data: bytes) -> ET.Element:
    """Parse XML from a downloaded file. defusedxml is not installed, so we simply refuse any file that
    declares a DTD or entities (real .xlsx parts never do); this blocks XXE / 'billion laughs' tricks."""
    head = data[:4096].upper()
    if b"<!DOCTYPE" in head or b"<!ENTITY" in data.upper():
        raise ValueError("refusing XML with a DTD/entity declaration")
    return ET.fromstring(data)


def read_xlsx_first_sheet(path: Path) -> list[dict[str, str]]:
    """Return the first sheet as a list of {header: value} dicts (all values as strings)."""
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = _safe_xml(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
    sheet_files = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    root = _safe_xml(z.read(sheet_files[0]))
    rows: list[dict[str, str]] = []
    for r in root.iter(f"{{{_NS['m']}}}row"):
        row = {}
        for c in r.findall("m:c", _NS):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", _NS)
            if c.get("t") == "s" and v is not None:
                row[col] = shared[int(v.text)]
            elif c.get("t") == "inlineStr":
                row[col] = "".join(x.text or "" for x in c.iter(f"{{{_NS['m']}}}t"))
            else:
                row[col] = v.text if v is not None else None
        rows.append(row)
    header = rows[0]
    out = []
    for row in rows[1:]:
        if not row.get("A"):
            continue  # skip empty trailing rows
        out.append({header[k].strip().upper(): val for k, val in row.items() if k in header and header[k]})
    return out


# ---------------------------------------------------------------------------
# 3. Sector helpers and aggregation
# ---------------------------------------------------------------------------

SECTORS = ["Paris Centre"] + [f"{n}e" for n in range(5, 21)]


def sector_of_arr(n: int) -> str:
    """Arrondissement number -> votation sector name used by the City ('Paris Centre' for 1er-4e)."""
    return "Paris Centre" if n <= 4 else f"{n}e"


def sector_codes(sector: str) -> list[str]:
    """INSEE codes of the arrondissement(s) in a sector: 'Paris Centre' -> 75101..75104, '11e' -> 75111."""
    if sector == "Paris Centre":
        return ["75101", "75102", "75103", "75104"]
    return [f"751{int(sector[:-1]):02d}"]


COUNT_FIELDS = ["registered", "signatures", "voters", "blank", "null", "expressed", "pourVotes", "contreVotes"]
XLSX_MAP = {"INSCRITS": "registered", "EMARGEMENTS": "signatures", "VOTANTS": "voters", "BLANCS": "blank",
            "NULS": "null", "EXPRIMES": "expressed", "POUR": "pourVotes", "CONTRE": "contreVotes"}
CSV_MAP = {"inscrits": "registered", "emargements": "signatures", "votants": "voters", "blancs": "blank",
           "nuls": "null", "exprimes": "expressed", "pour": "pourVotes", "contre": "contreVotes"}


def finish_row(label_key: str, label: str, counts: dict) -> dict:
    """Add shares to a row of raw counts. Shares are of EXPRESSED votes (Pour+Contre), like paris.fr."""
    row = {label_key: label, **{k: int(counts[k]) for k in COUNT_FIELDS}}
    row["yesShare"] = round(counts["pourVotes"] / counts["expressed"], 6)
    row["noShare"] = round(counts["contreVotes"] / counts["expressed"], 6)
    # Turnout = voters / registered (the definition paris.fr uses, e.g. 56 489 / 1 391 369 = 4.06 % in 2025).
    row["turnout"] = round(counts["voters"] / counts["registered"], 6)
    return row


def sectors_from_sector_xlsx(path: Path) -> list[dict]:
    rows = read_xlsx_first_sheet(path)
    by = {}
    for r in rows:
        name = r["SECTEURS ADMINISTRATIFS"].strip()
        by[name] = {XLSX_MAP[k]: int(float(r[k])) for k in XLSX_MAP}
    return [{**finish_row("sector", s, by[s]), "districtCodes": sector_codes(s)} for s in SECTORS]


def arrs_from_bureaux(rows: list[dict], id_key: str, mapping: dict) -> dict[int, dict]:
    """Sum polling-station rows into arrondissements. The station id looks like '11-1' (arrondissement-station)."""
    by: dict[int, dict] = {}
    for r in rows:
        arr = int(str(r[id_key]).split("-")[0])
        acc = by.setdefault(arr, {k: 0 for k in COUNT_FIELDS})
        for src, dst in mapping.items():
            acc[dst] += int(float(r[src]))
    return by


def sectors_from_arrs(by_arr: dict[int, dict]) -> list[dict]:
    acc: dict[str, dict] = {}
    for arr, c in by_arr.items():
        s = acc.setdefault(sector_of_arr(arr), {k: 0 for k in COUNT_FIELDS})
        for k in COUNT_FIELDS:
            s[k] += c[k]
    return [{**finish_row("sector", s, acc[s]), "districtCodes": sector_codes(s)} for s in SECTORS]


def arr_rows(by_arr: dict[int, dict]) -> list[dict]:
    out = []
    for arr in sorted(by_arr):
        row = finish_row("arrondissement", f"{arr}{'er' if arr == 1 else 'e'}", by_arr[arr])
        row["code"] = f"751{arr:02d}"
        row["sector"] = sector_of_arr(arr)
        out.append(row)
    return out


def totals(rows: list[dict]) -> dict:
    t = {k: sum(r[k] for r in rows) for k in COUNT_FIELDS}
    return finish_row("scope", "Paris", t)


# ---------------------------------------------------------------------------
# 4. Consistency checks against what the City proclaimed / published
# ---------------------------------------------------------------------------

# Figures typed from the official proclamation / paris.fr result pages (see SOURCES below).
PROCLAIMED = {
    "paris_scooters_2023": {"registered": 1382322, "voters": 103084, "blankAndNull": 443, "pourVotes": 11256,
                            "contreVotes": 91385, "yesSharePct": 10.97},
    "paris_suv_2024": {"registered": 1374532, "voters": 78121, "blankAndNull": 366, "pourVotes": 42415,
                       "contreVotes": 35340, "yesSharePct": 54.55},
    "paris_streets_2025": {"registered": 1391369, "voters": 56489, "blankAndNull": 314, "pourVotes": 37054,
                           "contreVotes": 19121, "yesSharePct": 65.96, "turnoutPct": 4.06},
}
# 'Pour' % of expressed votes by sector, as printed on the paris.fr result pages (order = SECTORS).
PUBLISHED_SECTOR_POUR = {
    "paris_scooters_2023": [14.23, 12.06, 11.20, 11.36, 11.28, 12.44, 12.63, 11.67, 10.75, 10.00, 11.70, 9.24, 8.23,
                            11.91, 11.15, 10.33, 9.66],
    "paris_suv_2024": [62.67, 60.18, 47.38, 25.95, 26.95, 61.34, 76.79, 71.54, 60.07, 63.66, 59.20, 40.36, 18.05,
                       37.63, 71.99, 73.12, 73.57],
    "paris_streets_2025": [69.67, 66.90, 52.93, 33.72, 38.70, 69.59, 82.95, 79.42, 69.99, 69.55, 67.31, 59.12, 26.52,
                           55.38, 72.95, 71.67, 77.54],
}


def run_checks(vote_id: str, sectors: list[dict], tot: dict, extra_sector_sets: dict | None = None) -> list[dict]:
    p = PROCLAIMED[vote_id]
    checks = []

    def add(name, ok, detail):
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    add("pour+contre == expressed in every sector", all(s["pourVotes"] + s["contreVotes"] == s["expressed"] for s in sectors),
        "Each sector row: Pour + Contre equals suffrages exprimés.")
    add("sum of sectors: Pour votes == proclaimed", tot["pourVotes"] == p["pourVotes"], f"{tot['pourVotes']} vs {p['pourVotes']}")
    add("sum of sectors: Contre votes == proclaimed", tot["contreVotes"] == p["contreVotes"], f"{tot['contreVotes']} vs {p['contreVotes']}")
    add("sum of sectors: voters == proclaimed", tot["voters"] == p["voters"], f"{tot['voters']} vs {p['voters']}")
    add("sum of sectors: blank+null == proclaimed", tot["blank"] + tot["null"] == p["blankAndNull"],
        f"{tot['blank'] + tot['null']} vs {p['blankAndNull']}")
    reg_diff = tot["registered"] - p["registered"]
    add("sum of sectors: registered == proclaimed (±1)", abs(reg_diff) <= 1,
        f"{tot['registered']} vs {p['registered']} (difference {reg_diff:+d}; open-data file vs paris.fr page)")
    add("Pour share == proclaimed (2 decimals)", round(tot["yesShare"] * 100, 2) == p["yesSharePct"],
        f"{tot['yesShare'] * 100:.4f} % vs {p['yesSharePct']} %")
    if "turnoutPct" in p:
        add("turnout == proclaimed (2 decimals)", round(tot["turnout"] * 100, 2) == p["turnoutPct"],
            f"{tot['turnout'] * 100:.4f} % vs {p['turnoutPct']} %")
    pub = PUBLISHED_SECTOR_POUR[vote_id]
    worst = max(abs(round(s["yesShare"] * 100, 2) - v) for s, v in zip(sectors, pub))
    add("sector Pour % == paris.fr page (2 decimals)", worst < 0.006, f"largest difference {worst:.3f} percentage points")
    for name, other in (extra_sector_sets or {}).items():
        same = all(a[k] == b[k] for a, b in zip(sectors, other) for k in COUNT_FIELDS if k != "registered")
        add(f"sector file == {name}", same, "Counts identical (registered may differ by 1).")
    return checks


# ---------------------------------------------------------------------------
# 5. Hand-checked facts (wording, rules, eligibility, polls) with sources
# ---------------------------------------------------------------------------

SRC = {
    "sc_page": {"name": "paris.fr — Pour ou contre les trottinettes en libre-service (results page)",
                "url": "https://www.paris.fr/pages/pour-ou-contre-les-trottinettes-en-libre-service-23231"},
    "sc_proclamation": {"name": "Commission de contrôle — proclamation des résultats, 2 avril 2023 (PDF)",
                        "url": "https://cdn.paris.fr/paris/2023/04/03/proclamation2avril2023def-PySW.pdf"},
    "sc_report": {"name": "Rapport de la commission de contrôle, votation du 2 avril 2023 (PDF, 19 p.)",
                  "url": "https://cdn.paris.fr/paris/2023/04/14/rapport-votation-du-2-avril-2023-def-FyKO.pdf"},
    "sc_rules": {"name": "Règlement de la votation du 2 avril 2023 (PDF, scanned; art. 7, 10, 12, 13)",
                 "url": "https://cdn.paris.fr/paris/2023/03/13/reglement-votation-du-2-avril-2023-OroB.pdf"},
    "sc_speech": {"name": "Anne Hidalgo, communication au Conseil de Paris, 14 mars 2023 (PDF)",
                  "url": "https://cdn.paris.fr/paris/2023/05/31/pour-contre-trottinettes-a-paris-OST8.pdf"},
    "sc_opendata": {"name": "opendata.paris.fr — votation-trottinette-2023 (results by sector, xlsx)",
                    "url": DATASET_PAGES["scooters_2023"]},
    "sc_poll": {"name": "Ifop-Fiducial pour Le Figaro et Sud Radio — Le climat municipal à Paris, mars 2023 (PDF, p. 21)",
                "url": "https://www.ifop.com/wp-content/uploads/2023/03/119819-resultats-ensemble.pdf"},
    "sc_press": {"name": "L'Info Durable (with AFP, 3 Apr 2023) — Abstention, mais Paris dit non aux trottinettes en libre-service",
                 "url": "https://www.linfodurable.fr/vie-quotidienne/abstention-mais-paris-dit-non-aux-trottinettes-en-libre-service-37765"},
    "sc_cost": {"name": "L'Info Durable (AFP) — le vote sur les trottinettes a coûté 390 000 euros (secondary)",
                "url": "https://www.linfodurable.fr/paris-le-vote-sur-les-trottinettes-en-libre-service-coute-390000-euros-37830"},
    "suv_page": {"name": "paris.fr — Plus ou moins de SUV ? Résultats de la votation du 4 février 2024",
                 "url": "https://www.paris.fr/pages/plus-ou-moins-de-suv-les-parisiens-et-parisiennes-sont-invites-a-voter-le-4-fevrier-25381"},
    "suv_infographic": {"name": "paris.fr — infographie tarif SUV (PDF image: hourly rates by zone)",
                        "url": "https://cdn.paris.fr/paris/2023/12/19/suv_infog_1200x1200_24-7dB3.pdf"},
    "suv_report": {"name": "Rapport de la commission de contrôle, votation du 4 février 2024 (PDF, scanned)",
                   "url": "https://cdn.paris.fr/paris/2024/03/01/rapport-votation-du-4-fevrier-2024-version-finale-XWBe.pdf"},
    "suv_opendata": {"name": "opendata.paris.fr — votation_suv_2024 (by sector) and votation_suv_2024_bv (by polling station)",
                     "url": DATASET_PAGES["suv_2024"]},
    "suv_poll": {"name": "Clean Cities Campaign — New polling shows that Parisians support higher parking charges for SUVs (OpinionWay, 17 Jan 2024)",
                 "url": "https://cleancitiescampaign.org/?p=18051"},
    "suv_council": {"name": "paris.fr — Conseil de Paris de mai 2024: entrée en vigueur du tarif SUV",
                    "url": "https://www.paris.fr/pages/les-temps-forts-du-conseil-de-paris-de-mai-2024-27168#l-entree-en-vigueur-de-l-augmentation-du-tarif-du-stationnement-des-suv"},
    "suv_press": {"name": "Maire-info (AFP, 5 Feb 2024) — tarification spéciale SUV approuvée à près de 55 %",
                  "url": "https://www.maire-info.com/transports/paris-la-tarification-du-stationnement-speciale-suv-approuvee-pres-55--article-28273"},
    "suv_cost": {"name": "L'Info Durable (AFP) — la votation anti-SUV a coûté 400 000 euros (secondary)",
                 "url": "https://www.linfodurable.fr/paris-la-votation-anti-suv-coute-400000-euros-43588"},
    "st_page": {"name": "paris.fr — Votation du 23 mars 2025: 65,96 % des votants pour piétonniser et végétaliser 500 nouvelles rues",
                "url": "https://www.paris.fr/pages/nouvelle-votation-rendez-vous-aux-urnes-le-23-mars-2025-29900"},
    "st_report": {"name": "Rapport de la commission de contrôle, votation du 23 mars 2025 (PDF, juin 2025)",
                  "url": "https://cdn.paris.fr/paris/2025/06/16/20250705-rapport-cc-votation-2025-v3-couv-corrigee-def-HOEi.pdf"},
    "st_rules": {"name": "Règlement de la votation du 23 mars 2025 (PDF)",
                 "url": "https://cdn.paris.fr/paris/2025/02/06/reglement-de-la-votation-du-23-mars-2025-xV6U.pdf"},
    "st_opendata": {"name": "opendata.paris.fr — votation mars 2025 (results by polling station)",
                    "url": DATASET_PAGES["streets_2025"]},
    "st_poll": {"name": "Commission des sondages — notice OpinionWay pour Clean Cities, mars 2025 (PDF)",
                "url": "https://www.commission-des-sondages.fr/notices/files/notices/2025/mars/9907-opinionway-pour-clean-cities-les-parisiens-et-la-pietonnisation-de-la-ville-notice-a-la-commission-des-sondages-mars-2025.pdf"},
    "st_cleancities": {"name": "Clean Cities Campaign — note Paris (mars 2025, poll section p. 9-11)",
                       "url": "https://cleancitiescampaign.org/wp-content/uploads/2025/03/Paris_leader-sur-les-rues-scolaires-en-retard-sur-la-marche-et-les-espaces-verts.pdf"},
}


def src(*keys):
    return [SRC[k] for k in keys]


SCOOTERS = {
    "id": "paris_scooters_2023",
    "voteName": "Votation du 2 avril 2023 — trottinettes en libre-service",
    "titleEn": "Paris citizens' vote on rental e-scooters",
    "date": "2023-04-02",
    "question": "Pour ou contre les trottinettes en libre-service à Paris ?",
    "questionAsProclaimed": "« POUR ou CONTRE les trottinettes en libre-service à Paris ? »",
    "ballotOptions": {"pour": "Pour les trottinettes en libre-service à Paris",
                      "contre": "Contre les trottinettes en libre-service à Paris"},
    "yesMeaning": ("'Pour' = keep allowing rental (self-service, free-floating) e-scooters on Paris streets, i.e. the City "
                   "would renew or re-tender the public-space agreements with operators. 'Contre' = end them when the "
                   "agreements expired on 31 August 2023."),
    "legalStatus": ("Consultative 'consultation facultative ouverte' (Code des relations entre le public et l'administration "
                    "L.131-1; CGCT L.1111-2). The Mayor said the City would 'purely and simply' follow the result."),
    "eligibility": {
        "who": ("People registered on the Paris electoral lists by 3 March 2023 (midnight). EU nationals registered on the "
                "complementary electoral list for municipal elections were part of the electorate (règlement, art. 7). "
                "Young people turning 18 by 1 April 2023 and newly naturalised citizens could vote if INSEE had added "
                "them to the electoral register (art. 10)."),
        "euCitizensOnComplementaryList": True,
        "minimumAge": 18,
        "registrationDeadline": "2023-03-03",
        "note": ("Voters living abroad and those registered under articles L.12-L.14 of the electoral code are attached "
                 "to the 4e arrondissement list (règlement), which adds registrations to 'Paris Centre' and can lower "
                 "its measured turnout."),
        "verified": True,
        "sources": src("sc_rules", "sc_report"),
    },
    "modalities": {
        "hours": "09:00-19:00", "pollingStations": 203, "votingSites": 21, "inPersonOnly": True,
        "proxyVoting": False, "electronicVoting": False,
        "notes": ["Same day as the Paris Marathon; the control commission recommended avoiding such clashes in future.",
                  "The commission noted many complaints (often older or disabled people) that there was no proxy or remote vote.",
                  "The commission criticised the operators' campaign with paid influencers (report, p. 18).",
                  "Operators offered a free ride on voting day (AFP), a tactic the press called controversial."],
        "sources": src("sc_report", "sc_rules"),
    },
    "rules": {
        "operators": ["Dott", "Lime", "Tier"],
        "fleetCap": "3 operators, each allowed at most 5,000 vehicles (about 15,000 in total)",
        "agreementsExpire": "2023-08-31",
        "scope": ("Rental (self-service) e-scooters only. Privately owned e-scooters were not concerned according to some press "
                  "reports (not checked in a primary source)."),
        "outcome": "Rental e-scooters left Paris streets at the end of the agreements on 31 August 2023.",
        "sources": src("sc_speech", "sc_report", "sc_page", "sc_press"),
    },
    "costEur": {"value": 390692, "note": "Cost reported by City Hall to AFP (secondary source).", "verified": False,
                "sources": src("sc_cost")},
    "poll": {
        "org": "Ifop-Fiducial for Le Figaro and Sud Radio", "date": "2023-03-07/2023-03-13", "n": 1002,
        "yesShare": 0.30, "url": SRC["sc_poll"]["url"],
        "note": ("Representative sample of Parisians aged 18+ (quotas after stratification by arrondissement, online). "
                 "Voting intention among Paris voters, % of expressed: Pour 30 / Contre 70. Same question as the ballot."),
    },
    "polls": [{
        "org": "Ifop-Fiducial", "client": "Le Figaro, Sud Radio", "fieldwork": "2023-03-07/2023-03-13", "n": 1002,
        "population": "Parisians aged 18+, online; voting-intention base = Paris voters",
        "question": ("Si dimanche prochain devait se dérouler la votation sur l'avenir du stationnement des trottinettes en "
                     "libre-service, ici à Paris, y aurait-il plus de chances que vous votiez pour ou contre les trottinettes "
                     "en libre-service à Paris ?"),
        "results": {"pour": 0.30, "contre": 0.70, "base": "% of expressed"},
        "otherFindings": {"organisingAVoteIsAGoodThing": 0.85},
        "url": SRC["sc_poll"]["url"], "verified": True,
    }],
    "sources": src("sc_page", "sc_proclamation", "sc_report", "sc_rules", "sc_opendata", "sc_poll", "sc_press"),
}

SUV = {
    "id": "paris_suv_2024",
    "voteName": "Votation du 4 février 2024 — tarif de stationnement des voitures lourdes (« Plus ou moins de SUV à Paris ? »)",
    "titleEn": "Paris citizens' vote on a parking fee for heavy cars (SUVs)",
    "date": "2024-02-04",
    "question": ("Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures individuelles lourdes, "
                 "encombrantes, polluantes ?"),
    "campaignTitle": "Plus ou moins de SUV à Paris ?",
    "ballotOptions": {"pour": "Pour", "contre": "Contre"},
    "yesMeaning": ("'Pour' = create the specific (tripled) visitor parking rate for heavy cars; 'Contre' = keep the normal "
                   "rate for all cars."),
    "legalStatus": "Consultative vote under the control of an independent control commission.",
    "eligibility": {
        "who": ("People registered on the Paris electoral lists on 8 January 2024. EU nationals could vote only if registered "
                "on the complementary list for municipal elections."),
        "euCitizensOnComplementaryList": True,
        "minimumAge": 18,
        "registrationDeadline": "2024-01-08",
        "quote": ("« S'agissant des ressortissants communautaires, seuls ceux inscrits sur la liste complémentaire pour les "
                  "élections municipales pouvaient participer à cette votation. »"),
        "verified": True,
        "sources": src("suv_page"),
    },
    "modalities": {
        "hours": "09:00-19:00", "pollingStations": 222, "votingSites": 38, "inPersonOnly": True,
        "proxyVoting": False, "electronicVoting": False,
        "notes": ["Five arrondissements asked an extra local question the same day (see localQuestions), which may have "
                  "raised turnout there."],
        "sources": src("suv_page", "suv_opendata"),
    },
    "rules": {
        "inForceFrom": "2024-10-01",
        "who": ["Visitors (non-residents of the zone) parking a heavy car on the street.",
                "Heavy = petrol, diesel or plug-in hybrid car of 1.6 tonnes or more, or electric car of 2 tonnes or more."],
        "weightThresholdsTonnes": {"thermalOrPluginHybrid": 1.6, "electric": 2.0},
        "visitorRatesEurPerHour": {
            "arr_1_to_11": {"normal": 6, "heavyCar": 18},
            "arr_12_to_20": {"normal": 4, "heavyCar": 12},
        },
        "sixHourTotalEur": {"arr_1_to_11": {"normal": 75, "heavyCar": 225}, "arr_12_to_20": {"normal": 50, "heavyCar": 150}},
        "billing": "Charged in 15-minute steps; tariff table shows up to 6 hours.",
        "exempt": [
            "Paris residents and sedentary professionals parked in their own authorised (residential) zone",
            "Taxi drivers at dedicated taxi ranks",
            "Craftspeople (artisans), health professionals and others eligible for the professional rate",
            "Disabled people (PMR) and holders of the 'carte mobilité inclusion - stationnement'",
        ],
        "adopted": "Conseil de Paris, May 2024",
        "sources": src("suv_page", "suv_infographic", "suv_council"),
    },
    "localQuestions": {
        "note": "Same-day arrondissement questions (paris.fr). Turnout figures as published.",
        "rows": [
            {"sector": "Paris Centre", "topic": "Redesign of Place du Louvre for pedestrians, greenery and public transport",
             "pourShare": 0.7151, "turnout": 0.0646},
            {"sector": "8e", "topic": "Faster pedestrianisation/greening of streets incl. parts of rue de Monceau and rue de Liège",
             "pourShare": 0.4108, "turnout": 0.0869},
            {"sector": "10e", "topic": "Boulevard de Magenta pavements for pedestrians and safer cycle lanes",
             "pourShare": 0.7583, "turnout": 0.068},
            {"sector": "12e", "topic": "New pedestrian areas near municipal facilities used by children",
             "pourShare": 0.6988, "turnout": 0.062},
            {"sector": "20e", "topic": "Trial of a solidarity food fund (caisse alimentaire solidaire)",
             "pourShare": 0.8186, "turnout": 0.0435},
        ],
        "sources": src("suv_page"),
    },
    "costEur": {"value": 400000, "note": "About €400,000 according to deputy mayor Emmanuel Grégoire (AFP, secondary).",
                "verified": False, "sources": src("suv_cost")},
    "poll": {
        "org": "OpinionWay for Respire and Clean Cities", "date": "2024-01-02/2024-01-09", "n": 1019,
        "yesShare": 0.61, "url": SRC["suv_poll"]["url"],
        "note": ("NOT the ballot question: 61 % support parking charges based on vehicle weight (70 % if conditions such as "
                 "reinvesting revenue and exempting residents apply). Commissioned by groups campaigning FOR the measure. "
                 "Sample of 1,019 people aged 18+, online (CAWI)."),
    },
    "polls": [{
        "org": "OpinionWay", "client": "Respire, Clean Cities Campaign (advocates of the measure)",
        "fieldwork": "2024-01-02/2024-01-09", "published": "2024-01-17", "n": 1019,
        "population": "Representative sample aged 18+ (as described by the client), online CAWI",
        "question": "Support for parking charges based on vehicle weight (full questionnaire not published).",
        "results": {"supportWeightBasedParkingCharges": 0.61, "supportIfConditions": 0.70, "badOpinionOfSUVs": 0.56},
        "url": SRC["suv_poll"]["url"], "verified": True,
        "caveat": "No independent voting-intention poll on the exact ballot question was found.",
    }],
    "sources": src("suv_page", "suv_opendata", "suv_infographic", "suv_report", "suv_poll", "suv_press"),
}

STREETS = {
    "id": "paris_streets_2025",
    "voteName": "Votation du 23 mars 2025 — végétaliser et rendre piétonnes 500 nouvelles rues",
    "titleEn": "Paris citizens' vote on greening and pedestrianising 500 more streets",
    "date": "2025-03-23",
    "question": "Pour ou contre végétaliser et rendre piétonnes 500 nouvelles rues dans Paris, réparties dans tous les quartiers ?",
    "ballotOptions": {"pour": "Pour", "contre": "Contre"},
    "yesMeaning": ("'Pour' = speed up greening and pedestrianising 500 streets (5 to 8 per neighbourhood, within ~300 m of "
                   "voters' homes), chosen with residents from April 2025, about 3 years of works."),
    "legalStatus": "Consultative vote under the control of an independent control commission (third Paris votation).",
    "eligibility": {
        "who": ("People registered on the Paris electoral lists by 26 February 2025, including EU nationals on the municipal "
                "complementary list and, for the first time, French or EU nationals aged 16 and 17."),
        "euCitizensOnComplementaryList": True,
        "minimumAge": 16,
        "registrationDeadline": "2025-02-26",
        "note": ("Nine EU citizens registered only on the European complementary list were allowed to vote after a decision "
                 "of the commission; it suggested opening future votations to that list too."),
        "verified": True,
        "sources": src("st_report"),
    },
    "modalities": {
        "hours": "09:00-19:00", "pollingStations": 218, "votingSites": 34, "inPersonOnly": True,
        "proxyVoting": False, "electronicVoting": False,
        "notes": ["Seven arrondissements asked an extra local question the same day."],
        "sources": src("st_page", "st_report"),
    },
    "rules": {
        "streets": 500, "perNeighbourhood": "5 to 8", "distanceFromHomes": "less than 300 m",
        "timeline": "Street identification with residents from April 2025, about three years of works",
        "context": "Since 2020: more than 10,000 outdoor parking spaces removed and 197 streets greened (paris.fr).",
        "sources": src("st_page"),
    },
    "localQuestions": {
        "note": "Same-day arrondissement questions (paris.fr). Turnout as published.",
        "rows": [
            {"sector": "Paris Centre", "topic": "Shops, housing and greenery on the Île de la Cité", "pourShare": 0.7043, "turnout": 0.0423},
            {"sector": "10e", "topic": "Transforming Porte Saint-Martin and Porte Saint-Denis", "pourShare": 0.8385, "turnout": 0.0566},
            {"sector": "11e", "topic": "At least one pedestrian heart per neighbourhood", "pourShare": 0.8026, "turnout": 0.0464},
            {"sector": "14e", "topic": "Trial of a solidarity food fund", "pourShare": 0.7208, "turnout": 0.0456},
            {"sector": "17e", "topic": "Digital technologies for street lighting and maintenance", "pourShare": 0.7684, "turnout": 0.0348},
            {"sector": "19e", "topic": "Memorial garden for pets", "pourShare": 0.5864, "turnout": 0.0419},
            {"sector": "20e", "topic": "Children's council with real powers", "pourShare": 0.8159, "turnout": 0.0324},
        ],
        "sources": src("st_page"),
    },
    "poll": {
        "org": "OpinionWay for Clean Cities", "date": "2025-02-21/2025-02-27", "n": 903,
        "yesShare": round(0.56 / (0.56 + 0.31), 4), "url": SRC["st_poll"]["url"],
        "note": ("Same question as the ballot. Among 903 registered voters (of 1,008 Parisians aged 16+): Pour 56 %, Contre 31 %, "
                 "abstention/blank/null/don't know 13 %. yesShare = 56/(56+31). Commissioned by a group campaigning FOR the measure."),
    },
    "polls": [{
        "org": "OpinionWay", "client": "Clean Cities Campaign (advocate of the measure)",
        "fieldwork": "2025-02-21/2025-02-27", "n": 1008, "nRegistered": 903,
        "population": "Parisians aged 16+, quotas (sex, age, occupation, arrondissement), online CAWI",
        "question": "Si la votation avait lieu dimanche prochain, pour laquelle des réponses suivantes y aurait-il le plus de chance que vous votiez ?",
        "results": {"pour": 0.56, "contre": 0.31, "abstainBlankNullDontKnow": 0.13,
                    "pourShareOfExpressed": round(0.56 / 0.87, 4), "heardOfTheVote": 0.75,
                    "favourPedestrianisingSuitableStreets": 0.74},
        "url": SRC["st_poll"]["url"], "verified": True,
    }],
    "notes": ["The paris.fr page prints '69,99 % / 31,01 %' for the 12e; the official open data gives 69.99 % / 30.01 % (typo on the page)."],
    "sources": src("st_page", "st_opendata", "st_report", "st_rules", "st_poll", "st_cleancities"),
}


def build_votations(offline: bool) -> dict:
    print("Votations: reading official open-data files ...")
    f_sc = http_get(DOWNLOADS["scooters_2023_sectors.xlsx"], CACHE / "votation_2023_04_02.xlsx", offline)
    f_suv = http_get(DOWNLOADS["suv_2024_sectors.xlsx"], CACHE / "votation_suv_2024_02_04.xlsx", offline)
    f_suv_bv = http_get(DOWNLOADS["suv_2024_bureaux.xlsx"], CACHE / "votation_suv_2024_02_04_bv.xlsx", offline)
    f_st = http_get(DOWNLOADS["streets_2025_bureaux.csv"], CACHE / "votation_rues_2025_bv.csv", offline)

    out = {}
    # 2023 scooters: sector file only (no polling-station file was published).
    sec = sectors_from_sector_xlsx(f_sc)
    tot = totals(sec)
    out["paris_scooters_2023"] = {**SCOOTERS, "result": tot, "bySector": sec,
                                  "checks": run_checks("paris_scooters_2023", sec, tot)}

    # 2024 SUV: sector file + polling-station file (gives the 1er-4e separately).
    sec = sectors_from_sector_xlsx(f_suv)
    bv_rows = read_xlsx_first_sheet(f_suv_bv)
    by_arr = arrs_from_bureaux(bv_rows, "ID_BV", XLSX_MAP)
    sec_from_bv = sectors_from_arrs(by_arr)
    tot = totals(sec)
    out["paris_suv_2024"] = {**SUV, "result": tot, "bySector": sec, "byArrondissement": arr_rows(by_arr),
                             "checks": run_checks("paris_suv_2024", sec, tot, {"polling-station file summed": sec_from_bv})}

    # 2025 streets: polling-station CSV only.
    with f_st.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh, delimiter=";"))
    by_arr = arrs_from_bureaux(rows, "id_bv", CSV_MAP)
    sec = sectors_from_arrs(by_arr)
    tot = totals(sec)
    out["paris_streets_2025"] = {**STREETS, "result": tot, "bySector": sec, "byArrondissement": arr_rows(by_arr),
                                 "checks": run_checks("paris_streets_2025", sec, tot)}

    # Poll vs vote gap (a poll approximates 'everyone', the vote approximates 'people who turn up').
    for v in out.values():
        p = v.get("poll")
        if p and p.get("yesShare") is not None:
            v["pollGap"] = {"actualMinusPoll": round(v["result"]["yesShare"] - p["yesShare"], 4),
                            "comparable": v["id"] != "paris_suv_2024",
                            "note": ("Positive = voters were more 'Pour' than the poll. Only meaningful when the poll asked "
                                     "the ballot question (not the case for the SUV vote).")}
        # Small summary of turnout spread across sectors (useful to calibrate participation).
        t = sorted(v["bySector"], key=lambda s: s["turnout"])
        v["turnoutRange"] = {"lowest": {"sector": t[0]["sector"], "turnout": t[0]["turnout"]},
                             "highest": {"sector": t[-1]["sector"], "turnout": t[-1]["turnout"]}}
    return out


# ---------------------------------------------------------------------------
# 6. Data-centre context (real facts) and the HYPOTHETICAL site + proposal
# ---------------------------------------------------------------------------

DSRC = {
    "region2026": {"name": "Région Île-de-France — Stratégie régionale d'implantation des centres de données, rapport CR 2026-039 (juin 2026, PDF)",
                   "url": "https://www.iledefrance.fr/sites/default/files/2026-06/cr2026-039.pdf"},
    "ae_dugny": {"name": "Autorité environnementale (IGEDD) — avis n° 2024-08 du 11 avril 2024, Dugny Digital Hub (PDF)",
                 "url": "https://www.igedd.developpement-durable.gouv.fr/IMG/pdf/240411_centre_donnees_dugny_digital_hub_93_debattu_corrige_cle565e1b.pdf"},
    "mrae_bourget": {"name": "MRAe Île-de-France — avis APJIF-2025-056 du 30 juin 2025, centre de données au Bourget (PDF)",
                     "url": "https://www.mrae.developpement-durable.gouv.fr/IMG/pdf/2025_06_30_bourget_centre_de_donnees_segro_avis_signe.pdf"},
    "f3_dugny": {"name": "France 3 Paris IDF (20 May 2025) — Pourquoi le plus grand data center de France bientôt installé à Dugny inquiète les riverains",
                 "url": "https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/pourquoi-le-plus-grand-data-center-de-france-bientot-installe-a-dugny-inquiete-les-riverains-3157335.html"},
    "f3_bourget": {"name": "France 3 Paris IDF (27 Nov 2025) — Des habitants s'élèvent contre le projet d'un nouveau data center en Seine-Saint-Denis",
                   "url": "https://france3-regions.franceinfo.fr/paris-ile-de-france/seine-saint-denis/des-habitants-s-elevent-contre-le-projet-d-un-nouveau-data-center-en-seine-saint-denis-3257029.html"},
    "bdt_bourget": {"name": "Banque des Territoires (28 Jul 2026) — Datacenters: les projets dans la Drôme et au Bourget contestés",
                    "url": "https://www.banquedesterritoires.fr/datacenters-les-projets-dimplantation-dans-la-drome-et-au-bourget-contestes"},
    "hellowatt_bourget": {"name": "Hellowatt (updated 13 Jan 2026) — Le Bourget: ce futur data center consommerait deux fois plus d'énergie que la ville",
                          "url": "https://www.hellowatt.fr/blog/bourget-data-center-petition/"},
    "cd93_pdp": {"name": "Département de la Seine-Saint-Denis (5 Jul 2024) — Le plus grand data center de France",
                 "url": "https://seinesaintdenis.fr/actualite/emploi-entrepreneuriat/Le-plus-grand-data-center-de-France/"},
    "enedis2025": {"name": "Enedis, Observatoire de la transition écologique (29 Oct 2025) — La France attractive pour les data centers",
                   "url": "https://observatoire.enedis.fr/article/la-france-attractive-pour-les-data-centers-2"},
    "an_q14126": {"name": "Assemblée nationale — question écrite n° 14126 (J. Guedj), answer JO 15 Sep 2026 (PDF)",
                  "url": "https://questions.assemblee-nationale.fr/dyn/17/questions/QANR5L17QE14126.pdf"},
    "cpr2022": {"name": "Choose Paris Region — Datacenters en Île-de-France (2022 guide; promotional agency, PDF)",
                "url": "https://www.chooseparisregion.org/sites/default/files/pdf/datacenters/Datacenters-Paris-Region-2022.pdf"},
    "idf_equinix_heat": {"name": "Région Île-de-France — Récupération de chaleur fatale du data center Equinix et extension du réseau Plaine Commune Énergie (CP2024-180)",
                         "url": "https://www.iledefrance.fr/tous-les-services/ma-region-pres-de-chez-moi/environnement/energie/184193-recuperation-de-chaleur-fatale-du-data-center-equinix-et-extension-du-reseau-de-chaleur-plaine-commune-energie"},
    "engie_2024": {"name": "ENGIE Solutions press release (21 Jun 2024) — mise en service de la sous-station Equinix (PDF; blocked 403 from our machine, figures via secondary summaries)",
                   "url": "https://engie-solutions.com/sites/default/files/assets/2024-06/cp_mise_en_service_officielle_de_la_sous-station_equinix_vdef_v2.pdf"},
    "engie_2022": {"name": "ENGIE Solutions press release (Sep/Oct 2022) — convention de raccordement PCE-SMIREC-Equinix (PDF)",
                   "url": "https://www.engie-solutions.com/sites/default/files/assets/2022-10/cp_-_signature_convention_de_raccordement_pce-smirec-equinix-mgp_0.pdf"},
    "ademe_pleyel": {"name": "ADEME/SMIREC press release (1 Dec 2023) — inauguration réseau Pleyel (~61,500 housing equivalents on the SMIREC network)",
                     "url": "https://presse.ademe.fr/wp-content/uploads/2024/03/2023-12-01-cp-inauguration-pleyel.pdf"},
    "gossement_2026": {"name": "Cabinet Gossement Avocats — Data centers: ce que change la loi n° 2026-403 du 26 mai 2026 (commentary)",
                       "url": "https://www.gossement-avocats.com/blog/centres-de-donnees-data-centers-ce-que-change-la-loi-de-simplification-de-la-vie-economique/"},
    "novethic": {"name": "Novethic — Data centers: ces monstres discrets qui débarquent en ville (grid congestion in La Plaine, C. Diguet)",
                 "url": "https://grandformat.novethic.fr/data-centers/"},
    "osm": {"name": "OpenStreetMap contributors (ODbL), queried via Overpass API on 2026-10-26",
            "url": "https://www.openstreetmap.org/way/47028132"},
}


def dsrc(*keys):
    return [DSRC[k] for k in keys]


SITE = {
    "lon": 2.4125, "lat": 48.9265,
    "label": "Hypothetical site — Rateau industrial zone, La Courneuve",
    # French place phrase read by pipeline/scenarios.py ("... en Seine-Saint-Denis (<placeFr>)").
    "placeFr": "dans la zone industrielle Rateau, à La Courneuve",
    "commune": "La Courneuve", "communeCode": "93027", "dept": "93",
    "hypothetical": True,
    "rationale": [
        "Existing industrial land (OSM landuse=industrial, 'Zone Industrielle Rateau', way 47028132, about 28 ha), which fits "
        "the regional rule (SDRIF-E OR 126) that data centres go first to existing business sites.",
        "Next to Europe's densest data-centre cluster (Plaine Commune / La Courneuve), with fibre and 225 kV substations "
        "nearby, so it is the kind of place a real developer would look at.",
        "Close to dense housing, schools and the A86 motorway, so the consultation questions (noise, heat, generators, grid "
        "works, jobs, district heating) are realistic and touch different groups of residents.",
        "Inside the map bbox and about 4 km from the Stade de France landmark, so it is visible on the map.",
    ],
    "caveats": [
        "Indicative point only: no parcel-level study was done; the zone today hosts warehouses, municipal and road-authority "
        "depots and active industry (e.g. a Safran Electronics & Defense building a few hundred metres away in OSM).",
        "This is NOT a real project. Real projects nearby (Paris Digital Park in La Courneuve, Dugny Digital Hub, the Segro "
        "project in Le Bourget) are listed in 'realProjects' and are separate.",
    ],
    "osmEvidence": {
        "polygon": {"osm": "way/47028132", "tags": {"landuse": "industrial", "name": "Zone Industrielle Rateau"}, "areaHa": 28.4},
        # Fallback values (straight-line, from OSM on 2026-10-26); replaced by recomputed ones when the OSM cache exists.
        "nearby": [
            {"what": "Motorway 'A 86' (DIRIF)", "distanceM": 180},
            {"what": "Construction site 'Chantier Grand Paris Express Lignes 16/17 - Entonnement Ouest - Rue de Verdun'", "distanceM": 390},
            {"what": "School 'École primaire Paul Doumer'", "distanceM": 470},
            {"what": "Nursery / crèche 'Crèche Départementale Jean Jaurès'", "distanceM": 660},
            {"what": "Nearest mapped data centre 'Interxion PAR7' (Interxion)", "distanceM": 770},
        ],
        "note": "Distances are straight-line, rounded to 10 m, from OSM objects.",
        "sources": dsrc("osm"),
    },
}

HYPOTHETICAL = {
    "hypothetical": True,
    "inspiredBy": "Inspired by real campuses in Seine-Saint-Denis (Dugny Digital Hub, Paris Digital Park, Le Bourget project); not a real project.",
    "parameters": {
        "gridConnectionMW": {"value": 200, "basis": "Same order as Dugny Digital Hub (200 MW, 176 MW IT) — Ae 2024-08 / France 3."},
        "itLoadMW": {"value": 160, "basis": "Assumption (~80 % of connection)."},
        "siteAreaHa": {"value": 8, "basis": "Dugny: 9.5 ha site for 3 buildings; Le Bourget: 3.7 ha for 75 MW."},
        "buildingFootprintM2": {"value": 35000, "basis": "Dugny: 41,500 m² footprint for 200 MW."},
        "buildings": {"value": 3, "basis": "Dugny and Le Bourget both have three buildings."},
        "maxHeightM": {"value": 28, "basis": "Dugny: 27.4 m buildings, chimneys up to 32.4 m."},
        "constructionYears": {"value": 4, "basis": "Dugny: three phases from late 2024 to early 2030; we assume 4 years in 3 phases."},
        "constructionJobsPeak": {"value": 600, "basis": "ASSUMPTION (no published figure for comparable sites was found)."},
        "permanentJobsOnSite": {"value": 120, "basis": "Dugny: ~110 people per day on site; Paris Digital Park: 80-90 staff plus ~300 client staff."},
        "annualElectricityGWh": {"value": 1050, "basis": "200 MW × 8,760 h × 60 % average load (Digital Realty sites average 50-70 % of capacity, Ae 2024-08)."},
        "backupGenerators": {"value": 100, "basis": "Dugny: 108 HVO generators for 200 MW; tested monthly in small groups."},
        "waterM3PerYear": {"value": 5000, "basis": "Dugny: 5,090 m³/yr with closed-loop cooling (humidifiers + sanitary)."},
        "cooling": "Closed-loop dry coolers and air-cooled chillers, direct liquid cooling for AI racks; no evaporative towers.",
        "heatRecoveryMWth": {"value": 15, "basis": "Commitment level assumed: Le Bourget planned 12 MW of 75 MW (Oct-Apr); Equinix PA10 delivers up to 6.6 MW."},
        "heatRecoveryGWhPerYear": {"value": 50, "basis": "Assumption: 15 MW over a ~3,300-hour heating season."},
        "homesHeated": {"value": 5000, "basis": "≈ 50 GWh ÷ ~9.4 MWh per housing-equivalent (Coriance network: 85 GWh for 9,000 housing-equivalents, Ae 2024-08)."},
        "localTaxEurPerYear": {"value": "6-9 million", "basis": "ROUGH: ~€900 M of buildings/infrastructure × €2-3 M per €300 M tranche (Choose Paris Region 2022, after the 2022 halving of property tax on such sites)."},
        "investmentEur": {"value": "about 2 billion", "basis": "Dugny: €2 billion (France 3); Paris Digital Park: €1.15 billion (CD93)."},
        "gridWorks": "New on-site 225 kV substation and 2 underground 225 kV lines to existing RTE 225 kV substations 1.2-2.1 km away (Avenir, La Courneuve, Le Bourget; street trenching for several months).",
        "otherwiseOnTheLand": "Warehouses, light industry and municipal/road depots; the regional plan protects such land for productive activities.",
    },
    "proposalFr": (
        "PROJET HYPOTHÉTIQUE — avis de concertation préalable (exercice de simulation). Un opérateur propose de construire un campus "
        "de calcul pour l'intelligence artificielle dans la zone industrielle Rateau, à La Courneuve. Le site d'environ 8 hectares, "
        "aujourd'hui occupé par des entrepôts et ateliers, accueillerait trois bâtiments de 28 m de haut au maximum, pour une puissance "
        "électrique de 200 mégawatts. Le chantier durerait environ quatre ans, en trois phases, avec un poste électrique sur le site et "
        "deux lignes souterraines de 225 000 volts creusées sous la voirie jusqu'aux postes voisins. Le refroidissement fonctionnerait en "
        "circuit fermé (environ 5 000 m³ d'eau par an). Une centaine de groupes électrogènes de secours seraient testés chaque mois. "
        "L'opérateur s'engagerait à livrer jusqu'à 15 MW de chaleur au réseau de chauffage urbain, soit l'équivalent d'environ 5 000 "
        "logements. Il annonce environ 600 emplois au pic du chantier et 120 emplois permanents sur le site. Les recettes fiscales locales "
        "sont estimées entre 6 et 9 millions d'euros par an. Votre avis est sollicité."
    ),
    "proposalEn": (
        "HYPOTHETICAL PROJECT — notice of prior public consultation (simulation exercise). An operator proposes to build an artificial-"
        "intelligence computing campus in the Rateau industrial zone in La Courneuve. The site of about 8 hectares, now used by warehouses "
        "and workshops, would host three buildings up to 28 m high, drawing 200 megawatts of electricity. Construction would take about "
        "four years in three phases, with an on-site substation and two underground 225,000-volt lines dug under the streets to nearby "
        "substations. Cooling would run in a closed loop (about 5,000 m³ of water a year). Around a hundred backup generators would be "
        "tested every month. The operator would commit to supply up to 15 MW of heat to the district-heating network, roughly the "
        "needs of 5,000 homes. It announces about 600 jobs at the peak of construction and 120 permanent jobs on site. Local tax revenue "
        "is estimated at 6 to 9 million euros a year. Your opinion is invited."
    ),
}


def build_datacenter(offline: bool) -> dict:
    print("Data centre: checking the hypothetical site against OpenStreetMap ...")
    lon, lat = SITE["lon"], SITE["lat"]
    assert BBOX["lonMin"] <= lon <= BBOX["lonMax"] and BBOX["latMin"] <= lat <= BBOX["latMax"], "site outside map bbox"
    x, y = lonlat_to_xy(lon, lat)
    site = {**SITE, "x": round(x, 2), "y": round(y, 2)}
    osm_check = {"ran": False}
    lu = overpass(Q_LANDUSE, OSM_CACHE / "landuse_dc.json", offline)
    ctx = overpass(Q_SITE.format(lat=lat, lon=lon), OSM_CACHE / "site_context.json", offline)
    if lu:
        osm_check = check_site_osm(lu, ctx, lon, lat, offline)
        if osm_check.get("nearby"):  # replace the hand-typed distances by the recomputed ones
            site["osmEvidence"] = {**site["osmEvidence"], "nearby": osm_check["nearby"]}
    site["osmCheck"] = osm_check

    facts = {  # flat keys read by pipeline/scenarios.py
        "powerMW": HYPOTHETICAL["parameters"]["gridConnectionMW"]["value"],
        "areaHa": HYPOTHETICAL["parameters"]["siteAreaHa"]["value"],
        "constructionYears": HYPOTHETICAL["parameters"]["constructionYears"]["value"],
        "jobsConstruction": HYPOTHETICAL["parameters"]["constructionJobsPeak"]["value"],
        "jobsPermanent": HYPOTHETICAL["parameters"]["permanentJobsOnSite"]["value"],
        "heatMW": HYPOTHETICAL["parameters"]["heatRecoveryMWth"]["value"],
        "homesHeated": HYPOTHETICAL["parameters"]["homesHeated"]["value"],
        "generators": HYPOTHETICAL["parameters"]["backupGenerators"]["value"],
        "waterM3PerYear": HYPOTHETICAL["parameters"]["waterM3PerYear"]["value"],
        "annualElectricityGWh": HYPOTHETICAL["parameters"]["annualElectricityGWh"]["value"],
        "localTaxEurPerYear": HYPOTHETICAL["parameters"]["localTaxEurPerYear"]["value"],
    }
    return {
        "_about": ("Real, sourced context for a HYPOTHETICAL scenario: a large AI data-centre campus in Seine-Saint-Denis. "
                   "Everything under 'site', 'facts' and 'hypothetical' is invented for the simulation (plausible, based on the "
                   "cited comparables). Everything under 'context' and 'realProjects' is real and sourced."),
        "label": "HYPOTHETICAL SCENARIO — not a real project",
        "site": site,
        "facts": facts,
        "hypothetical": HYPOTHETICAL,
        "context": CONTEXT,
        "realProjects": REAL_PROJECTS,
        "participationProcedure": PROCEDURE,
        "typicalParameters": TYPICAL,
    }


def check_site_osm(lu: dict, ctx: dict | None, lon: float, lat: float, offline: bool) -> dict:
    """Confirm the site lies on OSM industrial land; count mapped data centres; distances to nearby features."""
    from shapely.geometry import Point, Polygon, shape

    mx = 111320 * math.cos(math.radians(lat))  # metres per degree of longitude here
    my = 110540  # metres per degree of latitude

    def dist_m(lon2, lat2):
        return math.hypot((lon2 - lon) * mx, (lat2 - lat) * my)

    containing = []
    dcs = []
    for e in lu.get("elements", []):
        t = e.get("tags", {})
        if e["type"] == "way" and "landuse" in t and e.get("geometry"):
            poly = Polygon([(p["lon"], p["lat"]) for p in e["geometry"]])
            if poly.is_valid and poly.contains(Point(lon, lat)):
                polym = Polygon([(p["lon"] * mx, p["lat"] * my) for p in e["geometry"]])
                containing.append({"osm": f"way/{e['id']}", "landuse": t["landuse"], "name": t.get("name", ""),
                                   "areaHa": round(polym.area / 1e4, 1)})
        elif t.get("telecom") == "data_center" or t.get("building") == "data_center":
            c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
            dcs.append((c["lon"], c["lat"], t.get("name", ""), t.get("operator", "")))

    # Count OSM-mapped data-centre objects per Seine-Saint-Denis commune (objects, not sites: may double count).
    per_commune = {}
    try:
        g = json.loads(http_get(DOWNLOADS["communes_93.geojson"], CACHE / "communes_93.geojson", offline).read_text(encoding="utf-8"))
        shapes = [(f["properties"]["nom"], shape(f["geometry"])) for f in g["features"]]
        for dlon, dlat, _, _ in dcs:
            for nom, shp in shapes:
                if shp.contains(Point(dlon, dlat)):
                    per_commune[nom] = per_commune.get(nom, 0) + 1
                    break
    except (SystemExit, Exception) as e:  # offline without cache, or network trouble: skip the count
        print(f"  (commune count skipped: {e})")
        per_commune = {}
    nearest_dc = sorted(((round(dist_m(a, b)), n, o) for a, b, n, o in dcs))[:3]

    feats = []
    for e in (ctx or {}).get("elements", []):
        t = e.get("tags", {})
        c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
        if c.get("lat") is None:
            continue
        kind = t.get("power") or t.get("amenity") or t.get("highway") or t.get("landuse")
        if kind not in ("substation", "school", "kindergarten", "childcare", "motorway", "construction"):
            continue  # e.g. 'driving_school' also matched the query's regex
        feats.append({"kind": kind, "name": t.get("name") or t.get("ref") or "", "operator": t.get("operator", ""),
                      "voltage": t.get("voltage", ""), "distanceM": round(dist_m(c["lon"], c["lat"]))})
    feats.sort(key=lambda r: r["distanceM"])

    def nearest(pred, label):
        for r in feats:
            if pred(r):
                name = f" '{r['name']}'" if r["name"] else ""
                op = f" ({r['operator']})" if r["operator"] else ""
                return {"what": f"{label}{name}{op}", "distanceM": int(round(r["distanceM"], -1))}
        return None

    nearby = [
        nearest(lambda r: r["kind"] == "motorway", "Motorway"),
        nearest(lambda r: r["kind"] == "school", "School"),
        nearest(lambda r: r["kind"] in ("kindergarten", "childcare"), "Nursery / crèche"),
        nearest(lambda r: r["kind"] == "construction", "Construction site"),
    ]
    rte = [r for r in feats if r["kind"] == "substation" and r["operator"] == "RTE"]
    for r in rte[:3]:
        nearby.append({"what": f"RTE substation '{r['name'] or 'unnamed'}' ({r['voltage'].replace(';', '/')} V)",
                       "distanceM": int(round(r["distanceM"], -1))})
    for d, n, o in nearest_dc[:1]:
        nearby.append({"what": f"Nearest mapped data centre '{n}' ({o})", "distanceM": int(round(d, -1))})
    nearby = [x for x in nearby if x]
    return {
        "ran": True,
        "insideIndustrialLand": any(c["landuse"] == "industrial" for c in containing),
        "containingPolygons": containing,
        "nearby": nearby,
        "osmDataCentreObjectsInBbox": len(dcs),
        "osmDataCentreObjectsBySeineSaintDenisCommune": dict(sorted(per_commune.items(), key=lambda kv: -kv[1])),
        "nearestMappedDataCentres": [{"distanceM": d, "name": n, "operator": o} for d, n, o in nearest_dc],
        "note": "OSM objects tagged telecom=data_center or building=data_center; several objects can belong to one campus.",
    }


CONTEXT = {
    "concentration": [
        {"fact": "Île-de-France hosts 44 % of the 322 data centres counted in France at 31 Dec 2024, and about 65-70 % of installed power.",
         "sources": dsrc("region2026"), "verified": True},
        {"fact": "Seine-Saint-Denis data centres consumed 0.8 TWh of electricity in 2024 — the highest of any French département "
                 "(Seine-et-Marne and Hauts-de-Seine 0.3 TWh each).",
         "caveat": "Enedis figure; very large sites connected directly to RTE may not be fully included.",
         "sources": dsrc("enedis2025"), "verified": True},
        {"fact": "The département counts 23 data centres in operation (July 2024).", "sources": dsrc("cd93_pdp"), "verified": True},
        {"fact": "Between 2000 and 2015 Plaine Commune received about fifteen large data centres (about one a year), then more than "
                 "half of all Île-de-France sites (quote of Saint-Denis mayor Mathieu Hanotin).",
         "sources": dsrc("cpr2022"), "verified": True},
        {"fact": "Operators with sites in Saint-Denis / Aubervilliers / La Courneuve include Equinix (PA2-PA10), Digital Realty "
                 "(ex-Interxion; PAR2-PAR9, Paris Digital Park), plus Orange, Atos, Completel, Bouygues Télécom technical sites "
                 "(OpenStreetMap; counts per commune are in site.osmCheck).",
         "sources": dsrc("osm"), "verified": True},
        {"fact": "Île-de-France has more than 170 data centres and 64 % of the national data-centre electricity use (4-6 TWh in 2023), "
                 "according to an MP's written question.",
         "sources": dsrc("an_q14126"), "verified": True},
    ],
    "concerns": [
        {"theme": "Electricity grid capacity and queues", "fact": "Grid connection is now the main limiting factor, with growing RTE "
         "queues; the Region warns that capacity taken by data centres can crowd out industry, mobility and housing projects and "
         "backs RTE's 2026 move from 'first come, first served' to 'first ready, first served'.", "sources": dsrc("region2026")},
        {"theme": "Electricity grid capacity and queues", "fact": "Researcher Cécile Diguet warns of congestion risks on the distribution "
         "network of La Plaine Saint-Denis.", "sources": dsrc("novethic")},
        {"theme": "Who pays for grid works", "fact": "Much of the reinforcement cost is shared by all consumers through the TURPE network "
         "tariff; the Region asks that data centres pay the full network costs they cause.", "sources": dsrc("region2026")},
        {"theme": "Land use", "fact": "Risk that data centres take scarce industrial land and, through new substations and lines, exert a "
         "'double land pressure'.", "sources": dsrc("region2026")},
        {"theme": "Heat island", "fact": "Most waste heat is released to the air; the environmental authority asked Dugny's developer to "
         "analyse the urban-heat-island effect.", "sources": dsrc("ae_dugny", "region2026")},
        {"theme": "Air pollution from backup generators", "fact": "Generators are tested at least 1 hour a month and in large groups once "
         "a year, emitting fine particles and NO2 (Region); Dugny would have 108 generators (814 MWth).", "sources": dsrc("region2026", "ae_dugny")},
        {"theme": "Noise", "fact": "Dugny site in 50-60 dB(A) Lden zone; Ae asked for better noise monitoring. Residents cite noise near homes.",
         "sources": dsrc("ae_dugny", "f3_dugny")},
        {"theme": "Water", "fact": "Water-based cooling is more energy-efficient but uses more water in heatwaves; most French sites use "
         "closed loops (government answer). Since May 2026 a permit can be refused where water resources are under structural stress.",
         "sources": dsrc("region2026", "an_q14126", "gossement_2026")},
        {"theme": "Few local jobs", "fact": "Opponents in Dugny call the 120-150 on-site jobs mostly low-skilled; Choose Paris Region gives "
         "about 12 jobs per 1,000 m² of building.", "sources": dsrc("f3_dugny", "cpr2022")},
        {"theme": "Safety and chemicals", "fact": "Le Bourget residents fear fire (lithium batteries, fuel), generators and ~300 kg of "
         "refrigerant containing 'forever chemicals' (PFAS).", "sources": dsrc("f3_bourget")},
        {"theme": "Cumulative effect", "fact": "Opponents count more than 200 backup generators across the large La Courneuve and Dugny sites.",
         "sources": dsrc("f3_bourget")},
    ],
    "benefits": [
        {"theme": "Local tax revenue", "fact": "Equinix PA8 (14 MW, 10,000 m², Pantin/Bobigny) generated €2.4 M of local taxes in 3 years "
         "(€1.4 M property tax, €870 k CFE, €130 k office tax). After 2022, about €2-3 M per year per €300 M of investment.",
         "caveat": "Promotional source (regional attractiveness agency).", "sources": dsrc("cpr2022")},
        {"theme": "Waste heat for district heating", "fact": "Equinix PA10 (Saint-Denis) recovers water at 28 °C and supplies up to "
         "6.6 MW of heat (about 10,800 MWh/yr) to the Plaine Commune Énergie / SMIREC network serving the ZAC Plaine Saulnier and the "
         "Olympic Aquatics Centre; heat given free for 15 years; €4.3 M project with a 2,610 m network extension; commissioned June 2024.",
         "caveat": "MW/MWh/€ figures from ENGIE press releases read via secondary summaries (PDF blocked from our machine); network "
         "extension length confirmed on the Region's page.", "sources": dsrc("engie_2024", "engie_2022", "idf_equinix_heat"), "verified": "partial"},
        {"theme": "Waste heat for district heating", "fact": "The Region co-funded three data-centre heat-recovery projects, heating among "
         "others the Olympic Aquatics Centre in Saint-Denis and residential/office districts in Saint-Denis and La Courneuve.",
         "sources": dsrc("region2026"), "verified": True},
        {"theme": "Waste heat (limits)", "fact": "At Dugny about 100 MWth of heat is recoverable but only ~9,140 MWh/yr (~1 %) was planned "
         "for the local network in the first ten years; at Le Bourget 12 MW of 75 MW, October-April only.",
         "sources": dsrc("ae_dugny", "mrae_bourget"), "verified": True},
        {"theme": "Conditions imposed locally", "fact": "Plaine Commune asks developers for a local-hiring 'Charte Grand Chantier', a grid "
         "diagnosis with the network operator, connection to the district-heating network at the operator's cost and more greenery.",
         "sources": dsrc("cpr2022"), "verified": True},
        {"theme": "Sovereignty / AI", "fact": "The Region frames well-regulated data centres as a lever for digital sovereignty, attractiveness "
         "and decarbonisation (heat).", "sources": dsrc("region2026")},
    ],
}

REAL_PROJECTS = [
    {"name": "Paris Digital Park (Digital Realty)", "commune": "La Courneuve", "status": "operating",
     "facts": {"powerMW": "about 130", "serverHallsM2": 40000, "investmentEur": 1150000000,
               "staff": "80-90 operator/sub-contractor staff plus about 300 client staff",
               "heat": "Heat offered free, no network connection yet in July 2024 (talks with SMIREC)",
               "formerUse": "Former Eurocopter factory site"},
     "sources": dsrc("cd93_pdp")},
    {"name": "Equinix PA10", "commune": "Saint-Denis", "status": "operating; heat recovery since June 2024",
     "facts": {"heatMW": 6.6, "heatMWhPerYear": 10800, "recipients": "ZAC Plaine Saulnier, Olympic Aquatics Centre"},
     "sources": dsrc("engie_2024", "idf_equinix_heat")},
    {"name": "Dugny Digital Hub (Digital Realty, PAR15-17)", "commune": "Dugny", "status": "under construction (works planned late 2024 - early 2030)",
     "facts": {"buildings": 3, "footprintM2": 41500, "siteHa": 9.5, "formerUse": "former military land next to Le Bourget airport",
               "generators": 108, "generatorsMWth": 814, "batteriesMW": 283, "electricityGWhFullLoad": 1930,
               "dugnyCommuneGWh2019": 161, "recoverableHeatMWth": 100, "plannedHeatMWhPerYear": 9140,
               "waterM3PerYear": 5090, "peoplePerDayOnSite": 110, "indirectJobsClaimed": 450, "pueTarget": 1.3,
               "gridConnection": "two 225 kV underground lines, 28 km in total, to Villiers-le-Bel and Le Plessis-Gassot",
               "powerMW": 200, "investmentEur": "about 2 billion", "distanceToHomes": "about 100 m (homes and a crèche)"},
     "sources": dsrc("ae_dugny", "f3_dugny")},
    {"name": "Le Bourget data centre (Segro)", "commune": "Le Bourget", "status": "contested: permit withdrawn 12 Jun 2026, withdrawal upheld by Montreuil administrative court (référé) 28 Jul 2026",
     "facts": {"siteHa": 3.7, "floorAreaM2": 25300, "connectionMW": 75, "electricityGWhPerYear": 526,
               "communeGWh2019": 236, "pue": "1.35 average, max 1.5", "generators": 33, "heatRecoveryMW": 12,
               "heatSeason": "October-April", "formerUse": "former H&M logistics site (industrial brownfield)",
               "petition": "more than 18,000 signatures (town of ~16,000 inhabitants)",
               "timeline": ["MRAe opinion 30 Jun 2025", "petition from late Oct 2025", "permit granted 13 Mar 2026 (two days before the municipal first round)",
                            "new mayor Mehdi Nezzar withdrew it 12 Jun 2026", "administrative court upheld the withdrawal 28 Jul 2026 (height rules)"]},
     "sources": dsrc("mrae_bourget", "f3_bourget", "hellowatt_bourget", "bdt_bourget")},
    {"name": "Brétigny-sur-Orge project (Essonne)", "commune": "Brétigny-sur-Orge (outside the map)", "status": "refused by the regional prefect",
     "facts": {"reason": "No recovery of waste heat"}, "sources": dsrc("an_q14126")},
]

PROCEDURE = {
    "summary": ("A large data-centre campus in France typically goes through: (1) possible CNDP public debate or prior consultation, "
                "(2) an environmental assessment with an opinion of the environmental authority (Ae/IGEDD or MRAe), "
                "(3) an environmental authorisation (classified installation: generators, refrigerants) with a public "
                "consultation run by a commissaire enquêteur, (4) a building permit, and in Île-de-France (5) a prior State approval "
                "for large business premises (urban-planning code L.510-1)."),
    "steps": [
        {"step": "CNDP (Commission nationale du débat public)", "detail": (
            "Industrial facilities whose buildings and infrastructure cost more than €300 M must be referred to the CNDP, which decides "
            "between a public debate (3-6 months) and a prior consultation with a guarantor; €150-300 M: publicity and optional "
            "referral (Code de l'environnement R.121-2 thresholds as described in parliamentary answers). Equipment (e.g. servers) does "
            "not count towards the cost. 2025-2026 simplification laws targeted the CNDP's scope — check the current text on Légifrance."),
         "verified": "partial"},
        {"step": "Environmental authority opinion", "detail": "Ae (IGEDD) for Dugny (2024-08), MRAe Île-de-France for Le Bourget (APJIF-2025-056). "
         "Not for or against the project; the developer must answer it in writing before the public consultation.",
         "sources": dsrc("ae_dugny", "mrae_bourget"), "verified": True},
        {"step": "Environmental authorisation and public consultation", "detail": (
            "Since the 'industrie verte' law (no. 2023-973, 23 Oct 2023) and decree no. 2024-742 (6 Jul 2024), the public consultation "
            "for an environmental authorisation runs in parallel with the review (Code de l'environnement L.181-10-1), led by a "
            "commissaire enquêteur. Le Bourget: inquiry Oct-Nov 2025 then a supplementary consultation until Jan 2026 (press)."),
         "verified": "partial"},
        {"step": "Building permit and PINM", "detail": (
            "Since law no. 2026-403 of 26 May 2026 (art. 35), a data centre can be declared a 'projet d'intérêt national majeur' by "
            "decree: the prefect then issues the building permit and local height rules can be set aside; a permit can be refused "
            "for water stress; the energy minister can ask RTE to reserve grid capacity."),
         "sources": dsrc("gossement_2026"), "verified": "partial (law-firm commentary)"},
        {"step": "Regional planning rule", "detail": "SDRIF-E (approved 10 Jun 2025) OR 126: data centres first on existing business sites, "
         "limit environmental impacts, account for local grid capacity, recover waste heat, fit into the urban landscape.",
         "sources": dsrc("region2026"), "verified": True},
    ],
}

TYPICAL = {
    "note": "Ranges from real Île-de-France projects (sources in realProjects).",
    "gridConnectionMW": "75 (Le Bourget) - 200 (Dugny)",
    "siteHa": "3.7 - 9.5",
    "buildingFootprintM2": "≈25,000 - 41,500",
    "annualElectricityGWh": "526 (Le Bourget, 75 MW) - 1,930 at full load (Dugny, 200 MW)",
    "pue": "1.3 - 1.35 targets (French average 1.57 in 2022, Uptime Institute via MRAe)",
    "backupGenerators": "33 (75 MW) - 108 (200 MW)",
    "waterM3PerYear": "≈5,000 with closed-loop cooling (Dugny)",
    "permanentJobs": "≈80-150 on site; operators claim more indirect jobs",
    "constructionDuration": "phased over 4-6 years (Dugny: late 2024 - early 2030)",
    "heatRecovered": "1 % (Dugny, first 10 years) - 16 % (Le Bourget, winter only) of the heat; PA10 up to 6.6 MW",
}


# ---------------------------------------------------------------------------
# 7. Leakage notes (model training cutoffs vs vote dates)
# ---------------------------------------------------------------------------

MODELS = [
    {"family": "Nemotron 3 Nano", "hfId": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
     "tokenFactoryIdInConfig": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "role": "reactions",
     "pretrainingCutoff": "2025-06-25", "postTrainingCutoff": "2025-11-28", "released": "2025-12-15",
     "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
     "quote": "The pre-training data has a cutoff date of June 25, 2025. The post-training data has a cutoff date of November 28, 2025."},
    {"family": "Nemotron 3 Super", "hfId": "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
     "tokenFactoryIdInConfig": "nvidia/nemotron-3-super-120b-a12b", "role": "conversations",
     "pretrainingCutoff": "2025-06", "postTrainingCutoff": "2026-02", "released": "2026-03-11",
     "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16",
     "quote": "The pre-training data has a cutoff date of June 2025. The post-training data has a cutoff date of February 2026."},
    {"family": "Nemotron 3 Ultra", "hfId": "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16",
     "tokenFactoryIdInConfig": "nvidia/Nemotron-3-Ultra-550b-a55b", "role": "synthesis",
     "pretrainingCutoff": "2025-09", "postTrainingCutoff": "2026-05", "released": "2026-06-04",
     "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16",
     "quote": "The pre-training data has a cutoff date of September 2025. The post-training data has a cutoff date of May 2026."},
]


def _month_end(d: str) -> str:
    """'2025-06' -> '2025-06-30' (a cutoff given as a month is treated as the end of that month)."""
    if len(d) == 10:
        return d
    y, m = map(int, d.split("-"))
    nxt = datetime(y + (m == 12), m % 12 + 1, 1)
    return (nxt.fromordinal(nxt.toordinal() - 1)).strftime("%Y-%m-%d")


def build_leakage() -> dict:
    votes = [("paris_scooters_2023", "2023-04-02"), ("paris_suv_2024", "2024-02-04"), ("paris_streets_2025", "2025-03-23")]
    per_vote = {}
    for vid, date in votes:
        per_vote[vid] = {"date": date, "models": {}}
        for m in MODELS:
            pre = _month_end(m["pretrainingCutoff"])
            post = _month_end(m["postTrainingCutoff"])
            per_vote[vid]["models"][m["family"]] = {
                "beforePretrainingCutoff": date <= pre, "beforePostTrainingCutoff": date <= post,
                "verdict": "in-sample (the model may have read the result)" if date <= pre else "out-of-sample for pre-training"}
        per_vote[vid]["summary"] = ("All three Nemotron 3 models were pre-trained on data up to at least June 2025, after this vote: "
                                    "treat the backtest as possibly contaminated and run the leakage probe.")
    return {
        "_about": "Training-data cutoffs of the Nemotron 3 models (official Hugging Face model cards) compared with the vote dates.",
        "checkedOn": "2026-10-26",
        "models": MODELS,
        "modelIdNote": ("Token Factory model IDs in web/shared/config.json come from a third-party listing; confirm with GET /v1/models "
                        "once the API key exists. Cutoffs are from the matching Hugging Face BF16 model cards."),
        "votes": per_vote,
        "conclusion": ("Every backtest vote (2023, 2024 and the optional 2025 vote) predates all three pre-training cutoffs, so a good "
                       "backtest score could partly reflect memorised results. A leakage probe (ask the bare model the result, "
                       "directly and disguised) must be run and shown next to the backtest."),
        "probePrompts": {
            "paris_streets_2025": {
                "direct": ("What was the official result of the Paris 'votation' held on 23 March 2025 on greening and pedestrianising "
                           "500 more streets? What share of valid votes was 'Pour', and what was the turnout?"),
                "disguised": ("Imagine Paris asks registered voters (aged 16+), in a Sunday vote with no other election, 'Pour ou contre "
                              "végétaliser et rendre piétonnes 500 nouvelles rues dans Paris, réparties dans tous les quartiers ?'. "
                              "Estimate the 'Pour' share among valid votes and the turnout."),
                "actual": {"yesShare": 0.6596, "turnout": 0.0406},
            },
            "note": "Prompts for the 2023 and 2024 votes live in pipeline/leakage_probe.py (owned by another engineer).",
        },
        "outOfSampleCandidates": [
            {"what": "Paris municipal elections, 15 and 22 March 2026 (results by arrondissement on paris.fr)",
             "date": "2026-03-22",
             "outOfSampleFor": ["Nemotron 3 Nano (pre- and post-training)", "Nemotron 3 Super (pre- and post-training)",
                                "Nemotron 3 Ultra pre-training only (its post-training data runs to May 2026)"],
             "comparability": ("Low-medium: a candidate election, not a yes/no measure. It can test the sim's political geography "
                               "(e.g. does simulated support for 'green streets' measures track the left-list vote by sector?)."),
             "reported": "Emmanuel Grégoire (left union) elected mayor; reported 50.52 % in the second round (press; not checked against official files).",
             "sources": [{"name": "paris.fr — Élections municipales 2026: tous les résultats en cartes",
                          "url": "https://www.paris.fr/pages/elections-municipales-2026-tous-les-resultats-en-cartes-34272"},
                         {"name": "Public Sénat — Emmanuel Grégoire élu maire de Paris",
                          "url": "https://www.publicsenat.fr/actualites/politique/municipales-2026-a-paris-emmanuel-gregoire-elu-largement-face-a-rachida-dati-selon-nos-estimations"}],
             "verified": "partial"},
            {"what": "Le Bourget data-centre controversy (petition, public inquiry, permit withdrawn)",
             "date": "2025-10 to 2026-07",
             "outOfSampleFor": ["Nemotron 3 Nano and Super pre-training (both end June 2025)"],
             "comparability": ("Qualitative only (no vote): checks whether simulated objections to the hypothetical data centre "
                               "match the arguments real residents raised after the cutoff — fire/battery risk, generators and air "
                               "pollution, noise, heat island, grid use, PFAS refrigerant, few jobs."),
             "sources": dsrc("f3_bourget", "bdt_bourget"), "verified": True},
            {"what": "Paris votations after June 2025", "date": None,
             "result": "None found (searches on 2026-10-26). The 23 March 2025 votation is the latest; it is in-sample.",
             "verified": True},
            {"what": "Paris issue polls after June 2025",
             "result": ("Pre-election polls (e.g. Elabe for BFMTV / La Tribune Dimanche, 2-9 Jan 2026, n=1,100) rank priorities "
                        "but ask no yes/no question comparable to our backtests."),
             "sources": [{"name": "Elabe — Municipales 2026 Paris (Jan 2026, PDF)",
                          "url": "https://elabe.fr/wp-content/uploads/2026/01/10012026_elabe_bfmtv_la-tribune-dimanche_municipales-2026-paris.pdf"}],
             "verified": True},
        ],
    }


# ---------------------------------------------------------------------------
# 8. Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="use cached downloads only (no network)")
    args = ap.parse_args()

    vot = build_votations(args.offline)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    vot_file = {
        "_about": {
            "what": "Official results of Paris votations used as backtests, with question wording, rules, eligibility and polls.",
            "generatedAt": now, "generatedBy": "pipeline/fetch_ground_truth.py",
            "shares": "yesShare / noShare are shares of EXPRESSED votes (Pour+Contre), as published by the City.",
            "turnout": "turnout = voters (votants) / registered (inscrits).",
            "sectors": "17 votation sectors: 'Paris Centre' (1er-4e merged) and '5e'..'20e'. districtCodes = INSEE codes.",
            "license": "Ville de Paris open data (opendata.paris.fr); figures re-published with attribution.",
            "disclaimer": "Simulation outputs compared with these numbers are hypotheses, not evidence of public opinion.",
        },
        **vot,
    }
    write_json(GROUND_TRUTH / "votations.json", vot_file, compact=False)

    dc = build_datacenter(args.offline)
    dc["generatedAt"] = now
    write_json(GROUND_TRUTH / "datacenter_context.json", dc, compact=False)

    leak = build_leakage()
    leak["generatedAt"] = now
    write_json(GROUND_TRUTH / "leakage_notes.json", leak, compact=False)

    # Short console report.
    ok = True
    for vid, v in vot.items():
        bad = [c for c in v["checks"] if not c["ok"]]
        ok &= not bad
        r = v["result"]
        print(f"{vid}: Pour {r['yesShare'] * 100:.2f} %  turnout {r['turnout'] * 100:.2f} %  "
              f"checks {len(v['checks']) - len(bad)}/{len(v['checks'])} ok" + (f"  FAILED: {[c['check'] for c in bad]}" if bad else ""))
    oc = dc["site"]["osmCheck"]
    if oc.get("ran"):
        print(f"datacenter site: inside industrial land = {oc['insideIndustrialLand']}  "
              f"({', '.join(p['name'] or p['osm'] for p in oc['containingPolygons'])}); "
              f"mapped DC objects in bbox = {oc['osmDataCentreObjectsInBbox']}")
        ok &= oc["insideIndustrialLand"]
    else:
        print("datacenter site: OSM check skipped (no cache and offline / Overpass unavailable)")
    print(f"wrote {GROUND_TRUTH / 'votations.json'}, datacenter_context.json, leakage_notes.json")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
