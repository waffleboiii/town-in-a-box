"""DEV FIXTURES for the simulation engine (not real data).

Creates, in pipeline/out/dev/:
  map.json         a contract-valid MapFile: districts are rough nearest-centroid cells (NOT real borders)
  population.json  ~300 synthetic residents (contract-valid PopulationFile, invented attributes)
  votations.json   ground-truth shaped file with the real city-wide results but
                   INVENTED per-sector numbers (clearly flagged) so the backtest code can run.

The real files are built by other parts of the pipeline (build_map.py, build_population.py,
ground-truth collection). This file only exists so the engine can be developed and tested
before those land. Run:  python pipeline/out/dev/make_fixtures.py
"""
from __future__ import annotations

import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # pipeline/

import numpy as np  # noqa: E402

from common import CONFIG, H, TILE, W, lonlat_to_xy, write_json  # noqa: E402

DEV = Path(__file__).resolve().parent

# (code, name, fullName, dept, lon, lat, population) — approximate centroids, rounded populations.
PARIS = [
    (1, 2.3364, 48.8626, 15900), (2, 2.3428, 48.8683, 21000), (3, 2.3600, 48.8630, 33000),
    (4, 2.3576, 48.8543, 28000), (5, 2.3507, 48.8445, 57000), (6, 2.3327, 48.8491, 40000),
    (7, 2.3122, 48.8562, 48000), (8, 2.3125, 48.8727, 35000), (9, 2.3375, 48.8771, 59000),
    (10, 2.3608, 48.8762, 83000), (11, 2.3800, 48.8591, 142000), (12, 2.3950, 48.8400, 140000),
    (13, 2.3622, 48.8283, 178000), (14, 2.3265, 48.8292, 134000), (15, 2.2928, 48.8401, 228000),
    (16, 2.2760, 48.8600, 162000), (17, 2.3067, 48.8873, 166000), (18, 2.3482, 48.8925, 192000),
    (19, 2.3848, 48.8871, 182000), (20, 2.4011, 48.8634, 192000),
]
SUBURBS = [
    ("92012", "Boulogne-Billancourt", "92", 2.2399, 48.8352, 121000),
    ("92040", "Issy-les-Moulineaux", "92", 2.2620, 48.8240, 68000),
    ("92051", "Neuilly-sur-Seine", "92", 2.2690, 48.8846, 59000),
    ("92044", "Levallois-Perret", "92", 2.2875, 48.8950, 66000),
    ("92024", "Clichy", "92", 2.3060, 48.9045, 63000),
    ("92049", "Montrouge", "92", 2.3160, 48.8160, 50000),
    ("92050", "Nanterre", "92", 2.2070, 48.8925, 96000),
    ("92026", "Courbevoie", "92", 2.2560, 48.8970, 82000),
    ("93066", "Saint-Denis", "93", 2.3580, 48.9360, 113000),
    ("93070", "Saint-Ouen-sur-Seine", "93", 2.3340, 48.9110, 52000),
    ("93001", "Aubervilliers", "93", 2.3830, 48.9140, 88000),
    ("93055", "Pantin", "93", 2.4060, 48.8940, 60000),
    ("93048", "Montreuil", "93", 2.4410, 48.8630, 111000),
    ("93006", "Bagnolet", "93", 2.4180, 48.8690, 36000),
    ("93027", "La Courneuve", "93", 2.3960, 48.9280, 44000),
    ("93008", "Bobigny", "93", 2.4400, 48.9080, 54000),
    ("94080", "Vincennes", "94", 2.4390, 48.8470, 49000),
    ("94041", "Ivry-sur-Seine", "94", 2.3870, 48.8130, 63000),
    ("94081", "Vitry-sur-Seine", "94", 2.3920, 48.7870, 95000),
    ("94028", "Créteil", "94", 2.4550, 48.7900, 92000),
    ("94018", "Charenton-le-Pont", "94", 2.4130, 48.8220, 30000),
    ("94076", "Villejuif", "94", 2.3640, 48.7930, 56000),
]

FIRST_F = ["Camille", "Léa", "Manon", "Inès", "Sarah", "Chloé", "Fatoumata", "Nadia", "Sophie", "Isabelle",
           "Monique", "Françoise", "Aïcha", "Julie", "Emma", "Yasmine", "Claire", "Mei", "Lucie", "Hélène"]
FIRST_M = ["Lucas", "Hugo", "Karim", "Mamadou", "Thomas", "Nicolas", "Pierre", "Jean", "Mehdi", "Antoine",
           "Bernard", "Michel", "Youssef", "Julien", "Paul", "Wei", "Louis", "Rachid", "Marc", "Alain"]
