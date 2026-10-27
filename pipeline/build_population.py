"""Build the synthetic population of Town-in-a-Box (~2,000 residents of Paris + inner suburbs).

Run:   pipeline/.venv/Scripts/python.exe pipeline/build_population.py
Output:
  pipeline/out/population_full.json   everything (long dataset texts, weights, INSEE targets) for the simulation engine
  pipeline/out/population_report.md   before/after marginals vs INSEE, imputation checks
  web/public/data/population.json     slim PopulationFile for the web app (written by place_residents.py)

The steps, in order (one function each):
  1. fetch_personas()          NVIDIA Nemotron-Personas-France rows for the 4 departements (cached parquet)
  2. load_districts()          study-area districts: 20 Paris arrondissements + suburban communes touching the bbox
  3. load_insee()              INSEE census 2022 marginals per district (IRIS files summed to commune/arrondissement)
  4. assign_arrondissements()  give an arrondissement to Paris rows that only say "Paris" (jointly with occupation/age/education)
  5. sample_district()         raking (IPF) to INSEE marginals, weighted sampling without replacement, residual weights
  6. impute_*()                nationality, tenure, car, heavy car, registration, workplace, commute (all IMPUTED, district-calibrated)
  7. participation_base()      empirical turnout propensity from INSEE gradients (no LLM)
  8. names / groups / look     presentation fields
Everything is seeded, so the same inputs always give the same population.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
import sys
import time
import unicodedata
import zipfile
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd
from shapely.geometry import box, shape

from common import BBOX, OUT, PERSONA_PARQUET_URLS, RAW, write_json

SEED = 20261026
N_PARIS = 1400
N_SUBURBS = 600

PERSONA_DIR = RAW / "personas"
PERSONA_CACHE = PERSONA_DIR / "idf.parquet"
INSEE_DIR = RAW / "insee"
INSEE_CACHE = INSEE_DIR / "idf_insee_2022_by_district.csv"
FULL_OUT = OUT / "population_full.json"
REPORT_OUT = OUT / "population_report.md"

DEPT_NAMES = {"75": "Paris", "92": "Hauts-de-Seine", "93": "Seine-Saint-Denis", "94": "Val-de-Marne"}
PERSONA_COLUMNS = (
    "uuid, sex, age, marital_status, household_type, education_level, occupation, "
    "commune, departement, country, persona, professional_persona, cultural_background"
)

# Communes around the hypothetical data-centre site (Rateau industrial zone, La Courneuve, north of
# Paris) get a sampling boost so the scenario has enough simulated neighbours to click on. The host
# town and its direct neighbours are boosted most. The design weight undoes every boost in aggregates.
FOCUS_BOOSTS = {
    "93027": 7.0,  # La Courneuve (host town)
    "93013": 5.0,  # Le Bourget
    "93029": 3.5,  # Drancy
    "93030": 3.0,  # Dugny
    "93008": 2.5,  # Bobigny
    "93001": 2.5,  # Aubervilliers
    "93066": 2.5,  # Saint-Denis
    "93070": 2.5,  # Saint-Ouen-sur-Seine
    "93039": 2.5,  # L'Ile-Saint-Denis
    "93072": 2.5,  # Stains
    "93079": 2.5,  # Villetaneuse
    "93031": 2.5,  # Epinay-sur-Seine
    "93055": 2.5,  # Pantin
}
FOCUS_COMMUNES = set(FOCUS_BOOSTS)

# Communes merged after the INSEE 2022 geography (1 Jan 2025: Pierrefitte-sur-Seine joined Saint-Denis).
COMMUNE_MERGES = {"93059": "93066"}

# ----------------------------------------------------------------------------------------------
# Labels and codes
# ----------------------------------------------------------------------------------------------
OCC = {  # raw dataset label -> (group id, English label, INSEE census column suffix)
    "Agriculteurs exploitants": ("agriculteurs", "Farmer", "GSEC11_21"),
    "Artisans, commerçants, chefs d'entreprise": ("artisans", "Craftsperson, shopkeeper or business owner", "GSEC12_22"),
    "Cadres et professions intellectuelles supérieures": ("cadres", "Manager or professional", "GSEC13_23"),
    "Professions intermédiaires": ("prof_inter", "Intermediate profession (technician, teacher, nurse...)", "GSEC14_24"),
    "Employés": ("employes", "Clerical or service employee", "GSEC15_25"),
    "Ouvriers": ("ouvriers", "Manual worker", "GSEC16_26"),
    "Retraités": ("retraites", "Retired", "GSEC32"),
    "Autres sans activité professionnelle": ("sans_activite", "Not in work (student, homemaker, other)", "GSEC40"),
}
OCC_LABELS = list(OCC.keys())
OCC_GROUPS = [OCC[k][0] for k in OCC_LABELS]

EDU_LABELS = ["Sans diplôme ou CEP", "Brevet", "CAP ou BEP", "Baccalauréat", "Bac+2", "Bac+3 ou Bac+4", "Bac+5 ou plus"]
EDU_INSEE = ["DIPLMIN", "BEPC", "CAPBEP", "BAC", "SUP2", "SUP34", "SUP5"]

AGE_BANDS = ["18-29", "30-44", "45-59", "60-74", "75+"]

HOUSEHOLD = {
    "Personne seule": "single",
    "Couple sans enfant": "couple_no_kids",
    "Couple avec enfant(s)": "couple_kids",
    "Famille monoparentale": "single_parent",
}


def age_band(age: int) -> str:
    if age < 30:
        return "18-29"
    if age < 45:
        return "30-44"
    if age < 60:
        return "45-59"
    if age < 75:
        return "60-74"
    return "75+"


def norm_name(s: str) -> str:
    """Normalise a commune name for matching ('L'Haÿ-les-Roses' -> 'l hay les roses')."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def stable_hash(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:15], 16)


# ----------------------------------------------------------------------------------------------
# 1. Persona rows
# ----------------------------------------------------------------------------------------------
def fetch_personas(force: bool = False) -> None:
    """Download all rows of the 4 departements once (DuckDB over the 12 HF parquet shards)."""
    if PERSONA_CACHE.exists() and not force:
        print(f"[fetch] using cache {PERSONA_CACHE.relative_to(RAW.parent.parent.parent)}")
        return
    PERSONA_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("LOAD httpfs")
    dept_list = ", ".join(f"'{d}'" for d in DEPT_NAMES.values())
    parts = []
    for i, url in enumerate(PERSONA_PARQUET_URLS):
        t = time.time()
        part = PERSONA_DIR / f"part_{i:02d}.parquet"
        if not part.exists():
            con.execute(
                f"COPY (SELECT {PERSONA_COLUMNS} FROM read_parquet('{url}') WHERE departement IN ({dept_list})) "
                f"TO '{part.as_posix()}' (FORMAT parquet)"
            )
        print(f"[fetch] shard {i}: {time.time() - t:.0f}s", flush=True)
        parts.append(part)
    files = ", ".join(f"'{p.as_posix()}'" for p in parts)
    con.execute(f"COPY (SELECT * FROM read_parquet([{files}])) TO '{PERSONA_CACHE.as_posix()}' (FORMAT parquet)")
    for p in parts:
        p.unlink()


def load_personas() -> pd.DataFrame:
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{PERSONA_CACHE.as_posix()}') ORDER BY uuid").df()
    for c in df.columns:
        if c != "age":
            df[c] = df[c].astype(object)
    return df


# ----------------------------------------------------------------------------------------------
# 2. Study-area districts (geo.api.gouv.fr)
# ----------------------------------------------------------------------------------------------
GEO_SOURCES = {
    "75": "https://geo.api.gouv.fr/communes?codeDepartement=75&type=arrondissement-municipal&fields=nom,code,population,centre,contour&format=json&geometry=contour",
    "92": "https://geo.api.gouv.fr/departements/92/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour",
    "93": "https://geo.api.gouv.fr/departements/93/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour",
    "94": "https://geo.api.gouv.fr/departements/94/communes?fields=nom,code,population,centre,contour&format=json&geometry=contour",
}


def geo_file(dept: str):
    name = "geo_arrondissements_75.json" if dept == "75" else f"geo_communes_{dept}.json"
    return INSEE_DIR / name


def load_districts() -> pd.DataFrame:
    """All Paris arrondissements + every 92/93/94 commune whose outline intersects the bbox."""
    import httpx

    bb = box(BBOX["lonMin"], BBOX["latMin"], BBOX["lonMax"], BBOX["latMax"])
    rows = []
    for dept, url in GEO_SOURCES.items():
        path = geo_file(dept)
        if not path.exists():
            path.write_bytes(httpx.get(url, timeout=60).content)
        for c in json.loads(path.read_text(encoding="utf-8")):
            geom = shape(c["contour"])
            inside = geom.intersection(bb).area / geom.area if geom.area > 0 else 0.0
            if inside <= 0:
                continue
            is_arr = dept == "75"
            short = c["nom"].replace("Paris ", "").replace(" Arrondissement", "") if is_arr else c["nom"]
            rows.append(
                {
                    "code": c["code"],
                    "dept": dept,
                    "kind": "arrondissement" if is_arr else "commune",
                    "name": short,
                    "fullName": c["nom"],
                    "population": int(c.get("population") or 0),
                    "lon": c["centre"]["coordinates"][0],
                    "lat": c["centre"]["coordinates"][1],
                    "insideFrac": round(inside, 4),
                }
            )
    d = pd.DataFrame(rows).sort_values(["dept", "code"]).reset_index(drop=True)
    return d


# ----------------------------------------------------------------------------------------------
# 3. INSEE census 2022 marginals
# ----------------------------------------------------------------------------------------------
INSEE_FILES = {
    "pop": ("8647014", "base-ic-evol-struct-pop-2022_csv.zip", "Population en 2022 (RP, base infracommunale IRIS)"),
    "dipl": ("8647010", "base-ic-diplomes-formation-2022_csv.zip", "Diplômes - Formation en 2022 (RP, IRIS)"),
    "log": ("8647012", "base-ic-logement-2022_csv.zip", "Logement en 2022 (RP, IRIS)"),
    "act": ("8647006", "base-ic-activite-residents-2022_csv.zip", "Activité des résidents en 2022 (RP, IRIS)"),
    "fam": ("8647008", "base-ic-couples-familles-menages-2022_csv.zip", "Couples - Familles - Ménages en 2022 (RP, IRIS)"),
}


def insee_url(key: str) -> str:
    page, fname, _ = INSEE_FILES[key]
    return f"https://www.insee.fr/fr/statistiques/fichier/{page}/{fname}"


def _read_iris_zip(key: str) -> pd.DataFrame:
    """Read one INSEE IRIS CSV from its zip, keep departements 75/92/93/94, sum IRIS rows per commune code."""
    import httpx

    path = INSEE_DIR / INSEE_FILES[key][1]
    if not path.exists():
        path.write_bytes(httpx.get(insee_url(key), timeout=300, headers={"User-Agent": "Mozilla/5.0"}).content)
    zf = zipfile.ZipFile(path)
    name = [n for n in zf.namelist() if not n.lower().startswith("meta")][0]
    with zf.open(name) as f:
        df = pd.read_csv(io.TextIOWrapper(f, encoding="utf-8"), sep=";", dtype={"IRIS": str, "COM": str}, low_memory=False)
    df = df[df["COM"].str[:2].isin(["75", "92", "93", "94"])].copy()
    df["COM"] = df["COM"].replace(COMMUNE_MERGES)
    num = [c for c in df.columns if c.startswith(("P22_", "C22_"))]
    df[num] = df[num].apply(pd.to_numeric, errors="coerce").fillna(0.0)
    return df.groupby("COM")[num].sum()


def load_insee() -> pd.DataFrame:
    """One row per district code with the census variables we need (cached as a small CSV)."""
    if INSEE_CACHE.exists():
        return pd.read_csv(INSEE_CACHE, dtype={"COM": str}).set_index("COM")
    parts = {k: _read_iris_zip(k) for k in INSEE_FILES}
    pop, dipl, log, act, fam = (parts[k] for k in ("pop", "dipl", "log", "act", "fam"))
    out = pd.DataFrame(index=pop.index)
    out["pop"] = pop["P22_POP"]
    out["pop18p"] = dipl["P22_POP1824"] + dipl["P22_POP2529"] + dipl["P22_POP30P"]
    out["pop1517"] = dipl["P22_POP1517"]
    # age x sex (18-29 from 15-29 scaled by the 18-29 / 15-29 ratio, which is only available for both sexes)
    r1829 = (dipl["P22_POP1824"] + dipl["P22_POP2529"]) / pop["P22_POP1529"].where(pop["P22_POP1529"] > 0, 1)
    for s, pre in (("M", "P22_H"), ("F", "P22_F")):
        out[f"age_{s}_18-29"] = pop[f"{pre}1529"] * r1829
        out[f"age_{s}_30-44"] = pop[f"{pre}3044"]
        out[f"age_{s}_45-59"] = pop[f"{pre}4559"]
        out[f"age_{s}_60-74"] = pop[f"{pre}6074"]
        out[f"age_{s}_75+"] = pop[f"{pre}75P"]
    # occupation x sex, population 15+ (PCS 2020 groups); 15-17 year olds are removed from "Autres sans activité"
    for s, pre in (("M", "C22_H15P_STAT_"), ("F", "C22_F15P_STAT_")):
        for lab in OCC_LABELS:
            g, _, suf = OCC[lab]
            v = pop[pre + suf]
            if g == "sans_activite":
                v = (v - dipl["P22_POP1517"] / 2).clip(lower=0)
            out[f"occ_{s}_{g}"] = v
    # education of people 15+ not in education
    for lab, suf in zip(EDU_LABELS, EDU_INSEE):
        out[f"edu_{suf}"] = dipl[f"P22_NSCOL15P_{suf}"]
    # tenure (persons living in main residences, by tenure of the dwelling)
    nper = log["P22_NPER_RP"].where(log["P22_NPER_RP"] > 0, 1)
    out["owner_share"] = log["P22_NPER_RP_PROP"] / nper
    out["social_share"] = log["P22_NPER_RP_LOCHLMV"] / nper
    out["private_share"] = 1 - out["owner_share"] - out["social_share"]
    # cars: share of households with at least one car
    out["car_share"] = log["P22_RP_VOIT1P"] / log["P22_RP"].where(log["P22_RP"] > 0, 1)
    # foreign nationals (all ages)
    out["foreign_share"] = pop["P22_POP_ETR"] / pop["P22_POP"].where(pop["P22_POP"] > 0, 1)
    # employed people: works in the commune of residence (Paris = the whole city), commute mode shares
    actocc = act["P22_ACTOCC15P"].where(act["P22_ACTOCC15P"] > 0, 1)
    out["work_in_commune"] = act["P22_ACTOCC15P_ILT1"] / actocc
    modes = {"walk": "MAR", "bike": "VELO", "car": "VOIT", "tcom": "TCOM", "moto": "2ROUESMOT", "none": "PAS"}
    for k, suf in modes.items():
        out[f"mode_{k}"] = act[f"C22_ACTOCC15P_{suf}"]
    # households by type (persons in households) — reported only
    out["hh_single"] = fam["C22_PMEN_MENPSEUL"]
    out["hh_couple_no_kids"] = fam["C22_PMEN_MENCOUPSENF"]
    out["hh_couple_kids"] = fam["C22_PMEN_MENCOUPAENF"]
    out["hh_single_parent"] = fam["C22_PMEN_MENFAMMONO"]
    out.index.name = "COM"
    out.reset_index().to_csv(INSEE_CACHE, index=False)
    return out


def insee_targets(ins: pd.Series) -> dict:
    """Turn one district's census row into target share vectors used by raking and imputation."""
    sexocc = np.array([ins[f"occ_{s}_{g}"] for s in ("M", "F") for g in OCC_GROUPS], dtype=float)
    sexage = np.array([ins[f"age_{s}_{b}"] for s in ("M", "F") for b in AGE_BANDS], dtype=float)
    edu = np.array([ins[f"edu_{s}"] for s in EDU_INSEE], dtype=float)
    return {
        "sexocc": sexocc / sexocc.sum(),
        "sexage": sexage / sexage.sum(),
        "edu": edu / edu.sum(),
        "occ": (sexocc[:8] + sexocc[8:]) / sexocc.sum(),
        "age": (sexage[:5] + sexage[5:]) / sexage.sum(),
    }


# ----------------------------------------------------------------------------------------------
# 4. Arrondissement for Paris rows that only say "Paris"
# ----------------------------------------------------------------------------------------------
# High-precision pattern: "du 18e", "dans le 15ᵉ", "Paris 11e", "18e arrondissement". Plain "2e" (e.g. "2e enfant") is ignored.
ARR_PATTERN = re.compile(
    r"(?:(?:\bdu|\bdans le|\bau|\ble|\bParis|\ben plein)\s+(1er|[1-9]|1[0-9]|20)(?:e|ème|eme|ᵉ|er)\b(?!\s+(?:enfant|étage|fois|année|degré|siècle|rang|place|âge))"
    r"|\b(1er|[1-9]|1[0-9]|20)(?:e|ème|eme|ᵉ|er)\s+arrondissement)",
    re.IGNORECASE,
)


def arrondissement_mentions(text: str) -> set[str]:
    """Arrondissement codes mentioned in a persona text ('du 18e' -> {'75118'})."""
    found = set()
    for m in ARR_PATTERN.finditer(text or ""):
        num = (m.group(1) or m.group(2) or "").lower().replace("er", "")
        if num.isdigit() and 1 <= int(num) <= 20:
            found.add(f"751{int(num):02d}")
    return found


# Text mentions are NOT used as evidence when assigning an arrondissement: on rows that only say "Paris", the
# generator invented one (about half of those mentions are the 12e), so they say nothing about where people live.
# They are used later only as a soft preference in sampling, so a resident's own text rarely contradicts their home.
CONTRADICTION_PENALTY = 0.05


def assign_arrondissements(df: pd.DataFrame, insee: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Give each 'Paris' row an arrondissement drawn from
        P(arr | occupation, age band, education) ∝ P(arr) · P(occ|arr) · P(age|arr) · P(edu|arr)
    with INSEE census shares (naive-Bayes style product: the three attributes are treated as independent
    within an arrondissement). Never uniform at random. Seeded RNG.
    """
    arr_codes = [f"751{i:02d}" for i in range(1, 21)]
    prior = np.array([insee.loc[c, "pop18p"] for c in arr_codes])
    prior = prior / prior.sum()
    t = {c: insee_targets(insee.loc[c]) for c in arr_codes}
    p_occ = np.array([t[c]["occ"] for c in arr_codes])  # 20 x 8
    p_age = np.array([t[c]["age"] for c in arr_codes])  # 20 x 5
    p_edu = np.array([t[c]["edu"] for c in arr_codes])  # 20 x 7

    mask = (df["departement"] == "Paris") & (df["commune"] == "Paris")
    idx = df.index[mask]
    occ_i = df.loc[idx, "occupation"].map({k: i for i, k in enumerate(OCC_LABELS)}).to_numpy()
    age_i = df.loc[idx, "age"].map(lambda a: AGE_BANDS.index(age_band(int(a)))).to_numpy()
    edu_i = df.loc[idx, "education_level"].map({k: i for i, k in enumerate(EDU_LABELS)}).to_numpy()
    post = prior[None, :] * p_occ[:, occ_i].T * p_age[:, age_i].T * p_edu[:, edu_i].T  # rows x 20
    mentions = df.loc[idx, "arr_mentions"].tolist()
    n_mention = sum(1 for m in mentions if m)
    post = post / post.sum(axis=1, keepdims=True)
    # inverse-CDF draw per row with the seeded RNG
    u = rng.random(len(idx))
    choice = (post.cumsum(axis=1) < u[:, None]).sum(axis=1).clip(0, 19)
    chosen = [arr_codes[k] for k in choice]
    df.loc[idx, "districtCode"] = chosen
    df.loc[idx, "districtSource"] = "imputed"
    agree = sum(1 for m, c in zip(mentions, chosen) if m and c in m)
    return {"n_imputed": int(len(idx)), "n_with_text_mention": n_mention, "n_mention_respected": agree}


def map_dataset_communes(df: pd.DataFrame, districts: pd.DataFrame) -> dict:
    """Dataset 'commune' text -> district code (arrondissements from 'Paris 11e Arrondissement', suburbs by name)."""
    by_name = {norm_name(r.fullName): r.code for r in districts.itertuples()}
    # also allow names of communes outside the bbox, so we can tell 'outside' from 'unmatched'
    all_names = {}
    for dept in ("92", "93", "94"):
        for c in json.loads(geo_file(dept).read_text(encoding="utf-8")):
            all_names[norm_name(c["nom"])] = c["code"]
    aliases = {"pierrefitte sur seine": "93066", "saint ouen": "93070", "saint ouen sur seine": "93070"}
    codes, unmatched = [], {}
    for dept, com in zip(df["departement"], df["commune"]):
        if dept == "Paris":
            m = re.match(r"Paris (\d+)(?:er|e) Arrondissement", com)
            codes.append(f"751{int(m.group(1)):02d}" if m else None)
            continue
        n = norm_name(com)
        code = by_name.get(n) or aliases.get(n)
        if code is None:
            code = "outside:" + all_names[n] if n in all_names else None
            if code is None:
                unmatched[com] = unmatched.get(com, 0) + 1
        codes.append(code)
    df["districtCode"] = codes
    df["districtSource"] = "dataset"
    outside = df["districtCode"].fillna("").str.startswith("outside:")
    return {"unmatched": unmatched, "rows_outside_bbox": int(outside.sum())}


# ----------------------------------------------------------------------------------------------
# 5. Raking + sampling
# ----------------------------------------------------------------------------------------------
def ipf(w0: np.ndarray, margins: list[tuple[np.ndarray, np.ndarray]], lo: float, hi: float, iters: int = 60) -> np.ndarray:
    """Iterative proportional fitting: scale weights until each margin's weighted shares match its targets.
    margins = [(category index per row, target share per category)]. Weights are kept within [lo, hi] x mean."""
    w = w0.astype(float).copy()
    for _ in range(iters):
        worst = 0.0
        for codes, target in margins:
            tot = w.sum()
            cur = np.bincount(codes, weights=w, minlength=len(target))
            want = target / target.sum() * tot
            # a factor of 0 would delete rows for good (e.g. farmers in Paris); keep a small floor instead
            factor = np.clip(np.where(cur > 0, want / np.maximum(cur, 1e-12), 1.0), 0.02, 50.0)
            w = w * factor[codes]
            worst = max(worst, float(np.abs(cur / tot - target / target.sum()).max()))
        m = w.mean()
        w = np.clip(w, lo * m, hi * m)
        if worst < 1e-4:
            break
    return w / w.mean()


def margin_codes(sub: pd.DataFrame) -> dict:
    occ = sub["occupation"].map({k: i for i, k in enumerate(OCC_LABELS)}).to_numpy()
    sex = (sub["sex"] == "Femme").astype(int).to_numpy()
    age = sub["age"].map(lambda a: AGE_BANDS.index(age_band(int(a)))).to_numpy()
    edu = sub["education_level"].map({k: i for i, k in enumerate(EDU_LABELS)}).to_numpy()
    return {"sexocc": sex * 8 + occ, "sexage": sex * 5 + age, "edu": edu, "occ": occ, "age": age}


def sample_district(pool: pd.DataFrame, n: int, tg: dict, rng: np.random.Generator) -> tuple[pd.DataFrame, dict]:
    """Rake the district pool to INSEE marginals, then draw n rows without replacement with probability ∝ raking
    weight (systematic PPS). The residual weight is computed later per departement (post_stratify)."""
    mc = margin_codes(pool)
    margins = [(mc["sexocc"], tg["sexocc"]), (mc["sexage"], tg["sexage"]), (mc["edu"], tg["edu"])]
    # rows whose own text names another arrondissement start with a low weight (soft preference, see above)
    code = pool["districtCode"].iloc[0]
    contra = pool["arr_mentions"].map(lambda m: bool(m) and code not in m).to_numpy()
    w0 = np.where(contra, CONTRADICTION_PENALTY, 1.0)
    w_pool = ipf(w0, margins, lo=0.002, hi=60)
    n = min(n, len(pool))
    pick = systematic_pps(w_pool, [mc["occ"], mc["sexocc"], mc["age"], mc["edu"]], n, rng)
    sample = pool.iloc[np.sort(pick)].copy()
    ms = margin_codes(sample)
    diag = {
        "pool_n": len(pool),
        "pool_occ": np.bincount(mc["occ"], minlength=8) / len(pool),
        "pool_age": np.bincount(mc["age"], minlength=5) / len(pool),
        "pool_raked_occ": np.bincount(mc["occ"], weights=w_pool, minlength=8) / w_pool.sum(),
        "sample_occ": np.bincount(ms["occ"], minlength=8) / n,
        "sample_age": np.bincount(ms["age"], minlength=5) / n,
        "pool_edu": np.bincount(mc["edu"], minlength=7) / len(pool),
        "sample_edu": np.bincount(ms["edu"], minlength=7) / n,
    }
    return sample, diag


def systematic_pps(w: np.ndarray, strata: list[np.ndarray], n: int, rng: np.random.Generator) -> np.ndarray:
    """Systematic sampling with probability proportional to weight, after sorting rows by occupation, sex,
    age band and education ("implicit stratification"). Equal steps along the cumulative weight guarantee that
    even a district with 5 residents gets an occupation mix close to its raked (INSEE) target.
    Rows are shuffled within strata first, so who is drawn is still random."""
    order = np.lexsort([rng.random(len(w))] + strata[::-1])  # np.lexsort: the LAST key is the primary key
    ws = w[order].astype(float)
    for _ in range(20):  # a row heavier than one step would be hit twice: cap it
        step = ws.sum() / n
        if not (ws > step).any():
            break
        ws = np.minimum(ws, step)
    cum = np.cumsum(ws)
    step = cum[-1] / n
    hits = np.searchsorted(cum, rng.random() * step + step * np.arange(n), side="right").clip(0, len(ws) - 1)
    chosen = list(dict.fromkeys(order[hits].tolist()))
    if len(chosen) < n:  # rare duplicates: fill with the heaviest remaining rows
        taken = set(chosen)
        rest = [int(i) for i in np.argsort(-w) if int(i) not in taken]
        chosen += rest[: n - len(chosen)]
    return np.array(chosen)


def post_stratify(pop: pd.DataFrame, districts: pd.DataFrame, insee: pd.DataFrame) -> None:
    """Residual raking per departement (Paris = 1,400 residents; 92/93/94 = 140-250 each): starting from the design
    weights, IPF on sex x occupation and sex x age band so each departement's weighted mix matches INSEE for the part
    of it inside the map. Districts of 1-40 residents are too small to rake one by one. Caps 0.33-3."""
    dsi = districts.set_index("code")
    pop["weight"] = pop["designWeight"].astype(float)
    for dept in ("75", "92", "93", "94"):
        m = (pop["districtCode"].str[:2] == dept).to_numpy()
        codes = sorted(set(pop.loc[m, "districtCode"]))
        w_d = np.array([insee.loc[c, "pop18p"] * (1.0 if dept == "75" else dsi.loc[c, "insideFrac"]) for c in codes])
        tgs = [insee_targets(insee.loc[c]) for c in codes]
        t_sexocc = np.average([t["sexocc"] for t in tgs], axis=0, weights=w_d)
        t_sexage = np.average([t["sexage"] for t in tgs], axis=0, weights=w_d)
        mc = margin_codes(pop.loc[m])
        w0 = pop.loc[m, "designWeight"].to_numpy()
        w = ipf(w0, [(mc["sexocc"], t_sexocc), (mc["sexage"], t_sexage)], lo=0.05, hi=20, iters=80)
        # keep each residual factor within 0.33-3 of the design weight
        w = np.clip(w * w0.sum() / w.sum(), w0 / 3, w0 * 3)
        pop.loc[m, "weight"] = w * w0.sum() / w.sum()
    pop["weight"] /= pop["weight"].mean()
    pop["rakeWeight"] = pop["weight"] / pop["designWeight"]


def allocate(shares: np.ndarray, total: int, minimum: np.ndarray) -> np.ndarray:
    """Largest-remainder allocation of `total` seats proportional to shares, with per-district minimums."""
    shares = shares / shares.sum()
    n = np.maximum(np.floor(shares * total).astype(int), minimum)
    while n.sum() > total:  # take back from the largest
        n[np.argmax(n - minimum)] -= 1
    rem = shares * total - n
    while n.sum() < total:
        k = int(np.argmax(rem))
        n[k] += 1
        rem[k] -= 1
    return n


# ----------------------------------------------------------------------------------------------
# 6. Imputation helpers (all district-calibrated)
# ----------------------------------------------------------------------------------------------
def pick_exact(odds: np.ndarray, k: int, rng: np.random.Generator) -> np.ndarray:
    """Choose exactly k of the rows, more likely those with higher odds (weighted sampling without replacement).
    Returns a boolean mask. Used so each district's imputed share matches its INSEE target exactly."""
    k = int(max(0, min(len(odds), k)))
    mask = np.zeros(len(odds), dtype=bool)
    if k == 0:
        return mask
    keys = np.log(rng.random(len(odds))) / np.maximum(odds, 1e-9)
    mask[np.argsort(-keys)[:k]] = True
    return mask


def exact_count(share: float, weights: np.ndarray) -> int:
    """How many of these residents should have the attribute so that the share matches (weights are near 1)."""
    return int(round(share * len(weights)))


# Turnout gradients (Insee Première n°1928 and n°1929, Nov 2022)
# Législatives 2022, share of registered voters who voted at least one round, by age (IP 1928, fig. 2-3)
TURNOUT_AGE = [
    (18, 0.348), (25, 0.353), (30, 0.401), (35, 0.482), (40, 0.564), (45, 0.624), (50, 0.654), (55, 0.692),
    (60, 0.711), (65, 0.718), (70, 0.752), (75, 0.736), (80, 0.685), (85, 0.513), (90, 0.333),
]
# Systematic voting 2022 by diploma, excluding students (IP 1929, fig. 6): ratio to the overall 38.3 %
DIPLOMA_FACTOR = {0: 28.8 / 38.3, 1: 38.1 / 38.3, 2: 38.1 / 38.3, 3: 33.3 / 38.3, 4: 43.7 / 38.3, 5: 43.7 / 38.3, 6: 43.7 / 38.3}
# ASSUMPTION (no INSEE table): owners vote more than renters (residential stability). Documented in the report.
TENURE_FACTOR = {"owner": 1.10, "private_renter": 0.95, "social_renter": 0.90}


def turnout_by_age(age: int) -> float:
    val = TURNOUT_AGE[0][1]
    for a, v in TURNOUT_AGE:
        if age >= a:
            val = v
    return val


# Registered voters in Paris (official votation results): 2 Apr 2023: 103,084 voters = 7.46 % -> ~1.38 M;
# 4 Feb 2024: ~78,000 = 5.68 % -> ~1.37 M. We calibrate registration so ~1.375 M of Paris adults are eligible.
PARIS_REGISTERED = 1_375_000
EU_REGISTRATION = 0.25  # ASSUMPTION: share of EU nationals on Paris complementary lists
# ASSUMPTION: EU citizens among foreign nationals (no commune-level INSEE split in the base files)
EU_SHARE_OF_FOREIGNERS = {"75": 0.30, "92": 0.30, "93": 0.15, "94": 0.25}
# ASSUMPTION: share of household cars meeting the Paris heavy-car definition (thermal/hybrid >= 1.6 t, EV >= 2 t)
HEAVY_SHARE_OF_CARS = 0.30

# Job hubs: (district code, anchor lon, lat, weights per occupation group). Unlisted groups use the "spread" term.
JOB_HUBS = [
    ("75108", 2.3100, 48.8720, {"cadres": 3.0, "prof_inter": 1.2, "employes": 1.5}),
    ("75109", 2.3330, 48.8740, {"cadres": 2.0, "prof_inter": 1.0, "employes": 1.0}),
    ("75102", 2.3410, 48.8680, {"cadres": 1.5, "prof_inter": 0.6, "employes": 0.8}),
    ("75101", 2.3400, 48.8620, {"cadres": 1.0, "prof_inter": 0.6, "employes": 1.0}),
    ("75107", 2.3150, 48.8560, {"cadres": 0.8, "prof_inter": 0.6, "employes": 0.4}),
    ("92062", 2.2389, 48.8918, {"cadres": 2.0, "prof_inter": 1.0, "employes": 0.8}),  # La Défense (Puteaux)
    ("92026", 2.2450, 48.8960, {"cadres": 1.5, "prof_inter": 0.8, "employes": 0.6}),  # La Défense (Courbevoie)
    ("75113", 2.3780, 48.8300, {"cadres": 1.0, "prof_inter": 1.0, "employes": 0.6}),
    ("75115", 2.2880, 48.8460, {"cadres": 1.0, "prof_inter": 0.8, "employes": 0.6}),
    ("75112", 2.3800, 48.8420, {"cadres": 1.0, "prof_inter": 0.8, "employes": 0.8}),
    ("92040", 2.2620, 48.8270, {"cadres": 1.2, "prof_inter": 0.8}),
    ("92012", 2.2400, 48.8350, {"cadres": 1.0, "prof_inter": 0.6}),
    ("93066", 2.3601, 48.9180, {"cadres": 1.2, "prof_inter": 1.0, "employes": 0.8, "ouvriers": 1.5}),  # Pleyel / Plaine
    ("93001", 2.3830, 48.9120, {"ouvriers": 1.2, "employes": 0.4}),
    ("92036", 2.2900, 48.9300, {"ouvriers": 2.0, "employes": 0.3}),  # Gennevilliers port
    ("94041", 2.3920, 48.8130, {"ouvriers": 1.0, "prof_inter": 0.3}),
    ("94081", 2.3950, 48.7880, {"ouvriers": 1.2}),
    ("94028", 2.4600, 48.7900, {"employes": 0.6, "prof_inter": 0.5}),  # Créteil (hospital, prefecture)
    ("92050", 2.2060, 48.8950, {"ouvriers": 0.6, "employes": 0.4, "prof_inter": 0.3}),
]
SPREAD = {"cadres": 3.0, "prof_inter": 6.0, "employes": 8.0, "ouvriers": 6.0, "artisans": 10.0, "agriculteurs": 10.0}
UNIVERSITIES = [
    ("75105", 2.3550, 48.8470, 2.0),  # Sorbonne / Jussieu
    ("75113", 2.3800, 48.8290, 1.5),  # Paris Rive Gauche / Tolbiac
    ("75106", 2.3370, 48.8450, 1.0),  # Assas / Saint-Germain
    ("93066", 2.3635, 48.9455, 1.0),  # Université Paris 8
    ("92050", 2.2125, 48.9035, 1.0),  # Université Paris Nanterre
    ("94028", 2.4512, 48.7896, 0.8),  # UPEC Créteil
    ("93001", 2.3720, 48.9070, 0.5),  # Campus Condorcet
]


# Suburban communes with at least one metro station (2024 network, incl. line 14 to Saint-Denis Pleyel and Orly,
# line 11 to Rosny, line 4 to Bagneux). Tram and bus are both counted as 'bus'.
METRO_COMMUNES = {
    "92004", "92007", "92012", "92020", "92024", "92026", "92036", "92040", "92044", "92046", "92049", "92051", "92062",
    "93001", "93006", "93008", "93027", "93045", "93048", "93055", "93061", "93063", "93064", "93066", "93070",
    "94018", "94021", "94028", "94038", "94041", "94043", "94046", "94067", "94073", "94076", "94080",
}


def km_between(lon1, lat1, lon2, lat2) -> float:
    dx = (lon2 - lon1) * 111.32 * math.cos(math.radians(48.86))
    dy = (lat2 - lat1) * 110.57
    return math.hypot(dx, dy)


# ----------------------------------------------------------------------------------------------
# 8. Names and looks
# ----------------------------------------------------------------------------------------------
NAME_ARTIFACTS = {"epse", "ep", "vve", "née", "nee", "veuve", "épouse", "mme", "m", "mlle", "dr"}
NOT_A_NAME_START = {"le", "la", "les", "saint", "sainte", "paris", "rue", "place", "bois", "parc", "marché", "musée", "île", "gare",
                    "porte", "canal", "quai", "boulevard", "avenue", "notre", "tour", "jardin", "palais", "grand", "petit", "un", "une"}
_UP = "A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸÆŒ"
_TOKEN = rf"[{_UP}][\w'’\-‑]*"
NAME_RE = re.compile(rf"(?<![\w'’\-‑])({_TOKEN}(?:\s+(?:(?:de|du|da|dos|das|des|van|von|el|al|ben|di|del|d'|d’)\s+)?{_TOKEN}){{0,3}})")
FALLBACK_FIRST = {
    "F": ["Camille", "Léa", "Manon", "Chloé", "Inès", "Sarah", "Julie", "Nadia", "Sophie", "Aïcha", "Claire", "Lina"],
    "M": ["Lucas", "Hugo", "Karim", "Thomas", "Mamadou", "Julien", "Nicolas", "Yanis", "Antoine", "Paul", "Samir", "Louis"],
}


def _name_candidates(text: str) -> list[list[str]]:
    """Capitalised token runs near the start of a text, with civil-status artifacts ('Epse', 'Vve') removed."""
    out = []
    for m in NAME_RE.finditer((text or "")[:160]):
        toks = m.group(1).split()
        while toks and toks[0].lower().strip(".") in NAME_ARTIFACTS:
            toks = toks[1:]
        if toks and toks[0].lower() not in NOT_A_NAME_START and not any(len(t) >= 2 and t.isupper() for t in toks):
            out.append(toks[:4])
    return out


def parse_name(persona: str, sex: str, uid: str, others: tuple[str, ...] = ()) -> tuple[str, str]:
    """Find the resident's name. Persona texts usually start with 'Firstname Lastname, ...' but sometimes start
    with adjectives ('Méthodique et réservé, Laurent Demay ...') or artifacts ('Epse Cavuoto ...').
    Rule: the first multi-word capitalised name in the persona that is confirmed by another text field of the
    same row; else the first multi-word candidate of any field; else a single confirmed first name; else a fallback.
    Returns (name, note)."""
    note = "removed civil-status prefix" if re.match(r"\s*(Epse|Vve|Née|Ep\.?)\b", persona or "") else ""
    other_text = " ".join(o or "" for o in others)
    cands = _name_candidates(persona)
    multi = [c for c in cands if len(c) >= 2]
    for c in multi:
        if " ".join(c) in other_text:
            return " ".join(c), note
    # persona gives only a first name ('..., Pascal mêle ...'): look for 'Pascal Surname' in the other fields
    singles = [c[0] for c in cands if len(c) == 1]
    for field in others:
        for c in _name_candidates(field):
            if len(c) >= 2 and c[0] in singles:
                return " ".join(c), (note + "; " if note else "") + "name taken from another text field"
    for field in (persona, *others):
        for c in _name_candidates(field):
            if len(c) >= 2 and " ".join(c) in (persona or "") + " " + other_text:
                if c is not None and (field is not persona):
                    return " ".join(c), (note + "; " if note else "") + "name taken from another text field"
                return " ".join(c), note
    for c in cands:
        if len(c) == 1 and re.search(rf"\b{re.escape(c[0])}\b", other_text):
            return c[0], (note + "; " if note else "") + "first name only"
    first = FALLBACK_FIRST[sex][stable_hash(uid) % len(FALLBACK_FIRST[sex])]
    return first, (note + "; " if note else "") + "fallback name"


def make_look(uid: str, sex: str, age: int) -> dict:
    """Deterministic avatar from the uuid hash (same uuid -> same look).
    hair: 0-5 natural colours, 6 = grey (probability rises from 0 at 40 to 90 % at 76+). Index 7 is not used because
    the two renderer palettes disagree on it (pink in web/src/map/palette.ts, light grey in web/src/ui/icons.tsx)."""
    h = hashlib.sha256(uid.encode()).digest()
    grey_p = 0.0 if age < 40 else min(0.9, (age - 40) / 40)
    hair = 6 if h[1] / 255 < grey_p else h[2] % 6
    styles = [0, 1, 2, 3] if sex == "M" else [2, 3, 4, 5]  # 0 cropped, 1 short, 2 side part, 3 curly, 4 bob, 5 long
    if sex == "M" and age >= 55 and h[3] % 3 == 0:
        style = 0
    else:
        style = styles[h[4] % 4]
    r = h[6] / 255
    if r < 0.50:
        acc = 0
    elif r < 0.50 + (0.10 + 0.25 * (age >= 50)):
        acc = 1  # glasses
    elif r < 0.85:
        acc = 3 if age < 40 else 2  # cap for younger, hat for older
    else:
        acc = 4  # scarf
    return {"skin": h[0] % 6, "hair": hair, "hairStyle": style, "shirt": h[5] % 12, "pants": h[7] % 6, "accessory": acc}


# ----------------------------------------------------------------------------------------------
# Groups (scenario-independent)
# ----------------------------------------------------------------------------------------------
GROUPS = [
    ("young_renters", "Young renters (18-34)", "Aged 18-34 and renting (private or social). Tenure is imputed from INSEE census shares."),
    ("families_with_kids", "Families with children", "Household type 'Couple avec enfant(s)' or 'Famille monoparentale' (from the dataset)."),
    ("single_parents", "Single parents", "Household type 'Famille monoparentale' (from the dataset)."),
    ("retired_owners", "Retired home-owners", "Occupation 'Retraités' (dataset) and owner-occupier (imputed tenure)."),
    ("seniors_75", "Seniors 75+", "Aged 75 or over (dataset)."),
    ("students", "Students (18-25)", "Aged 18-25 with occupation 'Autres sans activité professionnelle' (dataset); treated as students."),
    ("professionals", "Managers & professionals", "PCS 'Cadres et professions intellectuelles supérieures' (dataset, re-weighted to INSEE)."),
    ("service_workers", "Service & clerical employees", "PCS 'Employés' (dataset)."),
    ("manual_workers", "Manual workers", "PCS 'Ouvriers' (dataset)."),
    ("shopkeepers_artisans", "Shopkeepers, craftspeople & business owners", "PCS 'Artisans, commerçants, chefs d'entreprise' (dataset)."),
    ("no_car", "Households without a car", "No car in the household (imputed, calibrated to INSEE share of households with a car)."),
    ("heavy_car_owners", "Heavy-car owners", "Household has a car above the Paris heavy-car threshold (thermal/hybrid >= 1.6 t, EV >= 2 t). Imputed with an assumed share of cars."),
    ("social_housing", "Social-housing tenants", "Lives in social housing (HLM) — imputed, calibrated to INSEE census share per district."),
    ("cannot_vote", "Residents who cannot vote locally", "Non-EU foreign nationals (imputed from INSEE foreign share and an assumed EU share). They cannot vote in Paris votations."),
    ("suburb_residents", "Inner-suburb residents", "Lives in Hauts-de-Seine, Seine-Saint-Denis or Val-de-Marne (outside the city of Paris)."),
]


def groups_for(r: dict) -> list[str]:
    g = []
    renter = r["tenure"] in ("private_renter", "social_renter")
    if 18 <= r["age"] <= 34 and renter:
        g.append("young_renters")
    if r["household"] in ("couple_kids", "single_parent"):
        g.append("families_with_kids")
    if r["household"] == "single_parent":
        g.append("single_parents")
    if r["occupationGroup"] == "retraites" and r["tenure"] == "owner":
        g.append("retired_owners")
    if r["age"] >= 75:
        g.append("seniors_75")
    if r["isStudent"]:
        g.append("students")
    og = {"cadres": "professionals", "employes": "service_workers", "ouvriers": "manual_workers", "artisans": "shopkeepers_artisans"}
    if r["occupationGroup"] in og:
        g.append(og[r["occupationGroup"]])
    if not r["car"]:
        g.append("no_car")
    if r["heavyCar"]:
        g.append("heavy_car_owners")
    if r["tenure"] == "social_renter":
        g.append("social_housing")
    if r["nationality"] == "non_eu":
        g.append("cannot_vote")
    if r["dept"] != "75":
        g.append("suburb_residents")
    return g


# ----------------------------------------------------------------------------------------------
# Main build
# ----------------------------------------------------------------------------------------------
def build() -> dict:
    rng = np.random.default_rng(SEED)
    fetch_personas()
    districts = load_districts()
    insee = load_insee()
    missing = [c for c in districts["code"] if c not in insee.index]
    if missing:
        print("[warn] districts without INSEE data (dropped):", missing)
        districts = districts[~districts["code"].isin(missing)].reset_index(drop=True)
    dist_by_code = {r.code: r for r in districts.itertuples()}
    print(f"[districts] {len(districts)} districts ({(districts.dept == '75').sum()} arrondissements)")

    df = load_personas()
    stats = {"rows_total": len(df), "rows_by_dept": df["departement"].value_counts().to_dict()}
    stats["paris_rows"] = int((df["departement"] == "Paris").sum())
    stats["paris_no_arr"] = int(((df["departement"] == "Paris") & (df["commune"] == "Paris")).sum())
    stats["dataset_occ_by_dept"] = (
        df.assign(c=df["occupation"] == "Cadres et professions intellectuelles supérieures").groupby("departement")["c"].mean().to_dict()
    )
    stats["dataset_occ_paris"] = (
        df[df.departement == "Paris"]["occupation"].value_counts(normalize=True).reindex(OCC_LABELS).fillna(0).tolist()
    )
    text = df["persona"].fillna("") + " " + df["professional_persona"].fillna("") + " " + df["cultural_background"].fillna("")
    df["arr_mentions"] = [arrondissement_mentions(t) if d == "Paris" else set() for t, d in zip(text, df["departement"])]

    cm = map_dataset_communes(df, districts)
    stats["commune_mapping"] = cm
    # precision of the text-mention pattern on rows whose arrondissement IS in the dataset
    known = df[(df.departement == "Paris") & df.districtCode.notna()]
    with_m = known[known.arr_mentions.map(len) > 0]
    stats["mention_check"] = {
        "known_rows": len(known),
        "known_with_mention": len(with_m),
        "mention_agrees": int(sum(c in m for c, m in zip(with_m.districtCode, with_m.arr_mentions))),
    }
    stats["assign"] = assign_arrondissements(df, insee, rng)
    nop = df[(df.departement == "Paris") & (df.districtSource == "imputed")]
    all_m = [c for m in nop.arr_mentions for c in m]
    stats["mention_12e_share"] = all_m.count("75112") / max(1, len(all_m))
    print("[assign]", stats["assign"], "mention precision on known rows:", stats["mention_check"])

    # ---- quotas ----
    paris = districts[districts.dept == "75"].copy()
    sub = districts[districts.dept != "75"].copy()
    paris_w = paris["code"].map(insee["pop18p"]).to_numpy()
    paris["quota"] = allocate(paris_w, N_PARIS, np.full(len(paris), 10))
    sub_w = sub["code"].map(insee["pop18p"]).to_numpy() * sub["insideFrac"].to_numpy()
    sub_w = sub_w * sub["code"].map(lambda c: FOCUS_BOOSTS.get(c, 1.0)).to_numpy()
    sub["quota"] = allocate(sub_w, N_SUBURBS, np.where(sub["insideFrac"] >= 0.3, 2, 0))
    districts = pd.concat([paris, sub]).reset_index(drop=True)

    # ---- sampling per district ----
    samples, diags = [], {}
    for d in districts.itertuples():
        if d.quota <= 0:
            continue
        pool = df[df["districtCode"] == d.code]
        if len(pool) < max(30, 3 * d.quota):
            # small communes: borrow rows from the same departement (flagged as imputed location)
            extra = df[(df["departement"] == DEPT_NAMES[d.dept]) & (df["districtCode"] != d.code)].sample(
                n=max(0, 3 * d.quota + 30 - len(pool)), random_state=int(d.code)
            ).copy()
            extra["districtSource"] = "imputed"
            extra["districtCode"] = d.code
            pool = pd.concat([pool, extra])
            print(f"[sample] {d.fullName}: pool topped up with {len(extra)} rows from {DEPT_NAMES[d.dept]}")
        tg = insee_targets(insee.loc[d.code])
        s, diag = sample_district(pool, int(d.quota), tg, rng)
        diag["targets"] = tg
        diags[d.code] = diag
        samples.append(s)
    pop = pd.concat(samples).reset_index(drop=True)
    stats["sample_contradictions"] = int(sum(bool(m) and c not in m for m, c in zip(pop["arr_mentions"], pop["districtCode"])))
    df = None  # free memory
    print(f"[sample] {len(pop)} residents")

    # ---- design weight (undo unequal sampling rates between districts), combined with residual raking weight ----
    q = districts.set_index("code")["quota"]
    infr = districts.set_index("code")["insideFrac"]
    pop["designWeight"] = [insee.loc[c, "pop18p"] * (infr[c] if c[:2] != "75" else 1.0) / q[c] for c in pop["districtCode"]]
    pop["designWeight"] /= pop["designWeight"].mean()
    post_stratify(pop, districts, insee)

    # ---- basic derived fields ----
    pop["sexMF"] = np.where(pop["sex"] == "Femme", "F", "M")
    pop["occupationGroup"] = pop["occupation"].map(lambda o: OCC[o][0])
    pop["ageBand"] = pop["age"].map(lambda a: age_band(int(a)))
    pop["educationRank"] = pop["education_level"].map({k: i for i, k in enumerate(EDU_LABELS)})
    pop["household"] = pop["household_type"].map(HOUSEHOLD)
    pop["dept"] = pop["districtCode"].str[:2]
    pop["isStudent"] = (pop["occupationGroup"] == "sans_activite") & (pop["age"] <= 25)

    checks = impute_all(pop, districts, insee, rng)
    participation(pop)

    # ---- names, looks, groups ----
    names = [
        parse_name(p, s, u, (pp, cb))
        for p, s, u, pp, cb in zip(pop["persona"], pop["sexMF"], pop["uuid"], pop["professional_persona"], pop["cultural_background"])
    ]
    pop["name"] = [n for n, _ in names]
    pop["nameNote"] = [note for _, note in names]
    pop["look"] = [make_look(u, s, int(a)) for u, s, a in zip(pop["uuid"], pop["sexMF"], pop["age"])]
    recs = pop.to_dict("records")
    for r in recs:
        r["groupIds"] = groups_for(r)
    pop["groupIds"] = [r["groupIds"] for r in recs]

    # stable ids: Paris first (by arrondissement), then suburbs, then uuid
    pop = pop.sort_values(["districtCode", "uuid"]).reset_index(drop=True)
    pop["id"] = np.arange(len(pop))

    full = write_full(pop, districts, insee, stats, checks)
    write_report(pop, districts, insee, stats, diags, checks)
    return full


def impute_all(pop: pd.DataFrame, districts: pd.DataFrame, insee: pd.DataFrame, rng: np.random.Generator) -> dict:
    """Impute nationality, tenure, car, heavy car, registration, workplace and commute (in this order)."""
    checks = {"nationality": {}, "tenure": {}, "car": {}, "commute": {}}
    og = pop["occupationGroup"]
    age = pop["age"].to_numpy()
    hh = pop["household"]
    edu = pop["educationRank"].to_numpy()

    # Nationality: foreigner odds higher at 25-44 and for manual/service workers, lower for retirees.
    f_odds = np.exp(
        0.4 * ((age >= 25) & (age < 45))
        - 0.6 * (age >= 75)
        + og.map({"ouvriers": 0.6, "employes": 0.25, "cadres": -0.2, "retraites": -0.5, "artisans": 0.2}).fillna(0).to_numpy()
        + 0.4 * (edu == 0)
    )
    nat = np.array(["french"] * len(pop), dtype=object)
    for code, idx in pop.groupby("districtCode").groups.items():
        idx = np.asarray(idx)
        share = float(insee.loc[code, "foreign_share"])
        k = exact_count(share, idx)
        foreign = pick_exact(f_odds[idx], k, rng)
        eu_share = EU_SHARE_OF_FOREIGNERS[code[:2]]
        is_eu = pick_exact(np.ones(foreign.sum()), int(round(eu_share * foreign.sum())), rng)
        labels = np.where(is_eu, "eu", "non_eu")
        nat[idx[foreign]] = labels
        checks["nationality"][code] = (share, foreign.mean())
    pop["nationality"] = nat

    # Tenure: owner first, then social vs private among renters.
    own_odds = np.exp(
        0.035 * (np.clip(age, 18, 80) - 45)
        + hh.map({"couple_kids": 0.7, "couple_no_kids": 0.6, "single": -0.4, "single_parent": -0.5}).to_numpy()
        + og.map({"cadres": 0.5, "artisans": 0.6, "retraites": 0.3, "ouvriers": -0.4, "employes": -0.3}).fillna(0).to_numpy()
        - 2.0 * pop["isStudent"].to_numpy()
        - 0.8 * (pop["nationality"] == "non_eu").to_numpy()
    )
    soc_odds = np.exp(
        og.map({"ouvriers": 0.8, "employes": 0.6, "sans_activite": 0.3, "cadres": -1.0, "artisans": -0.4}).fillna(0).to_numpy()
        + hh.map({"single_parent": 0.8, "couple_kids": 0.3}).fillna(0).to_numpy()
        + 0.3 * (edu <= 2)
        + 0.3 * (pop["nationality"] == "non_eu").to_numpy()
        - 1.0 * pop["isStudent"].to_numpy()
    )
    tenure = np.array(["private_renter"] * len(pop), dtype=object)
    for code, idx in pop.groupby("districtCode").groups.items():
        idx = np.asarray(idx)
        o_sh, s_sh = float(insee.loc[code, "owner_share"]), float(insee.loc[code, "social_share"])
        owner = pick_exact(own_odds[idx], exact_count(o_sh, idx), rng)
        tenure[idx[owner]] = "owner"
        rest = idx[~owner]
        social = pick_exact(soc_odds[rest], int(round(s_sh * len(idx))), rng)
        tenure[rest[social]] = "social_renter"
        checks["tenure"][code] = ((o_sh, s_sh), (owner.mean(), social.sum() / len(idx)))
    pop["tenure"] = tenure

    # Car (household has >= 1 car): families, owners and suburb residents more likely; students/young less.
    car_odds = np.exp(
        hh.map({"couple_kids": 1.0, "couple_no_kids": 0.5, "single_parent": 0.0, "single": -0.6}).to_numpy()
        + og.map({"artisans": 0.8, "cadres": 0.3, "ouvriers": 0.2, "retraites": 0.2, "sans_activite": -0.5}).fillna(0).to_numpy()
        - 0.7 * (age < 30)
        - 0.3 * (age >= 80)
        + 0.6 * (pop["tenure"] == "owner").to_numpy()
        - 1.0 * pop["isStudent"].to_numpy()
    )
    car = np.zeros(len(pop), dtype=bool)
    for code, idx in pop.groupby("districtCode").groups.items():
        idx = np.asarray(idx)
        sh = float(insee.loc[code, "car_share"])
        car[idx] = pick_exact(car_odds[idx], exact_count(sh, idx), rng)
        checks["car"][code] = (sh, car[idx].mean())
    pop["car"] = car

    # Heavy car among car owners (one global share; no district statistic exists).
    heavy_odds = np.exp(
        og.map({"cadres": 0.4, "artisans": 0.5}).fillna(0).to_numpy()
        + hh.map({"couple_kids": 0.4, "single": -0.4}).fillna(0).to_numpy()
        - 0.5 * (age < 30)
        + 0.2 * (pop["dept"] != "75").to_numpy()
        + 0.2 * (pop["tenure"] == "owner").to_numpy()
    )
    heavy = np.zeros(len(pop), dtype=bool)
    cars = np.where(car)[0]
    heavy[cars[pick_exact(heavy_odds[cars], int(round(HEAVY_SHARE_OF_CARS * len(cars))), rng)]] = True
    pop["heavyCar"] = heavy

    # Registration and eligibility for Paris votations.
    is_paris = (pop["dept"] == "75").to_numpy()
    reg_odds = np.exp(-0.9 * (age < 25) - 0.6 * ((age >= 25) & (age < 35)) - 0.2 * ((age >= 35) & (age < 50)) + 0.6 * (age >= 50))
    registered = np.zeros(len(pop), dtype=bool)
    fr = np.where(pop["nationality"].to_numpy() == "french")[0]
    eu = np.where(pop["nationality"].to_numpy() == "eu")[0]
    registered[eu[pick_exact(np.ones(len(eu)), int(round(EU_REGISTRATION * len(eu))), rng)]] = True
    # Paris: number of eligible residents (weighted) should match the official register size
    paris_adults = float(insee.loc[[c for c in insee.index if c.startswith("751")], "pop18p"].sum())
    target_eligible_share = PARIS_REGISTERED / paris_adults
    fr_p = fr[is_paris[fr]]
    eu_p_reg = registered[eu[is_paris[eu]]].sum()
    k_fr = int(round(target_eligible_share * is_paris.sum() - eu_p_reg))
    registered[fr_p[pick_exact(reg_odds[fr_p], k_fr, rng)]] = True
    fr_s = fr[~is_paris[fr]]
    registered[fr_s[pick_exact(reg_odds[fr_s], int(round(0.88 * len(fr_s))), rng)]] = True
    pop["registered"] = registered
    pop["eligibleParis"] = is_paris & registered
    checks["eligible"] = {
        "target_share_paris_adults": target_eligible_share,
        "sim_share": float(pop.loc[is_paris, "eligibleParis"].mean()),
        "paris_adults_insee": paris_adults,
    }

    # Workplace + commute
    impute_work(pop, districts, insee, rng, checks)
    return checks


def impute_work(pop, districts, insee, rng, checks):
    dlon = districts.set_index("code")["lon"].to_dict()
    dlat = districts.set_index("code")["lat"].to_dict()
    dpop = {c: float(insee.loc[c, "pop18p"]) for c in districts["code"]}
    codes = list(districts["code"])
    hub_weight = {g: {} for g in SPREAD}
    anchors = {}
    for code, lon, lat, wts in JOB_HUBS:
        if code not in dlon:
            continue
        anchors[code] = (lon, lat)
        for g, w in wts.items():
            hub_weight[g][code] = hub_weight[g].get(code, 0) + w
    total_pop = sum(dpop.values())

    work_code, work_anchor = [], []
    for r in pop.itertuples():
        g = r.occupationGroup
        home = r.districtCode
        if r.isStudent:
            if rng.random() < 0.65:  # most 18-25 students attend a university/school
                w = np.array([u[3] * math.exp(-km_between(dlon[home], dlat[home], u[1], u[2]) / 12) for u in UNIVERSITIES])
                u = UNIVERSITIES[int(rng.choice(len(UNIVERSITIES), p=w / w.sum()))]
                work_code.append(u[0])
                work_anchor.append([u[1], u[2]])
            else:
                work_code.append(None)
                work_anchor.append(None)
            continue
        if g in ("retraites", "sans_activite"):
            work_code.append(None)
            work_anchor.append(None)
            continue
        in_commune = float(insee.loc[home, "work_in_commune"])
        if home.startswith("751"):
            p_own = 0.40  # ASSUMPTION: own arrondissement (INSEE only gives "works in Paris")
            p_paris = in_commune  # INSEE: share of employed Paris residents who work in Paris
        else:
            p_own = in_commune
            p_paris = None
        if g == "artisans":
            p_own = min(0.9, p_own + 0.25)
        if rng.random() < p_own:
            work_code.append(home)
            work_anchor.append(None)
            continue
        # choose among other districts: hubs + population "spread", with distance decay
        cand = [c for c in codes if c != home]
        if p_paris is not None:
            want_paris = rng.random() < max(0.0, (p_paris - p_own) / (1 - p_own))
            cand = [c for c in cand if c.startswith("751") == want_paris]
        w = np.array(
            [
                (hub_weight[g].get(c, 0.0) + SPREAD[g] * dpop[c] / total_pop * 10)
                * math.exp(-km_between(dlon[home], dlat[home], dlon[c], dlat[c]) / 9)
                for c in cand
            ]
        )
        c = cand[int(rng.choice(len(cand), p=w / w.sum()))]
        work_code.append(c)
        work_anchor.append(list(anchors[c]) if c in anchors and hub_weight[g].get(c, 0) > 0 else None)
    pop["workDistrictCode"] = pd.Series(work_code, dtype=object)
    pop["workAnchor"] = pd.Series(work_anchor, dtype=object)

    # Commute distance (district centres, or the anchor) and mode
    dist = []
    for r in pop.itertuples():
        if not isinstance(r.workDistrictCode, str):
            dist.append(None)
            continue
        if r.workDistrictCode == r.districtCode and r.workAnchor is None:
            dist.append(1.2 if r.districtCode.startswith("751") else 1.6)
            continue
        lon, lat = r.workAnchor if r.workAnchor else (dlon[r.workDistrictCode], dlat[r.workDistrictCode])
        dist.append(max(0.8, km_between(dlon[r.districtCode], dlat[r.districtCode], lon, lat)))
    pop["commuteKm"] = dist
    commute_modes(pop, insee, rng, checks)


def commute_modes(pop, insee, rng, checks):
    """Prior from distance/car/geography, then calibrated per home district to INSEE RP 2022 mode shares
    (walk, bike, car, public transport) of employed residents; public transport is then split metro/RER/bus."""
    has = pop["workDistrictCode"].map(lambda c: isinstance(c, str)).to_numpy()
    idx_all = np.where(has)[0]
    P = np.zeros((len(pop), 4))  # walk, bike, car, tcom
    for i in idx_all:
        r = pop.iloc[i]
        d = r["commuteKm"]
        hp, wp = r["districtCode"].startswith("751"), r["workDistrictCode"].startswith("751")
        walk = 3.0 * math.exp(-d / 0.9)
        bike = (0.6 if r["age"] < 65 else 0.15) * math.exp(-d / 5)
        if r["car"]:
            car = (0.15 if (hp and wp) else 0.4 if (hp or wp) else 1.0) * (1 + d / 10) * (2.0 if r["occupationGroup"] in ("artisans", "ouvriers") else 1.0)
        else:
            car = 0.0
        tcom = 1.2 * (1 - math.exp(-d / 1.2))
        P[i] = [walk, bike, car, tcom]
    modes = np.array([None] * len(pop), dtype=object)
    for code, idx in pop.groupby("districtCode").groups.items():
        idx = np.array([i for i in idx if has[i]])
        if len(idx) == 0:
            continue
        t = np.array([insee.loc[code, f"mode_{m}"] for m in ("walk", "bike", "car", "tcom")], dtype=float)
        t = t / t.sum()
        M = P[idx] + 1e-6
        M = M / M.sum(axis=1, keepdims=True)
        for _ in range(30):  # IPF on the residents x modes probability matrix
            col = M.sum(axis=0)
            M = M * (t * len(idx) / np.maximum(col, 1e-9))[None, :]
            M = M / M.sum(axis=1, keepdims=True)
            M[:, 2] = np.where(pop["car"].to_numpy()[idx], M[:, 2], 0)
            M = M / M.sum(axis=1, keepdims=True)
        draws = [["walk", "bike", "car", "tcom"][int(rng.choice(4, p=row))] for row in M]
        modes[idx] = draws
        checks["commute"][code] = (t.tolist(), [float(np.mean(np.array(draws) == m)) for m in ("walk", "bike", "car", "tcom")])
    # split public transport into metro / RER / bus by geography (metro only where a station exists)
    final = []
    for i, m in enumerate(modes):
        r = pop.iloc[i]
        if m is None:
            final.append("none")
            continue
        if m != "tcom":
            final.append(m)
            continue
        home, work = r["districtCode"], r["workDistrictCode"]
        hp, wp = home.startswith("751"), work.startswith("751")
        metro_ok = (hp or home in METRO_COMMUNES) and (wp or work in METRO_COMMUNES)
        if hp and wp:
            p = {"metro": 0.75, "bus": 0.15, "rer": 0.10}
        elif home == work:  # trip inside one suburban commune: bus/tram, metro if there is one
            p = {"bus": 0.85, "metro": 0.15 if metro_ok else 0.0, "rer": 0.0}
        elif hp or wp:
            p = {"rer": 0.40, "metro": 0.45 if metro_ok else 0.0, "bus": 0.15}
        else:
            p = {"bus": 0.45, "rer": 0.35, "metro": 0.20 if metro_ok else 0.0}
        keys = list(p)
        pr = np.array([p[k] for k in keys])
        final.append(keys[int(rng.choice(len(keys), p=pr / pr.sum()))])
    pop["commuteMode"] = final


def participation(pop: pd.DataFrame) -> None:
    """participationBase = turnout(age) x diploma factor x tenure factor (0 for non-EU foreigners).
    turnout(age): législatives 2022 'voted at least one round' by 5-year age group (Insee Première 1928);
    diploma factor: systematic-voting ratio by diploma (Insee Première 1929); tenure factor: assumption.
    The scenario engine rescales these so the attendee share equals the real turnout."""
    base = []
    prop = []
    for r in pop.itertuples():
        p = turnout_by_age(int(r.age)) * DIPLOMA_FACTOR[int(r.educationRank)] * TENURE_FACTOR[r.tenure]
        p = float(min(1.0, p))
        prop.append(round(p, 4))
        base.append(0.0 if r.nationality == "non_eu" else round(p, 4))
    pop["participationBase"] = base
    pop["participationPropensity"] = prop


# ----------------------------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------------------------
def sources() -> list[dict]:
    s = [
        {"name": "NVIDIA Nemotron-Personas-France", "url": "https://huggingface.co/datasets/nvidia/Nemotron-Personas-France", "license": "CC BY 4.0"},
    ]
    for k, (page, fname, title) in INSEE_FILES.items():
        s.append({"name": f"INSEE — {title}", "url": f"https://www.insee.fr/fr/statistiques/{page}", "license": "Licence Ouverte / Etalab 2.0"})
    s += [
        {"name": "INSEE Première n°1928 — Participation électorale 2022", "url": "https://www.insee.fr/fr/statistiques/6658145", "license": "Licence Ouverte / Etalab 2.0"},
        {"name": "INSEE Première n°1929 — Vingt ans de participation électorale", "url": "https://www.insee.fr/fr/statistiques/6658143", "license": "Licence Ouverte / Etalab 2.0"},
        {"name": "geo.api.gouv.fr — communes and arrondissements (outlines, population)", "url": "https://geo.api.gouv.fr/decoupage-administratif/communes", "license": "Licence Ouverte / Etalab 2.0"},
    ]
    return s


METHOD = {
    "sampling": (
        f"{N_PARIS} residents in Paris allocated to the 20 arrondissements in proportion to INSEE 2022 adults (18+, min 10 each); "
        f"{N_SUBURBS} in the communes of Hauts-de-Seine, Seine-Saint-Denis and Val-de-Marne that intersect the map, in proportion to "
        f"adults x share of the commune area inside the map, with the communes around the hypothetical data-centre site oversampled (La Courneuve x7, Le Bourget x5, Drancy x3.5, Dugny x3, other neighbours x2.5). "
        "Within each district, NVIDIA Nemotron-Personas-France rows are raked to INSEE marginals and drawn without replacement "
        "with probability proportional to their raking weight. Half of the dataset's Paris rows have no arrondissement: those are "
        "assigned one jointly with their occupation, age band and education (P(arr|occ,age,edu) ∝ P(arr)·P(occ|arr)·P(age|arr)·P(edu|arr), "
        "INSEE shares), never uniformly at random. Draws are systematic PPS after sorting by occupation/sex/age/education, "
        "with a 20x lower starting weight for rows whose own text names a different arrondissement (keeps texts consistent)."
    ),
    "raking": (
        "Iterative proportional fitting per district on sex x occupation (8 PCS groups, 18+), sex x age band (5) and education (7 levels) "
        "from the INSEE 2022 census; rows are then drawn by systematic PPS. After sampling, a residual raking weight per departement "
        "(sex x occupation, sex x age; capped 0.33-3) corrects what the draw left. `weight` = design weight (district adults / residents drawn, undoing the unequal sampling rates between Paris, "
        "suburbs and the boosted communes) x residual raking weight, normalised to mean 1. Use `weight` for every aggregate."
    ),
    "imputation": [
        "IMPUTED nationality (french / eu / non_eu): per district, the INSEE 2022 share of foreign nationals is matched exactly; "
        "who is foreign depends only on age band, occupation and education (never on names or cultural background). EU share of "
        f"foreigners is an assumption: {EU_SHARE_OF_FOREIGNERS}.",
        "IMPUTED tenure (owner / private_renter / social_renter): per district, INSEE 2022 shares of people living in owner-occupied, "
        "privately rented and HLM dwellings are matched exactly; owners are more likely older, couples, cadres/artisans/retirees.",
        "IMPUTED car (household has >= 1 car): per district, INSEE 2022 share of households with a car is matched exactly; more likely "
        "for families, owners, artisans; less likely for students and under-30s.",
        f"IMPUTED heavyCar (Paris SUV-fee definition: thermal/hybrid >= 1.6 t or EV >= 2 t): ASSUMPTION {int(HEAVY_SHARE_OF_CARS * 100)} % of "
        "household cars (no official estimate found), more likely for cadres, artisans, families with children and suburb residents.",
        f"IMPUTED registration: EU nationals {int(EU_REGISTRATION * 100)} % registered (assumption); French nationals in Paris registered "
        f"so that eligible adults match the ~{PARIS_REGISTERED:,} registered voters of the 2023/2024 votations (younger people less often "
        "registered); suburbs 88 % of French adults. eligibleParis = lives in Paris AND registered (French or EU).",
        "IMPUTED workplace: retirees and non-working adults have none; 65 % of 18-25 students get a university (Sorbonne/Jussieu, "
        "Paris Rive Gauche, Assas, Paris 8 Saint-Denis, Nanterre, Créteil, Condorcet). Workers: own district with probability INSEE "
        "'works in commune of residence' (suburbs) or 40 % (Paris arrondissements, assumption), Paris residents keep the INSEE share "
        "working inside Paris; otherwise job hubs by occupation (8e/9e/1er-2e, La Défense, 13e, 15e, 12e, Issy/Boulogne, "
        "Saint-Denis Pleyel, Gennevilliers port, Ivry/Vitry, Créteil...) plus a population-proportional spread, with distance decay.",
        "IMPUTED commuteMode: a prior from distance, car and Paris/suburb geography, calibrated per home district to INSEE 2022 mode "
        "shares of employed residents (walk, bike, car, public transport; motorised two-wheelers and 'no transport' excluded), "
        "then public transport split into metro / RER / bus by geography.",
        "participationBase (not imputed from the LLM): turnout by 5-year age group in the 2022 legislative elections (Insee Première "
        "1928) x diploma ratio of systematic voting (Insee Première 1929) x tenure factor (owner 1.10, private renter 0.95, social "
        "renter 0.90 — assumption); 0 for non-EU foreign nationals, who cannot vote. The scenario engine rescales to real turnout.",
    ],
}


def resident_record(r) -> dict:
    """Fields shared by the full file and the slim web file (no tiles yet; place_residents.py adds them)."""
    return {
        "id": int(r["id"]),
        "uuid": r["uuid"],
        "name": r["name"],
        "sex": r["sexMF"],
        "age": int(r["age"]),
        "ageBand": r["ageBand"],
        "occupation": r["occupation"],
        "occupationGroup": r["occupationGroup"],
        "occupationEn": OCC[r["occupation"]][1],
        "education": r["education_level"],
        "educationRank": int(r["educationRank"]),
        "household": r["household"],
        "householdRaw": r["household_type"],
        "maritalStatus": r["marital_status"],
        "districtCode": r["districtCode"],
        "districtSource": r["districtSource"],
        "workDistrictCode": r["workDistrictCode"] if isinstance(r["workDistrictCode"], str) else None,
        "workAnchor": r["workAnchor"] if isinstance(r["workAnchor"], list) else None,
        "commuteMode": r["commuteMode"],
        "commuteKm": None if r["commuteKm"] is None or (isinstance(r["commuteKm"], float) and math.isnan(r["commuteKm"])) else round(float(r["commuteKm"]), 2),
        "imputed": {"car": bool(r["car"]), "heavyCar": bool(r["heavyCar"]), "tenure": r["tenure"], "nationality": r["nationality"]},
        "eligibleParis": bool(r["eligibleParis"]),
        "registered": bool(r["registered"]),
        "participationBase": float(r["participationBase"]),
        "participationPropensity": float(r["participationPropensity"]),
        "weight": round(float(r["weight"]), 5),
        "designWeight": round(float(r["designWeight"]), 5),
        "rakeWeight": round(float(r["rakeWeight"]), 5),
        "groupIds": list(r["groupIds"]),
        "personaFr": r["persona"],
        "personaEn": "",
        "look": r["look"],
    }


def write_full(pop, districts, insee, stats, checks) -> dict:
    residents = []
    for r in pop.to_dict("records"):
        rec = resident_record(r)
        rec["professionalPersonaFr"] = r["professional_persona"]
        rec["culturalBackgroundFr"] = r["cultural_background"]
        rec["datasetCommune"] = r["commune"]
        rec["textArrondissementMentions"] = sorted(r["arr_mentions"])
        rec["nameNote"] = r["nameNote"]
        residents.append(rec)
    dlist = []
    for d in districts.itertuples():
        ins = insee.loc[d.code]
        dlist.append(
            {
                "code": d.code, "name": d.name, "fullName": d.fullName, "dept": d.dept, "kind": d.kind,
                "population": int(d.population), "adults18p": int(round(ins["pop18p"])), "insideFrac": d.insideFrac,
                "centre": [d.lon, d.lat], "residents": int(d.quota),
                "insee": {
                    "ownerShare": round(float(ins["owner_share"]), 4), "socialShare": round(float(ins["social_share"]), 4),
                    "carShare": round(float(ins["car_share"]), 4), "foreignShare": round(float(ins["foreign_share"]), 4),
                    "workInCommune": round(float(ins["work_in_commune"]), 4),
                    "occShare": {g: round(float(v), 4) for g, v in zip(OCC_GROUPS, insee_targets(ins)["occ"])},
                },
            }
        )
    full = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "seed": SEED,
        "count": len(residents),
        "residents": residents,
        "districts": dlist,
        "groups": [{"id": g, "label": l, "description": d} for g, l, d in GROUPS],
        "method": {**METHOD, "knownDatasetIssues": known_issues(stats)},
        "sources": sources(),
        "notes": [
            "workAnchor = [lon, lat] of a job hub or university when relevant; place_residents.py turns it into a work tile.",
            "participationPropensity = participationBase without the non-EU zero (for open public meetings / online consultations).",
            "weight already includes the design weight; Paris-only aggregates can use it directly.",
        ],
    }
    write_json(FULL_OUT, full)
    print(f"[write] {FULL_OUT} ({FULL_OUT.stat().st_size / 1e6:.2f} MB)")
    return full


def known_issues(stats) -> list[str]:
    occ = dict(zip(OCC_GROUPS, stats["dataset_occ_paris"]))
    return [
        "Paris (like Lyon and Marseille) is sampled twice: once as the city ('Paris', no arrondissement) and once as its 20 "
        f"arrondissements — {stats['paris_rows'] * 1000 / 2103778:.1f} rows per 1,000 inhabitants vs ~13 in 92/93/94. Harmless here "
        "because we sample fixed quotas per district and rake to INSEE.",
        f"{stats['paris_no_arr'] / stats['paris_rows']:.1%} of the dataset's Paris rows ({stats['paris_no_arr']:,} of {stats['paris_rows']:,}) "
        "have commune 'Paris' without an arrondissement; we assigned one jointly with occupation, age and education (districtSource = 'imputed').",
        f"Occupation is not conditioned below the departement: Paris rows have {occ['cadres']:.1%} cadres (INSEE Paris 18+: ~31 %) and "
        f"{occ['agriculteurs']:.1%} farmers; similar ~10 % cadres in every departement and arrondissement. Corrected by raking.",
        "No income, tenure, car, commute, workplace or nationality fields: all of these are imputed from INSEE statistics and labelled as such.",
        f"Rows that only say 'Paris' still name an arrondissement in their text {stats['assign']['n_with_text_mention'] / max(1, stats['paris_no_arr']):.0%} "
        f"of the time, invented by the generator ({stats['mention_12e_share']:.0%} of those mentions are the 12e); we never use them as evidence.",
        "Names: a few persona texts start with civil-status artifacts ('Epse Cavuoto ...') or with adjectives instead of the name; "
        "we take the name confirmed by the other text fields.",
    ]


def pct(x) -> str:
    return f"{100 * x:.1f}"


def write_report(pop, districts, insee, stats, diags, checks) -> None:
    L = []
    L.append("# Population report — Town-in-a-Box\n")
    L.append(f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')} by `pipeline/build_population.py` (seed {SEED}).\n")
    L.append(f"- Residents: **{len(pop)}** ({(pop.dept == '75').sum()} Paris, {(pop.dept != '75').sum()} inner suburbs) in {pop.districtCode.nunique()} districts.")
    L.append(f"- Dataset rows used as the sampling frame: {stats['rows_total']:,} (Paris {stats['paris_rows']:,}).")
    L.append(f"- Paris rows without arrondissement: {stats['paris_no_arr']:,} ({pct(stats['paris_no_arr'] / stats['paris_rows'])} %). "
             f"{stats['assign']['n_with_text_mention']:,} of them nevertheless name an arrondissement in their own text "
             f"(the generator invented one: {stats['mention_12e_share']:.0%} of those mentions are the 12e), so mentions are not used as evidence.")
    L.append(f"- Sampled residents whose own text names a different arrondissement than their home: {stats['sample_contradictions']}.")
    mc = stats["mention_check"]
    L.append(f"- Text-mention pattern check on rows WITH a dataset arrondissement: {mc['known_with_mention']:,} of {mc['known_rows']:,} mention one; "
             f"{pct(mc['mention_agrees'] / max(1, mc['known_with_mention']))} % agree with the structured field.")
    L.append(f"- Residents whose district is imputed (not in the dataset row): {(pop.districtSource == 'imputed').sum()} "
             f"({pct((pop.districtSource == 'imputed').mean())} %).")
    L.append(f"- Suburban dataset rows in communes outside the map: {stats['commune_mapping']['rows_outside_bbox']:,}; unmatched commune names: {stats['commune_mapping']['unmatched'] or 'none'}.\n")

    # Paris-wide occupation before / after
    par = pop[pop.dept == "75"]
    ins_par = insee.loc[[c for c in insee.index if c.startswith("751")]].sum()
    tg_par = insee_targets(ins_par)
    w = par["weight"].to_numpy()
    occ_i = par["occupation"].map({k: i for i, k in enumerate(OCC_LABELS)}).to_numpy()
    sim_unw = np.bincount(occ_i, minlength=8) / len(par)
    sim_w = np.bincount(occ_i, weights=w, minlength=8) / w.sum()
    L.append("## Paris: occupation (PCS) before and after\n")
    L.append("| Group | Dataset Paris rows | Sample (unweighted) | Sample (weighted) | INSEE 2022 (18+) |")
    L.append("|---|---:|---:|---:|---:|")
    for i, g in enumerate(OCC_GROUPS):
        L.append(f"| {g} | {pct(stats['dataset_occ_paris'][i])} | {pct(sim_unw[i])} | {pct(sim_w[i])} | {pct(tg_par['occ'][i])} |")
    L.append("")
    age_i = par["ageBand"].map(AGE_BANDS.index).to_numpy()
    L.append("## Paris: age bands\n")
    L.append("| Age band | Sample (unweighted) | Sample (weighted) | INSEE 2022 |")
    L.append("|---|---:|---:|---:|")
    a_unw = np.bincount(age_i, minlength=5) / len(par)
    a_w = np.bincount(age_i, weights=w, minlength=5) / w.sum()
    for i, b in enumerate(AGE_BANDS):
        L.append(f"| {b} | {pct(a_unw[i])} | {pct(a_w[i])} | {pct(tg_par['age'][i])} |")
    L.append("")

    L.append("## Per district: cadres / ouvriers / retirees share (%) — dataset pool → sample (weighted) vs INSEE\n")
    L.append("| District | n | pool rows | cadres pool | cadres sim | cadres INSEE | ouvriers sim | ouvriers INSEE | retraités sim | retraités INSEE | 18-29 sim | 18-29 INSEE |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    names = districts.set_index("code")["fullName"].to_dict()
    for code, dg in diags.items():
        t = dg["targets"]
        sub = pop[pop.districtCode == code]
        sw = sub["weight"].to_numpy()
        dg["sample_w_occ"] = np.bincount(sub["occupation"].map({k: i for i, k in enumerate(OCC_LABELS)}).to_numpy(), weights=sw, minlength=8) / sw.sum()
        dg["sample_w_age"] = np.bincount(sub["ageBand"].map(AGE_BANDS.index).to_numpy(), weights=sw, minlength=5) / sw.sum()
        L.append(
            f"| {names[code]} | {int(districts.set_index('code').loc[code, 'quota'])} | {dg['pool_n']} | {pct(dg['pool_occ'][2])} | {pct(dg['sample_w_occ'][2])} | {pct(t['occ'][2])} "
            f"| {pct(dg['sample_w_occ'][5])} | {pct(t['occ'][5])} | {pct(dg['sample_w_occ'][6])} | {pct(t['occ'][6])} | {pct(dg['sample_w_age'][0])} | {pct(t['age'][0])} |"
        )
    # overall error summary
    qn = districts.set_index("code")["quota"]
    for label, pref in (("Paris arrondissements", "75"), ("suburban communes", "9")):
        ks = [c for c in diags if c.startswith(pref)]
        nn = np.array([qn[c] for c in ks], dtype=float)
        e_s = np.array([np.abs(diags[c]["sample_w_occ"] - diags[c]["targets"]["occ"]).sum() / 2 for c in ks])
        e_p = np.array([np.abs(diags[c]["pool_occ"] - diags[c]["targets"]["occ"]).sum() / 2 for c in ks])
        # best possible distance with whole residents (n=5 can only express shares in steps of 20 %)
        e_best = []
        for c in ks:
            t = diags[c]["targets"]["occ"]
            k = allocate(t + 1e-12, int(qn[c]), np.zeros(8, dtype=int)) / qn[c]
            e_best.append(np.abs(k - t).sum() / 2)
        L.append(f"\n{label}: resident-weighted mean total-variation distance of the occupation mix vs INSEE — "
                 f"dataset pool **{pct(np.average(e_p, weights=nn))} pts** → weighted sample **{pct(np.average(e_s, weights=nn))} pts** "
                 f"(best achievable with whole residents: {pct(np.average(e_best, weights=nn))} pts).")
    L.append("\nSuburban communes have 1-40 residents each, so single-commune shares are noisy; departement totals:\n")
    L.append("| Departement | n | cadres sim | cadres INSEE | ouvriers sim | ouvriers INSEE | retraités sim | retraités INSEE | dataset cadres |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    dsi = districts.set_index("code")
    for dept in ("75", "92", "93", "94"):
        m = (pop.dept == dept).to_numpy()
        ww = pop.loc[m, "weight"].to_numpy()
        oi = pop.loc[m, "occupation"].map({k: i for i, k in enumerate(OCC_LABELS)}).to_numpy()
        sh = np.bincount(oi, weights=ww, minlength=8) / ww.sum()
        codes_d = [c for c in districts.code if c.startswith(dept) and qn[c] > 0]
        # INSEE share for the part of the departement we model (weighted like the design weights)
        tw = np.array([insee.loc[c, "pop18p"] * (1 if dept == "75" else dsi.loc[c, "insideFrac"]) for c in codes_d])
        to = np.average([insee_targets(insee.loc[c])["occ"] for c in codes_d], axis=0, weights=tw)
        L.append(f"| {DEPT_NAMES[dept]} | {m.sum()} | {pct(sh[2])} | {pct(to[2])} | {pct(sh[5])} | {pct(to[5])} | {pct(sh[6])} | {pct(to[6])} | {pct(stats['dataset_occ_by_dept'][DEPT_NAMES[dept]])} |")
    L.append("")

    L.append("## Imputed attributes vs INSEE targets (Paris and suburbs)\n")
    def agg(key, f):
        rows = []
        for code, v in checks[key].items():
            rows.append(f(v))
        return np.mean(np.abs(np.array(rows)), axis=0)
    w_all = pop["weight"].to_numpy()
    for label, mask in (("Paris", pop.dept == "75"), ("Suburbs", pop.dept != "75")):
        m = mask.to_numpy()
        ww = w_all[m]
        car_t = np.average([insee.loc[c, "car_share"] for c in pop.loc[m, "districtCode"]], weights=ww)
        own_t = np.average([insee.loc[c, "owner_share"] for c in pop.loc[m, "districtCode"]], weights=ww)
        soc_t = np.average([insee.loc[c, "social_share"] for c in pop.loc[m, "districtCode"]], weights=ww)
        for_t = np.average([insee.loc[c, "foreign_share"] for c in pop.loc[m, "districtCode"]], weights=ww)
        L.append(f"**{label}** (weighted): car {pct(np.average(pop.loc[m, 'car'], weights=ww))} % (INSEE households {pct(car_t)} %), "
                 f"owners {pct(np.average(pop.loc[m, 'tenure'] == 'owner', weights=ww))} % ({pct(own_t)}), "
                 f"social housing {pct(np.average(pop.loc[m, 'tenure'] == 'social_renter', weights=ww))} % ({pct(soc_t)}), "
                 f"foreign {pct(np.average(pop.loc[m, 'nationality'] != 'french', weights=ww))} % ({pct(for_t)}), "
                 f"heavy car {pct(np.average(pop.loc[m, 'heavyCar'], weights=ww))} % of residents.\n")
    e = checks["eligible"]
    L.append(f"Paris eligibility: {pct(e['sim_share'])} % of simulated Paris adults are eligible (target {pct(e['target_share_paris_adults'])} % = "
             f"{PARIS_REGISTERED:,} registered / {e['paris_adults_insee']:,.0f} INSEE adults).\n")

    L.append("## Commute mode of employed residents vs INSEE (walk / bike / car / public transport, %)\n")
    for label, pref in (("Paris", "751"), ("Suburbs", "9")):
        tt, ss = [], []
        for code, (t, s) in checks["commute"].items():
            if code.startswith(pref):
                n = int(((pop.districtCode == code) & pop.workDistrictCode.notna()).sum())
                tt.append(np.array(t) * n)
                ss.append(np.array(s) * n)
        tt, ss = np.sum(tt, axis=0), np.sum(ss, axis=0)
        L.append(f"- {label}: simulated {' / '.join(pct(x) for x in ss / ss.sum())} vs INSEE {' / '.join(pct(x) for x in tt / tt.sum())}")
    L.append("- Public transport split: " + ", ".join(f"{m} {(pop.commuteMode == m).sum()}" for m in ("metro", "rer", "bus")))
    L.append("")

    L.append("## Participation base\n")
    pb = pop["participationBase"]
    L.append(f"Mean participationBase {pb.mean():.3f}; by age band: " + ", ".join(
        f"{b} {pop.loc[pop.ageBand == b, 'participationBase'].mean():.2f}" for b in AGE_BANDS))
    L.append(f"\nBy tenure: " + ", ".join(f"{t} {pop.loc[pop.tenure == t, 'participationBase'].mean():.2f}" for t in TENURE_FACTOR))
    L.append("")
    L.append("## Groups\n")
    L.append("| Group | Residents | Weighted share |")
    L.append("|---|---:|---:|")
    for g, label, _ in GROUPS:
        m = pop["groupIds"].map(lambda x: g in x).to_numpy()
        L.append(f"| {label} (`{g}`) | {m.sum()} | {pct(w_all[m].sum() / w_all.sum())} % |")
    L.append("")
    L.append("## Names\n")
    notes = pop["nameNote"].value_counts()
    L.append(f"Names parsed from the persona text start. Cleaned/fallback: { {k: int(v) for k, v in notes.items() if k} }.\n")
    L.append("## Method\n")
    L.append(f"- Sampling: {METHOD['sampling']}")
    L.append(f"- Raking: {METHOD['raking']}")
    for m in METHOD["imputation"]:
        L.append(f"- {m}")
    L.append("\n## Sources\n")
    for s in sources():
        L.append(f"- {s['name']}: {s['url']} ({s['license']})")
    for k in INSEE_FILES:
        L.append(f"- Download: {insee_url(k)}")
    for dept, url in GEO_SOURCES.items():
        L.append(f"- Download ({dept}): {url}")
    REPORT_OUT.write_text("\n".join(L), encoding="utf-8")
    print(f"[write] {REPORT_OUT}")


if __name__ == "__main__":
    if "--fetch-only" in sys.argv:
        fetch_personas()
        sys.exit(0)
    build()
    import place_residents

    place_residents.main()
