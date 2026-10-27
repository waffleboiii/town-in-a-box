"""Exposure: what a proposal concretely changes for one resident.

This is COMPUTED with fixed, explainable rules from geography (home, workplace, distance to a
site) and the resident's attributes. Some attributes are IMPUTED from INSEE statistics because
the NVIDIA dataset does not have them (car, heavy car, tenure, nationality, workplace); every
text says "(imputed)" where it relies on them. The LLM never decides exposure — it only reads
these facts and writes a reaction.

Output per resident (web/src/types.ts ResidentResult.exposure):
    {"score": 0..3, "reasons": [{"code", "text" (English), "icon", "at"?}]}
Internally each reason also carries "fr" (French text for the prompt); it is removed before writing.

Score meaning: 0 = nothing changes, 1 = minor/indirect, 2 = clear everyday effect, 3 = major effect.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from llm import hash01


# ---------------------------------------------------------------------------
# Geography context
# ---------------------------------------------------------------------------

@dataclass
class GeoContext:
    districts: dict[int, dict]  # idx -> District
    grid: list[int] | None  # MapFile.districts (row-major) or None
    width: int
    height: int

    @classmethod
    def from_map(cls, m: dict) -> "GeoContext":
        return cls({d["idx"]: d for d in m["districtList"]}, m.get("districts"), m["width"], m["height"])

    def district_at(self, x: float, y: float) -> int:
        if not self.grid:
            return 0
        xi, yi = int(math.floor(x)), int(math.floor(y))
        if 0 <= xi < self.width and 0 <= yi < self.height:
            return self.grid[yi * self.width + xi]
        return 0

    def is_paris(self, idx: int | None) -> bool:
        return bool(idx) and self.districts.get(idx, {}).get("dept") == "75"

    def arr_number(self, idx: int | None) -> int | None:
        d = self.districts.get(idx or 0)
        if not d or d.get("dept") != "75":
            return None
        m = re.search(r"751(\d\d)$", str(d.get("code", "")))
        if m:
            return int(m.group(1))
        m = re.match(r"(\d+)", str(d.get("name", "")))
        return int(m.group(1)) if m else None

    @property
    def paris_idxs(self) -> list[int]:
        return sorted(i for i, d in self.districts.items() if d.get("dept") == "75")


def _ord_en(n: int) -> str:
    return f"{n}{'st' if n == 1 else 'nd' if n == 2 else 'rd' if n == 3 else 'th'}"


def place(ctx: GeoContext, idx: int | None) -> dict:
    """Ways to say 'in/from <district>' in French and English."""
    d = ctx.districts.get(idx or 0)
    n = ctx.arr_number(idx)
    if n is not None:
        fr = "1er" if n == 1 else f"{n}e"
        return {"in_fr": f"dans le {fr}", "from_fr": f"depuis le {fr}", "of_fr": f"du {fr}", "name_fr": f"le {fr}",
                "in_en": f"in the {_ord_en(n)} arrondissement", "from_en": f"from the {_ord_en(n)}", "name_en": f"the {_ord_en(n)}"}
    name = (d or {}).get("name") or "Paris"
    de = "d'" if name[:1].lower() in "aeiouyéèêiîô" else "de "
    return {"in_fr": f"à {name}", "from_fr": f"depuis {name}", "of_fr": f"{de}{name}", "name_fr": name,
            "in_en": f"in {name}", "from_en": f"from {name}", "name_en": name}


def dist_text(m: float) -> tuple[str, str]:
    if m < 950:
        v = int(round(m / 50.0) * 50) or 50
        return f"{v} m", f"{v} m"
    km = m / 1000.0
    return f"{km:.1f} km".replace(".", ","), f"{km:.1f} km"


def template_words(r: dict, ctx: GeoContext, sdef, exposure: dict | None = None) -> dict:
    """Placeholder values for the mock reason templates in scenarios.py."""
    h = place(ctx, r["districtIdx"])
    w = place(ctx, r.get("workDistrictIdx")) if r.get("workDistrictIdx") else None
    words = {
        "in_fr": h["in_fr"], "in_fr_cap": h["in_fr"][:1].upper() + h["in_fr"][1:], "from_fr": h["from_fr"],
        "of_home_fr": h["of_fr"], "home_fr": h["name_fr"],
        "in_en": h["in_en"], "in_en_cap": h["in_en"][:1].upper() + h["in_en"][1:], "from_en": h["from_en"],
        "home_en": h["name_en"],
        "work_place_fr": w["in_fr"] if w else "à Paris", "work_place_en": w["in_en"] if w else "in Paris",
        "trip_fr": f"aller travailler {w['in_fr']}" if w else "mes petits trajets",
        "trip_en": f"get to work {w['in_en']}" if w else "make short trips",
        "rate": "12", "commune": h["name_fr"], "dist_fr": "quelques kilomètres", "dist_en": "a few kilometres",
    }
    if sdef.id == "paris_suv_2024" and r.get("workDistrictIdx"):
        n = ctx.arr_number(r["workDistrictIdx"])
        words["rate"] = "18" if n and n <= 11 else "12"
    if sdef.site:
        dm = math.hypot(r["home"][0] + 0.5 - sdef.site["x"], r["home"][1] + 0.5 - sdef.site["y"]) * 100
        words["dist_fr"], words["dist_en"] = dist_text(dm)
        host = ctx.district_at(sdef.site["x"], sdef.site["y"])
        words["commune"] = (ctx.districts.get(host) or {}).get("name", "la commune")
    return words


def _reason(code, en, fr, icon, at=None):
    out = {"code": code, "text": en, "fr": fr, "icon": icon}
    if at:
        out["at"] = [[int(a[0]), int(a[1])] for a in at]
    return out


# ---------------------------------------------------------------------------
# SUV parking fee (Paris votation, 4 Feb 2024)
# ---------------------------------------------------------------------------

def _rate(ctx: GeoContext, idx) -> int:
    n = ctx.arr_number(idx)
    return 18 if n is not None and n <= 11 else 12


def exposure_suv(r: dict, ctx: GeoContext, sdef) -> dict:
    imp = r["imputed"]
    home_paris = ctx.is_paris(r["districtIdx"])
    work_idx = r.get("workDistrictIdx")
    work_paris = ctx.is_paris(work_idx)
    h = place(ctx, r["districtIdx"])
    w = place(ctx, work_idx) if work_idx else None
    reasons, score = [], 0
    if imp["heavyCar"] and not home_paris:
        if r["commuteMode"] == "car" and work_paris:
            rate = _rate(ctx, work_idx)
            reasons.append(_reason(
                "suv_visitor_pays_commute",
                f"Drives a heavy car (imputed) to work {w['in_en']}: street parking there would cost €{rate}/h, about 3× today. Lives outside Paris, so cannot vote on it.",
                f"Tu vas travailler en voiture lourde {w['in_fr']} : s'y garer dans la rue coûterait {rate} €/h, environ 3 fois plus qu'aujourd'hui. Tu habites hors de Paris, tu ne peux donc pas voter.",
                "money", [r["work"]] if r.get("work") else None))
            score = 3
        else:
            reasons.append(_reason(
                "suv_visitor_pays_occasional",
                "Owns a heavy car (imputed) and lives outside Paris: would pay €12–18/h for street parking on visits to Paris, and cannot vote on it.",
                "Tu as une voiture lourde et tu habites hors de Paris : tu paierais 12 à 18 €/h pour te garer dans la rue lors de tes passages à Paris, sans pouvoir voter.",
                "car"))
            score = 2 if work_paris else 1
    elif imp["heavyCar"] and home_paris:
        reasons.append(_reason(
            "suv_resident_exempt_home",
            f"Owns a heavy car (imputed) but lives {h['in_en']}: exempt when parking in their own residential zone.",
            f"Tu as une voiture lourde mais tu habites {h['in_fr']} : tu restes exempté·e quand tu te gares dans ta zone résidentielle.",
            "home", [r["home"]]))
        if r["commuteMode"] == "car" and work_paris and work_idx != r["districtIdx"]:
            rate = _rate(ctx, work_idx)
            reasons.append(_reason(
                "suv_resident_pays_elsewhere",
                f"Drives to work {w['in_en']}: outside the home zone, street parking would cost €{rate}/h.",
                f"Tu vas travailler en voiture {w['in_fr']} : hors de ta zone résidentielle, te garer dans la rue coûterait {rate} €/h.",
                "money", [r["work"]] if r.get("work") else None))
            score = 3
        else:
            reasons.append(_reason(
                "suv_resident_pays_elsewhere",
                "Would pay €12–18/h when parking on the street in other arrondissements (visits, shopping).",
                "Tu paierais 12 à 18 €/h pour te garer dans la rue dans les autres arrondissements (visites, courses).",
                "money"))
            score = 2
    elif imp["car"]:
        reasons.append(_reason(
            "suv_light_car",
            "Owns a car under the weight limits (imputed): parking prices unchanged.",
            "Ta voiture est sous les seuils de poids : tes tarifs de stationnement ne changent pas.",
            "car"))
        score = 1 if (home_paris or work_paris) else 0
    elif home_paris:
        reasons.append(_reason(
            "suv_car_free_benefit",
            f"No car (imputed): pays nothing; fewer large cars parked {h['in_en']} could mean more street space and cleaner air.",
            f"Tu n'as pas de voiture : tu ne paies rien ; moins de grosses voitures garées {h['in_fr']}, c'est plus de place et un air plus propre.",
            "walk"))
        score = 1
    else:
        reasons.append(_reason(
            "suv_no_car_suburb",
            "No car (imputed) and lives outside Paris: no direct effect.",
            "Tu n'as pas de voiture et tu habites hors de Paris : aucun effet direct.",
            "none"))
        score = 0
    if r["occupationGroup"] == "artisans" and imp["car"]:
        reasons.append(_reason(
            "suv_artisan_exempt",
            "Tradespeople with a professional parking card are exempt under the proposed rules.",
            "Les artisans et professionnels munis d'une carte professionnelle sont exemptés selon les règles proposées.",
            "money"))
        score = max(0, score - 1)
    return {"score": score, "reasons": reasons}


# ---------------------------------------------------------------------------
# Rental e-scooters (Paris votation, 2 Apr 2023)
# ---------------------------------------------------------------------------

USER_BASE = {"18-29": 0.16, "30-44": 0.08, "45-59": 0.03, "60-74": 0.01, "75+": 0.002}


def scooter_user_probability(r: dict, ctx: GeoContext) -> float:
    """Imputed probability of being a rental e-scooter user (fixed, documented assumptions:
    strongly age-graded, higher in dense central Paris, lower for car commuters and for people
    who neither live nor work in Paris, where these scooters were not operated)."""
    p = USER_BASE.get(r["ageBand"], 0.02)
    home_paris = ctx.is_paris(r["districtIdx"])
    work_paris = ctx.is_paris(r.get("workDistrictIdx"))
    n = ctx.arr_number(r["districtIdx"])
    if home_paris and n is not None and n <= 11:
        p *= 1.5
    if not home_paris:
        p *= 0.6 if work_paris else 0.25
    if r["commuteMode"] in ("metro", "bike", "walk", "bus") and work_paris:
        p *= 1.3
    if r["commuteMode"] == "car":
        p *= 0.5
    return min(0.6, p)


def exposure_scooters(r: dict, ctx: GeoContext, sdef) -> dict:
    home_paris = ctx.is_paris(r["districtIdx"])
    work_idx = r.get("workDistrictIdx")
    work_paris = ctx.is_paris(work_idx)
    h = place(ctx, r["districtIdx"])
    w = place(ctx, work_idx) if work_idx else None
    n = ctx.arr_number(r["districtIdx"])
    p = scooter_user_probability(r, ctx)
    user = hash01("scooter_user", r.get("uuid", r["id"])) < p
    reasons, score = [], 0
    if user:
        to_work_en = f", e.g. to get to work {w['in_en']}" if work_paris else ""
        to_work_fr = f", par exemple pour aller travailler {w['in_fr']}" if work_paris else ""
        at = [r["home"]] + ([r["work"]] if r.get("work") and work_paris else [])
        reasons.append(_reason(
            "scooter_user",
            f"Likely rental e-scooter user (imputed: {p:.0%} chance for this profile): removing them takes away a quick way to get around{to_work_en}.",
            f"Tu utilises les trottinettes en libre-service : les supprimer t'enlève un moyen rapide de te déplacer{to_work_fr}.",
            "scooter", at))
        score = 2
    if home_paris and n is not None and n <= 11:
        senior_or_walker = r["age"] >= 75 or r["commuteMode"] == "walk"
        reasons.append(_reason(
            "scooter_pavement_central",
            f"Lives in dense central Paris ({h['name_en']}): scooters parked and ridden on narrow pavements are a daily nuisance.",
            f"Tu habites le centre dense de Paris ({h['name_fr']}) : les trottinettes garées ou qui roulent sur des trottoirs étroits sont une gêne quotidienne.",
            "walk", [r["home"]]))
        score = max(score, 2 if senior_or_walker else 1)
    elif home_paris:
        reasons.append(_reason(
            "scooter_city_life",
            f"Sees rental e-scooters in the streets {h['in_en']}: a minor nuisance or an occasional option.",
            f"Tu croises des trottinettes en libre-service dans les rues {h['in_fr']} : une petite gêne ou une solution occasionnelle.",
            "scooter"))
        score = max(score, 1)
    if home_paris and r["age"] >= 75:
        reasons.append(_reason(
            "scooter_senior_risk",
            "Aged 75 or over: more exposed to the risk of a collision with a scooter on the pavement.",
            "Tu as 75 ans ou plus : tu es plus exposé·e au risque de collision avec une trottinette sur le trottoir.",
            "walk"))
        score = max(score, 2)
    if not home_paris and not user:
        if work_paris:
            reasons.append(_reason(
                "scooter_commuter_sees",
                f"Lives outside Paris but works {w['in_en']}: sees the scooters around work; cannot vote on them.",
                f"Tu habites hors de Paris mais tu travailles {w['in_fr']} : tu vois les trottinettes près du travail ; tu ne peux pas voter.",
                "scooter", [r["work"]] if r.get("work") else None))
            score = max(score, 1)
        else:
            reasons.append(_reason(
                "scooter_outside",
                f"The vote only covers Paris; little direct effect for someone living {h['in_en']}.",
                f"Le vote ne concerne que Paris ; peu d'effet direct pour toi qui habites {h['in_fr']}.",
                "none"))
    return {"score": min(3, score), "reasons": reasons}


# ---------------------------------------------------------------------------
# AI data centre (hypothetical, Seine-Saint-Denis)
# ---------------------------------------------------------------------------

JOB_GROUPS = {"ouvriers", "prof_inter", "employes"}


def _num_en(v) -> str:
    return f"{int(v):,}" if str(v).isdigit() else str(v)


def _num_fr(v) -> str:
    return f"{int(v):,}".replace(",", " ") if str(v).isdigit() else str(v)


def exposure_datacenter(r: dict, ctx: GeoContext, sdef) -> dict:
    """Rings around the site (default 0.5 / 1 / 2 km) plus who the project hires, taxes and heats.
    Facts (years, generators, heat, jobs, taxes) come from datacenter_context.json via sdef.facts."""
    f = sdef.facts
    site = sdef.site
    sx, sy = site["x"], site["y"]
    st = [int(sx), int(sy)]
    d_tiles = math.hypot(r["home"][0] + 0.5 - sx, r["home"][1] + 0.5 - sy)
    dfr, den = dist_text(d_tiles * 100)
    rings = site.get("ringsTiles", [5, 10, 20])
    host = ctx.district_at(sx, sy)
    host_name = (ctx.districts.get(host) or {}).get("name", "the host town")
    dept = (ctx.districts.get(r["districtIdx"]) or {}).get("dept")
    yrs = f.get("constructionYears", 2.5)
    yrs_fr = str(yrs).replace(".", ",")
    ring2_km = f"{rings[2] * 100 / 1000:.0f}"
    reasons, score = [], 0
    if d_tiles <= rings[0]:
        reasons.append(_reason(
            "dc_construction_near",
            f"Lives {den} from the site: about {yrs} years of construction noise and trucks, then a permanent hum from cooling units.",
            f"Tu habites à {dfr} du site : environ {yrs_fr} ans de bruit de chantier et de camions, puis le bourdonnement permanent des refroidisseurs.",
            "construction", [st]))
        score = 3
    elif d_tiles <= rings[1]:
        reasons.append(_reason(
            "dc_construction_traffic",
            f"Lives {den} from the site: construction trucks on local roads for about {yrs} years.",
            f"Tu habites à {dfr} du site : des camions de chantier sur les routes du quartier pendant environ {yrs_fr} ans.",
            "noise", [st]))
        score = 2
    if d_tiles <= rings[1] and f.get("generators"):
        reasons.append(_reason(
            "dc_generators",
            f"About {_num_en(f['generators'])} backup generators on the site would be test-run every month, {den} from home: noise and exhaust on test days.",
            f"Une centaine de groupes électrogènes de secours seraient testés chaque mois sur le site, à {dfr} de chez toi : bruit et fumées les jours d'essai.",
            "noise", [st]))
    if d_tiles <= rings[2]:
        if f.get("heatMW") and f.get("homesHeated"):
            en = (f"Within about {ring2_km} km of the site: homes here could join the district-heating network that would get up to "
                  f"{f['heatMW']} MW of waste heat (about {_num_en(f['homesHeated'])} homes).")
            fr = (f"Tu habites à moins de {ring2_km} km du site : ton logement pourrait être raccordé au réseau de chauffage urbain "
                  f"qui recevrait jusqu'à {f['heatMW']} MW de chaleur récupérée (environ {_num_fr(f['homesHeated'])} logements).")
        else:
            en = f"Within about {ring2_km} km of the site: homes here could be connected to a heating network fed by the data centre's waste heat."
            fr = f"Tu habites à moins de {ring2_km} km du site : ton logement pourrait être raccordé à un réseau de chaleur alimenté par la chaleur récupérée."
        reasons.append(_reason("dc_heat_network", en, fr, "heat", [st]))
        reasons.append(_reason(
            "dc_grid_works",
            f"Within about {ring2_km} km: new underground high-voltage lines would be dug under streets towards nearby substations — possibly months of street works near home.",
            f"Tu habites à moins de {ring2_km} km : de nouvelles lignes électriques souterraines à haute tension seraient creusées sous la voirie vers les postes voisins — peut-être des mois de travaux près de chez toi.",
            "power"))
        score = max(score, 1)
    working_age = r["age"] < 60 and r["occupationGroup"] in JOB_GROUPS
    if working_age and (dept == "93" or d_tiles <= 30):
        jobs = f.get("jobsConstruction", 1000)
        perm_en = f.get("jobsPermanentEn", "100–150")
        reasons.append(_reason(
            "dc_local_jobs",
            f"Works in a kind of job the project hires for ({r.get('occupationEn', r['occupationGroup'])}) and lives {den} away: about {_num_en(jobs)} construction jobs at the peak, {perm_en} permanent.",
            f"Ton métier fait partie de ceux que le projet recrute et tu habites à {dfr} : environ {_num_fr(jobs)} emplois au pic du chantier et {f.get('jobsPermanent', '100 à 150')} emplois permanents.",
            "job", [st]))
        score = min(3, max(score, 1) + (1 if score >= 1 else 0))
    if host and r["districtIdx"] == host:
        tax = f.get("localTaxEurPerYear")
        tax_en = f" (estimated €{str(tax).replace('-', '–').replace(' million', ' M')} a year)" if tax else ""
        tax_fr = ""
        if tax:
            m = re.match(r"\s*([\d.,]+)\s*-\s*([\d.,]+)\s*million", str(tax))
            tax_fr = (f" (estimées entre {m.group(1)} et {m.group(2)} millions d'euros par an)" if m
                      else f" (estimées à {tax})")
        reasons.append(_reason(
            "dc_host_tax",
            f"Lives in the host town ({host_name}): it would collect new local business-tax revenue{tax_en}.",
            f"Tu habites la commune d'accueil ({host_name}) : elle percevrait de nouvelles recettes fiscales{tax_fr}.",
            "tax"))
        score = max(score, 1)
    if dept == "93" and r["age"] < 35 and r["imputed"]["tenure"] != "owner":
        reasons.append(_reason(
            "dc_housing_land",
            "Young renter in Seine-Saint-Denis (tenure imputed): more exposed to how big new infrastructure changes local land use and rents.",
            "Tu es jeune et locataire en Seine-Saint-Denis : tu es plus exposé·e à la façon dont les grands projets changent l'usage des terrains et les loyers du coin.",
            "home"))
        score = max(score, 1)
    if dept == "93" and d_tiles > rings[2]:
        reasons.append(_reason(
            "dc_cluster_93",
            "Lives in Seine-Saint-Denis, already the French département with the most data-centre electricity use (0.8 TWh in 2024, Enedis): this would add to a local cluster.",
            "Tu habites en Seine-Saint-Denis, déjà le département français où les centres de données consomment le plus d'électricité (0,8 TWh en 2024, Enedis) : ce projet s'ajouterait à une forte concentration locale.",
            "power"))
        score = max(score, 1)
    if not reasons or score == 0:
        gwh = f.get("annualElectricityGWh")
        en_e = f" (about {_num_en(gwh)} GWh of electricity a year)" if gwh else ""
        fr_e = f" (environ {_num_fr(gwh)} GWh d'électricité par an)" if gwh else ""
        reasons.append(_reason(
            "dc_grid_water",
            f"Lives {den} from the site: no direct local effect; only region-wide questions about electricity demand{en_e} and the grid.",
            f"Tu habites à {dfr} du site : pas d'effet local direct ; seulement les questions générales de consommation d'électricité{fr_e} et de réseau.",
            "power"))
    return {"score": min(3, score), "reasons": reasons}


RULES = {
    "paris_suv_2024": exposure_suv,
    "paris_scooters_2023": exposure_scooters,
    "saint_denis_datacenter": exposure_datacenter,
}


def compute_exposure(r: dict, ctx: GeoContext, sdef) -> dict:
    return RULES[sdef.id](r, ctx, sdef)


def public_exposure(exp: dict) -> dict:
    """Strip internal fields (French prompt text) so the output matches the contract exactly."""
    return {"score": exp["score"], "reasons": [{k: v for k, v in x.items() if k != "fr"} for x in exp["reasons"]]}


def exposure_prompt_text(exp: dict, eligible: bool, sdef, lives_in_paris: bool = True) -> str:
    """The facts block given to the model (French)."""
    lines = [f"Impact calculé pour toi : {exp['score']}/3"]
    lines += [f"- {x['fr']}" for x in exp["reasons"]]
    already_said = any("ne peux" in x["fr"] for x in exp["reasons"])
    if sdef.voterScope == "paris_eligible" and not eligible and not already_said:
        if lives_in_paris:
            lines.append("- Tu n'es pas inscrit·e sur les listes électorales parisiennes : tu ne peux pas voter à cette votation.")
        else:
            lines.append("- Tu n'habites pas à Paris : tu ne peux pas voter à cette votation.")
    return "\n".join(lines)