LAST = ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Diallo", "Nguyen", "Benali", "Lefèvre", "Garcia",
        "Petit", "Roux", "Traoré", "Fontaine", "Haddad", "Chevalier", "Rousseau", "Mercier", "Cohen", "Da Silva"]

OCC = [
    ("Cadres et professions intellectuelles supérieures", "cadres", "Managers & professionals"),
    ("Professions intermédiaires", "prof_inter", "Intermediate professions"),
    ("Employés", "employes", "Clerical & service workers"),
    ("Ouvriers", "ouvriers", "Manual workers"),
    ("Artisans, commerçants, chefs d'entreprise", "artisans", "Tradespeople & shopkeepers"),
    ("Retraités", "retraites", "Retired"),
    ("Autres sans activité professionnelle", "sans_activite", "Not in work"),
]
EDU = ["Sans diplôme ou CEP", "Brevet", "CAP ou BEP", "Baccalauréat", "Bac+2", "Bac+3 ou Bac+4", "Bac+5 ou plus"]
HH = [("Personne seule", "single"), ("Couple sans enfant", "couple_no_kids"),
      ("Couple avec enfant(s)", "couple_kids"), ("Famille monoparentale", "single_parent")]
JOBS = {"cadres": "ingénieur·e", "prof_inter": "technicien·ne", "employes": "employé·e de commerce",
        "ouvriers": "ouvrier·ère du bâtiment", "artisans": "artisan·e", "retraites": "retraité·e",
        "sans_activite": "en recherche d'emploi"}
HOBBY = ["la course à pied", "le jardinage", "la cuisine", "le cinéma", "la lecture", "le football",
         "la photographie", "les brocantes", "la musique", "les jeux de société"]


def age_band(a: int) -> str:
    return "18-29" if a < 30 else "30-44" if a < 45 else "45-59" if a < 60 else "60-74" if a < 75 else "75+"


def build_map():
    districts = []
    for n, lon, lat, pop in PARIS:
        name = "1er" if n == 1 else f"{n}e"
        full = "Paris 1er Arrondissement" if n == 1 else f"Paris {n}e Arrondissement"
        sector = "Paris Centre" if n <= 4 else f"{n}e"
        districts.append(dict(code=f"751{n:02d}", name=name, fullName=full, kind="arrondissement", dept="75",
                              sector=sector, lon=lon, lat=lat, population=pop))
    for code, name, dept, lon, lat, pop in SUBURBS:
        districts.append(dict(code=code, name=name, fullName=name, kind="commune", dept=dept,
                              lon=lon, lat=lat, population=pop))
    cx = np.array([lonlat_to_xy(d["lon"], d["lat"])[0] for d in districts])
    cy = np.array([lonlat_to_xy(d["lon"], d["lat"])[1] for d in districts])
    yy, xx = np.mgrid[0:H, 0:W]
    d2 = (xx[..., None] + 0.5 - cx) ** 2 + (yy[..., None] + 0.5 - cy) ** 2
    # Paris cells are smaller: scale distances so arrondissements do not swallow the suburbs.
    scale = np.array([1.6 if d["dept"] == "75" else 1.0 for d in districts])
    nearest = np.argmin(d2 * scale, axis=2)
    mind = np.sqrt(np.min(d2, axis=2))
    grid = np.where(mind < 32, nearest + 1, 0)
    tiles = np.full((H, W), TILE["outside"], dtype=int)
    for i, d in enumerate(districts):
        mask = grid == i + 1
        tiles[mask] = TILE["haussmann"] if d["dept"] == "75" else TILE["suburb_house"]
    district_list = []
    for i, d in enumerate(districts):
        mask = grid == i + 1
        ys, xs = np.nonzero(mask)
        district_list.append({
            "idx": i + 1, "code": d["code"], "name": d["name"], "fullName": d["fullName"], "kind": d["kind"],
            "dept": d["dept"], **({"sector": d["sector"]} if "sector" in d else {}),
            "population": d["population"],
            "centroid": [round(float(cx[i]), 2), round(float(cy[i]), 2)],
            "labelPos": [round(float(cx[i]), 2), round(float(cy[i]), 2)],
            "tileCount": int(mask.sum()),
        })
    landmarks = []
    for lm in CONFIG["landmarks"]:
        x, y = lonlat_to_xy(lm["lon"], lm["lat"])
        landmarks.append({"id": lm["id"], "name": lm["name"], "nameFr": lm["nameFr"], "kind": lm["kind"],
                          "x": round(x, 2), "y": round(y, 2)})
    return {
        "version": 1, "width": W, "height": H, "tilePx": CONFIG["tilePx"], "tileMeters": CONFIG["tileMeters"],
        "bbox": CONFIG["bbox"], "tileTypes": CONFIG["tileTypes"],
        "tiles": tiles.ravel().tolist(), "districts": grid.ravel().tolist(),
        "districtList": district_list, "landmarks": landmarks,
        "sources": [{"name": "DEV FIXTURE — approximate centroids, not real borders", "url": "", "license": "n/a"}],
    }, grid


def build_population(map_file, grid, n=300, seed=7):
    rng = random.Random(seed)
    dl = map_file["districtList"]
    pops = [d["population"] for d in dl]
    cells = {d["idx"]: list(zip(*np.nonzero(grid == d["idx"]))) for d in dl}
    paris_idx = [d["idx"] for d in dl if d["dept"] == "75"]
    residents = []
    for i in range(n):
        d = rng.choices(dl, weights=pops)[0]
        paris = d["dept"] == "75"
        sex = rng.choice(["F", "M"])
        age = int(min(95, max(18, rng.gauss(46, 18))))
        if age >= 64 and rng.random() < 0.85:
            occ = OCC[5]
        else:
            w = [0.32, 0.24, 0.22, 0.08, 0.05, 0.0, 0.09] if paris else [0.17, 0.25, 0.28, 0.16, 0.05, 0.0, 0.09]
            occ = rng.choices(OCC, weights=w)[0]
        edu_rank = min(6, max(0, int(rng.gauss(4.2 if paris else 3.2, 1.6))))
        if occ[1] == "cadres":
            edu_rank = max(edu_rank, 5)
        hh = rng.choices(HH, weights=[0.5, 0.2, 0.22, 0.08] if paris else [0.35, 0.22, 0.32, 0.11])[0]
        y, x = rng.choice(cells[d["idx"]])
        home = [int(x), int(y)]
        working = occ[1] not in ("retraites", "sans_activite")
        work, work_idx = None, None
        if working:
            if paris or rng.random() < 0.45:
                wd = rng.choice([p for p in paris_idx for _ in range(3 if p in (1, 2, 8, 9, 15, 17) else 1)])
            else:
                wd = rng.choice([q["idx"] for q in dl if q["dept"] != "75"])
            wy, wx = rng.choice(cells[wd])
            work, work_idx = [int(wx), int(wy)], wd
        car = rng.random() < (0.33 if paris else 0.62) * (1.3 if hh[1] == "couple_kids" else 1.0)
        heavy = car and rng.random() < (0.35 if occ[1] in ("cadres", "artisans") else 0.22)
        if not working:
            mode = "none"
        elif car and rng.random() < (0.25 if paris else 0.55):
            mode = "car"
        else:
            mode = rng.choices(["metro", "rer", "bus", "bike", "walk"],
                               weights=[0.5, 0.12, 0.12, 0.12, 0.14] if paris else [0.3, 0.4, 0.2, 0.05, 0.05])[0]
        social = 0.18 if paris else (0.36 if d["dept"] == "93" else 0.25)
        owner = 0.33 if paris else 0.42
        tenure = rng.choices(["owner", "private_renter", "social_renter"],
                             weights=[owner, 1 - owner - social, social])[0]
        non_eu = 0.10 if paris else (0.22 if d["dept"] == "93" else 0.10)
        nat = rng.choices(["french", "eu", "non_eu"], weights=[1 - non_eu - 0.05, 0.05, non_eu])[0]
        eligible = paris and nat != "non_eu" and rng.random() < 0.9
        z = -0.4 + 0.035 * (age - 45) + 0.25 * (edu_rank - 3) + (0.4 if tenure == "owner" else 0) \
            - (0.4 if tenure == "social_renter" else 0) - (0.5 if nat != "french" else 0)
        base = 1 / (1 + math.exp(-z))
        first = rng.choice(FIRST_F if sex == "F" else FIRST_M)
        name = f"{first} {rng.choice(LAST)}"
        persona = (f"{name}, {age} ans, {JOBS[occ[1]]} vivant {('dans le ' + d['name']) if paris else ('à ' + d['name'])}, "
                   f"aime {rng.choice(HOBBY)} et {rng.choice(HOBBY)}.")
        groups = []
        if age < 35 and tenure != "owner":
            groups.append("young_renters")
        if age >= 75:
            groups.append("seniors_75")
        if hh[1] in ("couple_kids", "single_parent"):
            groups.append("families")
        if tenure == "social_renter":
            groups.append("social_housing")
        if nat == "non_eu":
            groups.append("non_eu_residents")
        if not paris and work_idx in paris_idx:
            groups.append("suburb_commuters")
        if heavy:
            groups.append("heavy_car_owners")
        if occ[1] in ("ouvriers", "employes"):
            groups.append("service_workers")
        if occ[1] == "cadres":
            groups.append("cadres")
        residents.append({
            "id": i, "uuid": f"fixture-{i:04d}", "name": name, "sex": sex, "age": age, "ageBand": age_band(age),
            "occupation": occ[0], "occupationGroup": occ[1], "occupationEn": occ[2],
            "education": EDU[edu_rank], "educationRank": edu_rank,
            "household": hh[1], "householdRaw": hh[0],
            "maritalStatus": "Marié(e)" if hh[1].startswith("couple") else "Célibataire",
            "districtIdx": d["idx"], "districtSource": "dataset" if rng.random() < 0.6 else "imputed",
            "home": home, "work": work, "workDistrictIdx": work_idx, "commuteMode": mode,
            "imputed": {"car": car, "heavyCar": heavy, "tenure": tenure, "nationality": nat},
            "eligibleParis": eligible, "participationBase": round(base, 3),
            "weight": round(math.exp(rng.gauss(0, 0.3)), 3), "groupIds": groups,
            "personaFr": persona, "personaEn": "",
            "look": {"skin": rng.randrange(6), "hair": rng.randrange(8), "hairStyle": rng.randrange(6),
                     "shirt": rng.randrange(12), "pants": rng.randrange(6), "accessory": rng.randrange(5)},
        })
    mean_w = sum(r["weight"] for r in residents) / n
    for r in residents:
        r["weight"] = round(r["weight"] / mean_w, 3)
    groups = [
        {"id": "young_renters", "label": "Young renters (18-34)", "description": "Aged 18-34 and renting (tenure imputed)."},
        {"id": "seniors_75", "label": "Seniors 75+", "description": "Aged 75 or more."},
        {"id": "families", "label": "Families with children", "description": "Household with children."},
        {"id": "social_housing", "label": "Social-housing tenants", "description": "Social renters (tenure imputed)."},
        {"id": "non_eu_residents", "label": "Non-EU residents", "description": "Non-EU nationality (imputed): cannot vote in Paris votations."},
        {"id": "suburb_commuters", "label": "Suburban commuters into Paris", "description": "Live in 92/93/94, work in Paris (workplace imputed)."},
        {"id": "heavy_car_owners", "label": "Heavy-car owners", "description": "Own a car above the SUV-fee weight limits (imputed)."},
        {"id": "service_workers", "label": "Service & manual workers", "description": "Employés and ouvriers (dataset occupation)."},
        {"id": "cadres", "label": "Managers & professionals", "description": "Cadres (dataset occupation)."},
    ]
    return {
        "version": 1, "generatedAt": datetime.now(timezone.utc).isoformat(), "count": n,
        "residents": residents, "groups": groups,
        "method": {"sampling": "DEV FIXTURE — random synthetic residents, not the NVIDIA dataset",
                   "raking": "DEV FIXTURE — random weights normalised to mean 1",
                   "imputation": ["DEV FIXTURE — all attributes invented"],
                   "knownDatasetIssues": ["DEV FIXTURE"]},
        "sources": [{"name": "DEV FIXTURE", "url": "", "license": "n/a"}],
    }


def build_votations():
    """Real city-wide results; INVENTED per-sector values (deterministic) for code testing only."""
    sectors = ["Paris Centre"] + [f"{n}e" for n in range(5, 21)]
    rng = random.Random(11)

    def fake(yes, spread):
        return [{"sector": s, "yesShare": round(min(0.98, max(0.02, yes + rng.uniform(-spread, spread))), 4),
                 "turnout": round(rng.uniform(0.04, 0.09), 4)} for s in sectors]

    return {
        "_comment": "DEV FIXTURE. City-wide figures are the official ones; per-sector numbers are INVENTED.",
        "votations": [
            {"id": "paris_scooters_2023", "date": "2023-04-02",
             "question": "Pour ou contre les trottinettes en libre-service ?",
             "result": {"yesShare": 0.1097, "turnout": 0.0746},
             "bySector": fake(0.11, 0.04), "fixture": True,
             "sources": [{"name": "DEV FIXTURE", "url": ""}]},
            {"id": "paris_suv_2024", "date": "2024-02-04",
             "question": "Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures individuelles lourdes, encombrantes, polluantes ?",
             "result": {"yesShare": 0.5455, "turnout": 0.0568},
             "bySector": fake(0.55, 0.12), "fixture": True,
             "sources": [{"name": "DEV FIXTURE", "url": ""}]},
        ],
    }


def main(n: int = 300):
    map_file, grid = build_map()
    write_json(DEV / "map.json", map_file)
    write_json(DEV / "population.json", build_population(map_file, grid, n=n))
    write_json(DEV / "votations.json", build_votations(), compact=False)
    print(f"fixtures written to {DEV} (n={n})")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
