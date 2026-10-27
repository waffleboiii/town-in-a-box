"""The three scenarios: what residents are shown, who can take part, and how the result is checked.

- paris_suv_2024          BACKTEST  Paris votation, 4 Feb 2024: special parking fee for heavy cars (SUVs).
- paris_scooters_2023     BACKTEST  Paris votation, 2 Apr 2023: keep or remove rental e-scooters.
- saint_denis_datacenter  HYPOTHETICAL  A large AI data centre on a brownfield in Seine-Saint-Denis.

Official question wording, rules and results come from pipeline/data/ground_truth/votations.json
and the data-centre facts from datacenter_context.json when those files exist; otherwise the
careful defaults written below are used (and flagged in the scenario notes).

This file also holds the MOCK heuristics used when there is no API key: a stance prior per
exposure code and French/English reason templates. They only exist so the app can be built and
demoed before the key arrives. Mock texts start with "[démo] " / "[demo] ".
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from common import GROUND_TRUTH, lonlat_to_xy, read_json
from llm import MOCK_EN, MOCK_FR, seeded_rng

# ---------------------------------------------------------------------------
# Ground truth loading (tolerant of a few possible file layouts)
# ---------------------------------------------------------------------------

PARIS_CENTRE_ARRS = {1, 2, 3, 4}


def normalise_sector(name) -> str | None:
    """'Paris 11e Arrondissement' / '11' / '75111' / '11e' -> '11e'; 1er..4e / 'Centre' -> 'Paris Centre'."""
    if name is None:
        return None
    s = str(name).strip()
    if "centre" in s.lower():
        return "Paris Centre"
    m = re.search(r"751(\d\d)$", s)
    n = int(m.group(1)) if m else None
    if n is None:
        m = re.search(r"(\d{1,2})\s*(?:er|e|ème|eme)?\b", s)
        n = int(m.group(1)) if m else None
    if n is None or not 1 <= n <= 20:
        return None
    return "Paris Centre" if n in PARIS_CENTRE_ARRS else f"{n}e"


def _num(v):
    """Accept 0.5455, 54.55 or '54,55 %' and return a 0..1 share."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.replace("%", "").replace(",", ".").strip()
        try:
            v = float(v)
        except ValueError:
            return None
    v = float(v)
    return v / 100.0 if v > 1.0 else v


def _first(d: dict, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return default


def _yes_from(d: dict):
    """Find a yes ('Pour') share in a result-like dict."""
    if not isinstance(d, dict):
        return None
    v = _first(d, "yesShare", "yes_share", "pourShare", "pour_share", "pour", "Pour", "yes", "pourPct")
    if isinstance(v, dict):  # e.g. {"votes": 123, "share": 0.5}
        v = _first(v, "share", "pct", "percent")
    if v is None:
        pour = _first(d, "pourVotes", "votesPour", "pour_votes")
        contre = _first(d, "contreVotes", "votesContre", "contre_votes")
        if pour is not None and contre is not None and (pour + contre) > 0:
            return pour / (pour + contre)
        c = _first(d, "contreShare", "contre_share", "contre", "Contre", "no")
        if c is not None and not isinstance(c, dict):
            return 1 - _num(c)
    return _num(v) if v is not None else None


def _turnout_from(d: dict):
    v = _first(d, "turnout", "participation", "turnoutShare", "participationRate")
    if isinstance(v, dict):
        v = _first(v, "share", "rate")
    return _num(v)


def _find_vote(raw, vote_id: str, date: str, keyword: str):
    """Locate one vote in an unknown layout: dict keyed by id, list under 'votations', etc."""
    cands = []
    if isinstance(raw, dict):
        if vote_id in raw:
            return raw[vote_id]
        for k, v in raw.items():
            if isinstance(v, list):
                cands += [x for x in v if isinstance(x, dict)]
            elif isinstance(v, dict):
                cands.append({**v, "_key": k})
    elif isinstance(raw, list):
        cands = [x for x in raw if isinstance(x, dict)]
    for c in cands:
        blob = json.dumps({k: c.get(k) for k in ("id", "_key", "date", "name", "voteName", "question", "title")},
                          ensure_ascii=False).lower()
        if vote_id in blob or date in blob or keyword in blob:
            return c
    return None


def load_vote(vote_id: str, date: str, keyword: str, path: Path | None = None) -> dict | None:
    """Return a normalised ground-truth dict for one vote, or None if unavailable."""
    p = path or (GROUND_TRUTH / "votations.json")
    if not p.exists():
        return None
    raw = read_json(p)
    v = _find_vote(raw, vote_id, date, keyword)
    if not v:
        return None
    result = _first(v, "result", "results", "overall", "actual", default=v)
    yes = _yes_from(result) if isinstance(result, dict) else None
    if yes is None:
        yes = _yes_from(v)
    turnout = _turnout_from(result) if isinstance(result, dict) else None
    if turnout is None:
        turnout = _turnout_from(v)
    sectors_raw = _first(v, "bySector", "sectors", "by_sector", "byArrondissement", "arrondissements", "bySecteur", default=[])
    if isinstance(sectors_raw, dict):
        sectors_raw = [{"sector": k, **(val if isinstance(val, dict) else {"yesShare": val})} for k, val in sectors_raw.items()]
    # Aggregate to votation sectors (1er-4e -> Paris Centre), weighting by votes when present.
    acc: dict[str, list] = {}
    for s in sectors_raw or []:
        if not isinstance(s, dict):
            continue
        name = normalise_sector(_first(s, "sector", "secteur", "name", "arrondissement", "code", "label"))
        y = _yes_from(s)
        if name is None or y is None:
            continue
        w = _first(s, "expressed", "exprimes", "votes", "voters", "votants", default=1) or 1
        acc.setdefault(name, []).append((y, float(w), _turnout_from(s)))
    by_sector = {}
    for name, rows in acc.items():
        tw = sum(w for _, w, _ in rows)
        turn = [t for _, _, t in rows if t is not None]
        by_sector[name] = {"yes": sum(y * w for y, w, _ in rows) / tw,
                           "turnout": (sum(turn) / len(turn)) if turn else None}
    poll = _first(v, "poll", "polls")
    if isinstance(poll, list):
        poll = poll[0] if poll else None
    if isinstance(poll, dict):
        py = _yes_from(poll)
        poll = {"org": str(_first(poll, "org", "pollster", "institute", "name", default="poll")),
                "date": str(_first(poll, "date", default="")),
                "n": _first(poll, "n", "sampleSize", "sample_size"),
                "yesShare": py, "url": str(_first(poll, "url", "source", default="")),
                "note": _first(poll, "note", "notes", "population")}
        if poll["yesShare"] is None:
            poll = None
        elif poll["n"] is None:
            poll.pop("n")
        if poll and poll.get("note") is None:
            poll.pop("note")
    # A poll is only a fair "everyone" benchmark if it asked the ballot question.
    poll_gap = _first(v, "pollGap", default={}) or {}
    if poll and isinstance(poll_gap, dict) and poll_gap.get("comparable") is False:
        poll["comparable"] = False
    sources = []
    for s in _first(v, "sources", default=[]) or []:
        if isinstance(s, dict):
            sources.append({"name": str(_first(s, "name", "title", default="source")), "url": str(_first(s, "url", "href", default=""))})
        elif isinstance(s, str):
            sources.append({"name": s, "url": s if s.startswith("http") else ""})
    return {
        "question": _first(v, "question", "questionFr", "officialQuestion"),
        "voteName": _first(v, "voteName", "name", "title"),
        "date": _first(v, "date", default=date),
        "yes": yes, "turnout": turnout, "bySector": by_sector, "poll": poll, "sources": sources,
        "rules": _first(v, "rules", "keyRules", "measure", "details"),
        "fixture": bool(_first(v, "fixture", default=False)) or "fixture" in json.dumps(raw)[:300].lower(),
        "path": str(p),
    }


def load_datacenter_context(path: Path | None = None) -> dict | None:
    p = path or (GROUND_TRUTH / "datacenter_context.json")
    return read_json(p) if p.exists() else None


# ---------------------------------------------------------------------------
# Mock themes (templates for the no-API-key mode)
# ---------------------------------------------------------------------------

@dataclass
class MockTheme:
    id: str
    label: str
    labelFr: str
    side: str  # 'support' | 'oppose' | 'mixed'
    keywords: list[str]  # English keywords used by the mock theme clustering
    fr: str
    en: str
    behaviour: str
    hooks: list[str] = field(default_factory=list)  # exposure codes that make this theme likely
    needs_hook: bool = False  # only use when one of the hooks is present


SUV_THEMES = [
    MockTheme("unfair_to_commuters", "Unfair to people who must drive in — and cannot vote", "Injuste pour ceux qui doivent venir en voiture", "oppose",
              ["can't vote", "drive to work", "no other option"],
              "Je viens travailler en voiture {work_place_fr} {from_fr}, je n'ai pas d'autre solution. Payer {rate} € de l'heure alors que je ne peux même pas voter, c'est injuste.",
              "I drive to work {work_place_en} {from_en}; I have no other option. Paying €{rate} an hour when I can't even vote on it is unfair.",
              "Would look for a parking garage or a park-and-ride outside Paris.", ["suv_visitor_pays_commute"], True),
    MockTheme("cost_for_families", "Another cost for households who need a big car", "Encore un coût pour ceux qui ont besoin d'une grande voiture", "oppose",
              ["hidden tax", "unaffordable", "family"],
              "Encore une taxe déguisée. Avec une famille, on a besoin d'une grande voiture, et se garer va devenir hors de prix dès qu'on sort {of_home_fr}.",
              "Another hidden tax. With a family you need a big car, and parking will become unaffordable as soon as we leave {home_en}.",
              "Would park less often in other districts but keep the car.", ["suv_resident_pays_elsewhere", "suv_visitor_pays_occasional"]),
    MockTheme("cleaner_air_space", "Cleaner air and more street space", "Un air plus propre et plus de place", "support",
              ["cleaner air", "room to walk", "pollution"],
              "Je n'ai pas de voiture. Moins de gros SUV dans les rues {of_home_fr}, c'est un air plus propre et plus de place pour marcher.",
              "I don't have a car. Fewer big SUVs in the streets of {home_en} means cleaner air and more room to walk.",
              "Would vote in favour if reminded; otherwise unlikely to act.", ["suv_car_free_benefit"], True),
    MockTheme("big_cars_dangerous", "Big cars are dangerous and take up space", "Les grosses voitures sont dangereuses et encombrantes", "support",
              ["dangerous", "pedestrians", "two spaces"],
              "Ces voitures énormes sont dangereuses pour les piétons et les enfants, et elles prennent deux places. Qu'elles paient plus, c'est logique.",
              "These huge cars are dangerous for pedestrians and children, and they take up two spaces. Making them pay more makes sense.",
              "Would support the fee and tell neighbours about it.", ["suv_car_free_benefit", "suv_light_car"]),
    MockTheme("exempt_little_change", "Exempt at home — little changes for me", "Exempté chez moi, peu de changement", "mixed",
              ["residential zone", "doesn't change much", "exempt"],
              "Comme je me gare dans ma zone résidentielle {in_fr}, ça ne change pas grand-chose pour moi. Je ne suis ni pour ni contre.",
              "Since I park in my residential zone {in_en}, it doesn't change much for me. I'm neither for nor against.",
              "Would not change anything.", ["suv_resident_exempt_home", "suv_light_car"], True),
    MockTheme("tradespeople", "Tradespeople and their clients", "Les artisans et leurs clients", "mixed",
              ["tradesperson", "professional card", "clients"],
              "Je suis artisan, je suis exempté avec ma carte professionnelle, mais mes clients et fournisseurs paieront plus cher pour venir.",
              "I'm a tradesperson and exempt with my professional card, but my clients and suppliers will pay more to come.",
              "Would check the professional exemption paperwork.", ["suv_artisan_exempt"], True),
    MockTheme("symbolic_measure", "A symbolic measure — improve transit instead", "Une mesure symbolique", "oppose",
              ["showcase", "public transport", "won't really"],
              "C'est une mesure d'affichage : ça ne réduira pas vraiment la pollution, il faudrait plutôt améliorer les transports en commun.",
              "It's a showcase measure: it won't really reduce pollution; improving public transport would matter more.",
              "Would probably not vote."),
    MockTheme("not_concerned", "Does not concern me", "Ça ne me concerne pas", "mixed",
              ["doesn't really concern", "rarely"],
              "Je n'ai pas de grosse voiture et je ne me gare presque jamais à Paris, ça ne me concerne pas vraiment.",
              "I don't have a big car and almost never park in Paris, so it doesn't really concern me.",
              "Would ignore the vote."),
]

SCOOTER_THEMES = [
    MockTheme("practical_mobility", "A practical way to get around", "Un moyen pratique de se déplacer", "support",
              ["get home late", "metro is closed", "quick"],
              "J'utilise les trottinettes pour {trip_fr} ou rentrer tard quand le métro est fermé. Les supprimer, c'est me compliquer la vie.",
              "I use the scooters to {trip_en} or to get home late when the metro is closed. Removing them makes my life harder.",
              "Would keep using rental scooters a few times a week.", ["scooter_user"], True),
    MockTheme("regulate_not_ban", "Regulate rather than ban", "Encadrer plutôt qu'interdire", "support",
              ["regulate", "banning is too easy", "speed"],
              "Interdire, c'est trop facile : il vaudrait mieux encadrer le stationnement et la vitesse que tout supprimer.",
              "Banning is too easy: better to regulate parking and speed than to remove everything.",
              "Would vote to keep them if it is convenient.", ["scooter_user", "scooter_city_life"]),
    MockTheme("pavement_clutter", "Clutter on pavements", "Encombrement des trottoirs", "oppose",
              ["pavements", "weave between", "left all over"],
              "{in_fr_cap}, les trottinettes traînent partout sur les trottoirs, on doit slalomer entre elles. Je ne les regretterai pas.",
              "{in_en_cap}, scooters are left all over the pavements and you have to weave between them. I won't miss them.",
              "Would vote to remove them.", ["scooter_pavement_central", "scooter_city_life"], True),
    MockTheme("safety_risk", "Safety: collisions and speed", "Sécurité : collisions et vitesse", "oppose",
              ["collision", "too dangerous", "ride on pavements"],
              "Elles roulent vite et sur les trottoirs ; à mon âge, une collision peut être grave. C'est trop dangereux.",
              "They go fast and ride on pavements; at my age a collision can be serious. It's too dangerous.",
              "Would make the effort to vote against.", ["scooter_senior_risk"], True),
    MockTheme("better_alternatives", "Other options exist (metro, bikes)", "Il existe d'autres solutions", "oppose",
              ["shared bikes", "aren't much use", "buses"],
              "Il y a le métro, le bus et les vélos en libre-service : ces trottinettes ne servent pas à grand-chose.",
              "There's the metro, buses and shared bikes: these scooters aren't much use.",
              "Would not miss them.", ["scooter_commuter_sees", "scooter_city_life"]),
    MockTheme("not_green", "Not as green as claimed", "Pas si écologiques", "oppose",
              ["sold as green", "don't last long", "replace walking"],
              "On nous les a vendues comme écologiques, mais elles durent peu et remplacent surtout la marche.",
              "They were sold as green, but they don't last long and mostly replace walking.",
              "Would vote against if they hear about the vote."),
    MockTheme("indifferent", "Indifferent — rarely sees them", "Indifférent", "mixed",
              ["don't mind either way", "few near my home"],
              "Je ne les utilise pas et il y en a peu près de chez moi {in_fr} ; ça m'est un peu égal.",
              "I don't use them and there are few near my home {in_en}; I don't mind either way.",
              "Would ignore the vote."),
]

DC_THEMES = [
    MockTheme("construction_nuisance", "Construction noise and trucks", "Bruit du chantier et camions", "oppose",
              ["construction", "trucks", "cooling units"],
              "J'habite à {dist_fr} du terrain : des années de chantier et de camions sous mes fenêtres, puis le bruit des refroidisseurs. Non merci.",
              "I live {dist_en} from the site: years of construction and trucks under my windows, then the hum of the cooling units. No thanks.",
              "Would join a residents' group and attend the public meeting.", ["dc_construction_near", "dc_construction_traffic", "dc_generators"], True),
    MockTheme("local_jobs", "Local jobs", "Des emplois locaux", "support",
              ["jobs for local", "maintenance jobs"],
              "S'il y a vraiment des emplois sur le chantier et dans la maintenance pour les gens du coin, je suis plutôt pour.",
              "If there really are construction and maintenance jobs for local people, I'm rather in favour.",
              "Would ask about hiring and training programmes.", ["dc_local_jobs"], True),
    MockTheme("waste_heat", "Waste heat for local homes", "La chaleur récupérée pour les logements", "support",
              ["recovering the heat", "warm local homes"],
              "Récupérer la chaleur pour chauffer les logements du quartier, c'est intelligent, si c'est vraiment fait.",
              "Recovering the heat to warm local homes is smart, if it really happens.",
              "Would want guarantees on the heating connection.", ["dc_heat_network"], True),
    MockTheme("energy_water", "Electricity and water use", "Électricité et eau", "oppose",
              ["megawatts", "save energy", "priority"],
              "Des centaines de mégawatts pour faire tourner de l'IA, alors qu'on nous demande d'économiser l'énergie ? Ça ne me paraît pas prioritaire.",
              "Hundreds of megawatts to run AI while we're asked to save energy? That doesn't seem like a priority to me.",
              "Would sign an online petition.", ["dc_grid_water", "dc_grid_works", "dc_cluster_93"]),
    MockTheme("land_for_housing", "The land should be for housing", "Ce terrain devrait servir au logement", "oppose",
              ["affordable housing", "build homes"],
              "En Seine-Saint-Denis on manque de logements abordables ; ce terrain devrait servir à construire des logements, pas des serveurs.",
              "Seine-Saint-Denis lacks affordable housing; this land should be used to build homes, not servers.",
              "Would raise it with a tenants' association.", ["dc_housing_land"], True),
    MockTheme("tax_revenue", "Tax revenue for the host town", "Des recettes fiscales pour la commune", "support",
              ["tax revenue", "schools and facilities"],
              "Les recettes fiscales pour {commune} pourraient financer des écoles et des équipements, c'est un vrai argument.",
              "The tax revenue for {commune} could pay for schools and facilities; that's a real argument.",
              "Would support it if the money stays local.", ["dc_host_tax"], True),
    MockTheme("tech_sovereignty", "Europe needs its own AI infrastructure", "L'Europe a besoin de ses propres infrastructures d'IA", "support",
              ["own ai infrastructure", "europe"],
              "Il faut que la France et l'Europe aient leurs propres infrastructures d'IA, autant les construire ici.",
              "France and Europe need their own AI infrastructure; we might as well build it here.",
              "Would support it without taking part."),
    MockTheme("nuisances_for_93", "The suburbs get the nuisances", "La banlieue récupère les nuisances", "oppose",
              ["always in seine-saint-denis", "nobody wants"],
              "C'est toujours en Seine-Saint-Denis qu'on installe ce que personne ne veut, pendant que les bénéfices vont ailleurs.",
              "It's always in Seine-Saint-Denis that they put what nobody wants, while the benefits go elsewhere.",
              "Would attend the meeting to say so.", ["dc_host_tax", "dc_housing_land", "dc_construction_traffic", "dc_cluster_93"], True),
    MockTheme("far_away", "Too far away to matter to me", "Trop loin pour me concerner", "mixed",
              ["far from the site", "no strong view"],
              "J'habite loin du site, {in_fr} ; ça ne change rien à ma vie, je n'ai pas d'avis tranché.",
              "I live far from the site, {in_en}; it doesn't change my life and I have no strong view.",
              "Would not follow the consultation."),
]


# ---------------------------------------------------------------------------
# Scenario definitions
# ---------------------------------------------------------------------------

@dataclass
class ScenarioDef:
    id: str
    title: str
    titleFr: str
    subtitle: str
    summary: str
    proposalFr: str
    proposalEn: str
    paraphrasesFr: list[str]  # K=3 versions for uncertainty runs; [0] == proposalFr
    kind: str
    channel: str
    turnoutTarget: float
    voterScope: str
    icon: str
    date: str | None = None
    site: dict | None = None
    zone: str | None = None  # 'paris' | 'host' | None
    backtest: dict | None = None  # ground truth (normalised) for backtests
    mock_base: float = 0.0
    mock_effects: dict[str, float] = field(default_factory=dict)
    mock_themes: list[MockTheme] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    facts: dict = field(default_factory=dict)  # numbers used in exposure texts (rates, distances...)


CHANNEL_FR = {
    "votation": "aller voter à la votation citoyenne de la Ville de Paris (un dimanche, dans un bureau de vote)",
    "public_meeting": "venir à une réunion publique de concertation en soirée ou déposer un avis au registre",
    "online_consultation": "répondre à une consultation en ligne",
}

SUV_QUESTION_DEFAULT = ("Pour ou contre la création d'un tarif spécifique pour le stationnement des voitures "
                        "individuelles lourdes, encombrantes, polluantes ?")
SCOOTER_QUESTION_DEFAULT = "Pour ou contre les trottinettes en libre-service ?"


def _suv(gt: dict | None) -> ScenarioDef:
    q = (gt or {}).get("question") or SUV_QUESTION_DEFAULT
    rules_fr = ("Si le « Pour » l'emporte, le stationnement en surface des voitures de visiteurs pesant au moins "
                "1,6 tonne (thermiques ou hybrides rechargeables) ou au moins 2 tonnes (électriques) coûtera "
                "18 € de l'heure dans les arrondissements centraux (1er au 11e) et 12 € de l'heure dans les autres "
                "(12e au 20e), soit trois fois le tarif actuel. Ne seraient pas concernés : les Parisiens qui se "
                "garent dans leur zone de stationnement résidentiel, les artisans et professionnels munis d'une "
                "carte professionnelle, les taxis et les personnes en situation de handicap.")
    hint = "(Une position favorable (+) signifie voter « Pour » ce tarif.)"
    base = f"La Ville de Paris organise une votation citoyenne le 4 février 2024. Question : « {q} » {rules_fr} {hint}"
    p1 = (f"Votation citoyenne à Paris, 4 février 2024. On vous demande : « {q} » Concrètement : les voitures lourdes "
          "(1,6 t et plus en thermique/hybride, 2 t et plus en électrique) de non-résidents paieraient 18 €/h pour se "
          "garer dans le centre (1er–11e) et 12 €/h ailleurs (12e–20e), trois fois plus qu'aujourd'hui. Exemptés : "
          f"résidents dans leur zone, professionnels avec carte, taxis, personnes handicapées. {hint}")
    p2 = (f"Proposition de la mairie de Paris, soumise au vote des habitants inscrits : tripler le prix du stationnement "
          "dans la rue pour les voitures particulières les plus lourdes (au moins 1,6 tonne, ou 2 tonnes pour les "
          "électriques) quand elles ne sont pas garées par un résident dans son quartier : 18 € l'heure du 1er au 11e "
          "arrondissement, 12 € l'heure du 12e au 20e. Artisans, taxis et personnes handicapées ne sont pas concernés. "
          f"Question posée : « {q} » {hint}")
    sources = (gt or {}).get("sources") or []
    notes = []
    if gt is None:
        notes.append("Ground truth file pipeline/data/ground_truth/votations.json not found: official wording/results are built-in defaults.")
    return ScenarioDef(
        id="paris_suv_2024", title="Parking fee for heavy cars (SUVs)",
        titleFr="Tarif de stationnement pour les voitures lourdes (SUV)",
        subtitle="Backtest · Paris votation, 4 Feb 2024", icon="car", date="2024-02-04",
        summary=("Should visitors' heavy cars pay triple for street parking in Paris? A real votation (4 Feb 2024): "
                 "we compare the simulated voters with the official result by sector — and show who pays but cannot vote."),
        proposalFr=base, paraphrasesFr=[base, p1, p2],
        proposalEn=("Paris citizens' vote, 4 Feb 2024: 'For or against a specific parking rate for heavy, bulky, polluting "
                    "individual cars?' If 'For' wins, on-street parking for visitors' cars of 1.6 t or more (combustion/"
                    "plug-in hybrid) or 2 t or more (electric) costs €18/h in arrondissements 1–11 and €12/h in 12–20, "
                    "three times today's price. Exempt: Parisians parking in their residential zone, tradespeople with a "
                    "professional card, taxis and disabled drivers."),
        kind="backtest", channel="votation", turnoutTarget=0.0568, voterScope="paris_eligible", zone="paris",
        backtest=gt, mock_base=0.1,
        mock_effects={"suv_visitor_pays_commute": -1.7, "suv_visitor_pays_occasional": -0.9,
                      "suv_resident_exempt_home": -0.3, "suv_resident_pays_elsewhere": -0.7,
                      "suv_light_car": -0.3, "suv_car_free_benefit": 0.7, "suv_artisan_exempt": -0.2,
                      "suv_no_car_suburb": 0.0},
        mock_themes=SUV_THEMES, notes=notes,
        facts={"rateCentral": 18, "rateOuter": 12, "centralArrs": list(range(1, 12))},
    )


def _scooters(gt: dict | None) -> ScenarioDef:
    q = (gt or {}).get("question") or SCOOTER_QUESTION_DEFAULT
    hint = "(Une position favorable (+) signifie voter « Pour » : garder les trottinettes en libre-service.)"
    base = (f"La Ville de Paris organise une votation citoyenne le 2 avril 2023. Question : « {q} » Environ 15 000 "
            "trottinettes électriques en libre-service, proposées par trois opérateurs, circulent à Paris dans le cadre "
            "de contrats qui se terminent fin août 2023. Voter « Pour » : la Ville renouvelle les contrats et les "
            "trottinettes en libre-service restent. Voter « Contre » : elles disparaissent de Paris à la fin des "
            "contrats. Les trottinettes personnelles, les vélos et les scooters en libre-service ne sont pas concernés. "
            f"{hint}")
    p1 = (f"Votation citoyenne du 2 avril 2023 à Paris : « {q} » Si le « Pour » gagne, les quelque 15 000 trottinettes "
          "électriques à louer dans la rue restent disponibles ; si le « Contre » gagne, la mairie ne renouvelle pas les "
          "contrats des opérateurs et elles sont retirées à partir de septembre 2023. Les trottinettes que l'on possède "
          f"soi-même restent autorisées. {hint}")
    p2 = ("La mairie de Paris demande aux électeurs parisiens s'il faut garder les trottinettes électriques en "
          "libre-service (environ 15 000 engins de trois opérateurs, contrats jusqu'à fin août 2023) ou y mettre fin. "
          f"Question posée le 2 avril 2023 : « {q} » Les vélos en libre-service et les trottinettes personnelles ne "
          f"changent pas. {hint}")
    notes = []
    if gt is None:
        notes.append("Ground truth file pipeline/data/ground_truth/votations.json not found: official wording/results are built-in defaults.")
    return ScenarioDef(
        id="paris_scooters_2023", title="Rental e-scooters: keep or remove?",
        titleFr="Trottinettes en libre-service : pour ou contre ?",
        subtitle="Backtest · Paris votation, 2 Apr 2023", icon="scooter", date="2023-04-02",
        summary=("Keep Paris's rental e-scooters? A real votation (2 Apr 2023) with very low turnout: we test whether "
                 "the simulated likely voters differ from everyone, and compare with the official result by sector."),
        proposalFr=base, paraphrasesFr=[base, p1, p2],
        proposalEn=("Paris citizens' vote, 2 Apr 2023: 'For or against self-service (rental) e-scooters?' About 15,000 "
                    "rental e-scooters from three operators run under contracts ending in August 2023. 'For' = the city "
                    "renews the contracts and they stay; 'Against' = they disappear from Paris. Personal scooters and "
                    "shared bikes are not affected."),
        kind="backtest", channel="votation", turnoutTarget=0.0746, voterScope="paris_eligible", zone="paris",
        backtest=gt, mock_base=-0.5,
        mock_effects={"scooter_user": 1.8, "scooter_pavement_central": -0.6, "scooter_city_life": -0.2,
                      "scooter_senior_risk": -0.8, "scooter_commuter_sees": -0.1, "scooter_outside": 0.0},
        mock_themes=SCOOTER_THEMES, notes=notes,
        facts={"denseArrs": list(range(1, 12))},
    )


# Placeholder facts, used only if datacenter_context.json is missing (the real file, built by the
# ground-truth step, holds a sourced hypothetical site in La Courneuve and its parameters).
DC_DEFAULT = {
    "lon": 2.3625, "lat": 48.9135,
    "label": "Hypothetical site — brownfield in La Plaine Saint-Denis (placeholder)",
    "placeFr": "à La Plaine Saint-Denis",
    "powerMW": 200, "areaHa": 5, "constructionYears": 2.5, "jobsConstruction": 1000, "jobsPermanent": "100 à 150",
    "jobsPermanentEn": "100–150", "heatMW": None, "homesHeated": None, "generators": None, "localTaxEurPerYear": None,
}
DC_FACT_KEYS = ("powerMW", "areaHa", "constructionYears", "jobsConstruction", "jobsPermanent", "heatMW",
                "homesHeated", "generators", "waterM3PerYear", "annualElectricityGWh", "localTaxEurPerYear")
STANCE_HINT_DC = "(Une position favorable (+) signifie soutenir le projet.)"


def _fr_num(v) -> str:
    """1000 -> '1 000' (French thousands separator); text is returned unchanged."""
    return f"{int(v):,}".replace(",", " ") if str(v).isdigit() else str(v)


def _datacenter(ctx: dict | None) -> ScenarioDef:
    c = dict(DC_DEFAULT)
    notes = []
    official_fr = official_en = None
    if ctx:
        site = ctx.get("site") if isinstance(ctx.get("site"), dict) else ctx
        for k_src, k_dst in (("lon", "lon"), ("lat", "lat"), ("label", "label"), ("name", "label"),
                             ("placeFr", "placeFr"), ("labelFr", "placeFr"), ("commune", "commune")):
            if site.get(k_src) is not None:
                c[k_dst] = site[k_src]
        for k in DC_FACT_KEYS:
            v = ctx.get(k) if ctx.get(k) is not None else (ctx.get("facts") or {}).get(k)
            if v is not None:
                c[k] = v
                if k == "jobsPermanent":
                    c["jobsPermanentEn"] = str(v)
        hyp = ctx.get("hypothetical") or {}
        official_fr = hyp.get("proposalFr") or ctx.get("proposalFr")
        official_en = hyp.get("proposalEn") or ctx.get("proposalEn")
        notes.append("Hypothetical project: site and parameters come from pipeline/data/ground_truth/datacenter_context.json "
                     "(invented but plausible, modelled on real Seine-Saint-Denis campuses); it is not a real project.")
    else:
        notes.append("datacenter_context.json not found: site, size and job figures are placeholders chosen to be plausible, not a real project.")
    yrs_fr = str(c["constructionYears"]).replace(".", ",")
    jobs_fr = _fr_num(c["jobsConstruction"])
    jobs_en = f"{int(c['jobsConstruction']):,}" if str(c["jobsConstruction"]).isdigit() else str(c["jobsConstruction"])
    place_fr = f" ({c['placeFr']})" if c.get("placeFr") else ""
    heat_fr = (f"jusqu'à {c['heatMW']} MW de chaleur pour le chauffage urbain (environ {_fr_num(c['homesHeated'])} logements)"
               if c.get("heatMW") and c.get("homesHeated") else "une partie de la chaleur récupérée pour le chauffage urbain")
    tax_fr = (f"{str(c['localTaxEurPerYear']).replace('-', ' à ').replace('million', 'millions')} d'euros par an de recettes fiscales locales"
              if c.get("localTaxEurPerYear") else "des recettes fiscales pour la commune d'accueil")
    gen_fr = (f", une centaine de groupes électrogènes de secours testés chaque mois" if c.get("generators") else "")
    generated = (f"Projet (hypothétique) soumis à concertation : construction d'un grand centre de données dédié à "
                 f"l'intelligence artificielle sur un terrain industriel en Seine-Saint-Denis{place_fr}. "
                 f"Le site occuperait environ {c['areaHa']} hectares et demanderait environ {c['powerMW']} mégawatts "
                 f"d'électricité, avec un nouveau raccordement au réseau haute tension. Le chantier durerait environ {yrs_fr} ans, "
                 f"avec des passages de camions. {heat_fr[0].upper() + heat_fr[1:]}. L'exploitant annonce environ {jobs_fr} "
                 f"emplois pendant le chantier et {c['jobsPermanent']} emplois permanents ; {tax_fr}. "
                 f"Le refroidissement fonctionnerait en circuit fermé.")
    base = f"{official_fr or generated} {STANCE_HINT_DC}"
    p1 = (f"Concertation publique sur un projet fictif : un exploitant veut bâtir un centre de calcul pour l'IA "
          f"d'environ {c['powerMW']} MW sur {c['areaHa']} hectares de terrains industriels en Seine-Saint-Denis{place_fr}. "
          f"Environ {yrs_fr} ans de travaux{gen_fr}, {heat_fr}, {jobs_fr} emplois de chantier puis {c['jobsPermanent']} "
          f"postes permanents, et {tax_fr}. {STANCE_HINT_DC}")
    p2 = (f"Hypothèse étudiée par les urbanistes : implanter en Seine-Saint-Denis{place_fr} un très grand centre de calcul "
          f"pour l'intelligence artificielle ({c['powerMW']} mégawatts, {c['areaHa']} hectares). Avantages annoncés : emplois "
          f"({jobs_fr} sur le chantier, {c['jobsPermanent']} ensuite), {heat_fr}, {tax_fr}. Inconvénients possibles : "
          f"{yrs_fr} ans de chantier, camions, tranchées pour les lignes électriques souterraines, forte consommation "
          f"d'électricité, bruit des installations de refroidissement{gen_fr}. {STANCE_HINT_DC}")
    proposal_en = official_en or (
        f"Hypothetical project under public consultation: a large AI data centre on industrial land in Seine-Saint-Denis. "
        f"About {c['areaHa']} hectares and {c['powerMW']} MW of electricity with a new high-voltage connection; about "
        f"{c['constructionYears']} years of construction with truck traffic; part of the waste heat recovered for the local "
        f"district-heating network; about {jobs_en} construction jobs and {c['jobsPermanentEn']} permanent jobs; new "
        f"business-tax revenue for the host town; closed-loop cooling.")
    x, y = lonlat_to_xy(float(c["lon"]), float(c["lat"]))
    where_en = c.get("commune") or "Seine-Saint-Denis"
    notes.append("Turnout assumption: about 3% of all residents of the study area engage with the consultation (meeting, "
                 "online contribution or register). This is an upper-range planning figure chosen so the 'attendees' view "
                 "is readable; real public debates often reach well under 1%. Who engages matters more than how many.")
    return ScenarioDef(
        id="saint_denis_datacenter", title="An AI data centre in Seine-Saint-Denis",
        titleFr="Un centre de données IA en Seine-Saint-Denis",
        subtitle=f"Hypothetical · public consultation · {where_en}", icon="datacenter",
        summary=(f"A hypothetical {c['powerMW']} MW AI computing campus in {where_en} (Seine-Saint-Denis): who is affected, "
                 "who would object and why, and whose voices a public meeting would miss."),
        proposalFr=base, paraphrasesFr=[base, p1, p2], proposalEn=proposal_en,
        kind="hypothetical", channel="public_meeting", turnoutTarget=0.03, voterScope="all_residents", zone="host",
        site={"lon": float(c["lon"]), "lat": float(c["lat"]), "x": round(x, 2), "y": round(y, 2),
              "label": c["label"], "ringsTiles": [5, 10, 20]},
        mock_base=-0.1,
        mock_effects={"dc_construction_near": -1.6, "dc_construction_traffic": -0.8, "dc_heat_network": 0.4,
                      "dc_local_jobs": 0.6, "dc_host_tax": 0.3, "dc_housing_land": -0.5, "dc_grid_water": -0.1,
                      "dc_generators": -0.4, "dc_grid_works": -0.2, "dc_cluster_93": -0.3},
        mock_themes=DC_THEMES, notes=notes, facts=c,
    )


def build_scenarios(votations_path: Path | None = None, dc_path: Path | None = None) -> dict[str, ScenarioDef]:
    suv_gt = load_vote("paris_suv_2024", "2024-02-04", "lourdes", votations_path)
    sc_gt = load_vote("paris_scooters_2023", "2023-04-02", "trottinettes", votations_path)
    out = {
        "saint_denis_datacenter": _datacenter(load_datacenter_context(dc_path)),
        "paris_suv_2024": _suv(suv_gt),
        "paris_scooters_2023": _scooters(sc_gt),
    }
    return out


# Official city-wide figures (used only if the ground-truth file is missing).
OFFICIAL_FALLBACK = {
    "paris_suv_2024": {"yes": 0.5455, "turnout": 0.0568, "voteName": "Votation citoyenne — stationnement des voitures lourdes"},
    "paris_scooters_2023": {"yes": 0.1097, "turnout": 0.0746, "voteName": "Votation citoyenne — trottinettes en libre-service"},
}


# ---------------------------------------------------------------------------
# Mock reaction (no API key)
# ---------------------------------------------------------------------------

def _attr_effect(sid: str, r: dict) -> float:
    a = r["age"]
    g = r["occupationGroup"]
    if sid == "paris_suv_2024":
        return (-0.2 if a >= 60 else 0) + (0.2 if g == "cadres" and not r["imputed"]["car"] else 0) \
            - (0.2 if r["household"] == "couple_kids" and r["imputed"]["car"] else 0)
    if sid == "paris_scooters_2023":
        return (0.5 if a < 30 else 0) - (0.5 if a >= 60 else 0) + (0.1 if g == "cadres" else 0)
    if sid == "saint_denis_datacenter":
        return (0.3 if g == "cadres" else 0) - (0.2 if g == "retraites" else 0) + (0.2 if a < 30 else 0)
    return 0.0


# Exposure codes that mean "this resident lives near the site". A mock answer must never say
# "I live far from the site" for them.
NEAR_SITE_CODES = {"dc_construction_near", "dc_construction_traffic", "dc_generators", "dc_heat_network", "dc_grid_works", "dc_host_tax"}


def pick_mock_theme(sdef: ScenarioDef, codes: set[str], stance: int, rng) -> MockTheme:
    side = "support" if stance > 0 else "oppose" if stance < 0 else "mixed"
    themes = [t for t in sdef.mock_themes if not (t.id == "far_away" and codes & NEAR_SITE_CODES)]
    cands = [t for t in themes if t.side == side and (not t.needs_hook or set(t.hooks) & codes)]
    if not cands:
        cands = [t for t in themes if not t.needs_hook] or themes
    hooked = [t for t in cands if set(t.hooks) & codes]
    if hooked and rng.random() < 0.8:
        return rng.choice(hooked)
    return rng.choice(cands)


def mock_reaction(sdef: ScenarioDef, r: dict, exposure: dict, words: dict, paraphrase: int = 0, model_tag: str = "main") -> dict:
    """Deterministic heuristic answer in the 'reaction' schema (stance from exposure + attributes + noise)."""
    rng = seeded_rng("reaction", sdef.id, r["id"], paraphrase, model_tag)
    codes = {x["code"] for x in exposure["reasons"]}
    shift = [0.0, 0.12, -0.12][paraphrase % 3] + (0.0 if model_tag == "main" else 0.08)
    s = sdef.mock_base + sum(sdef.mock_effects.get(c, 0.0) for c in codes) + _attr_effect(sdef.id, r) + shift + rng.gauss(0, 0.7)
    stance = int(max(-2, min(2, round(s))))
    theme = pick_mock_theme(sdef, codes, stance, rng)
    fr = theme.fr.format(**words)
    en = theme.en.format(**words)
    score = exposure["score"]
    affected = int(max(0, min(3, score + round(rng.gauss(0, 0.6)))))
    wp = 0.1 + 0.12 * score + 0.1 * abs(stance) + (0.15 if r["age"] >= 60 else 0) + (0.1 if r["educationRank"] >= 5 else 0) + rng.gauss(0, 0.1)
    return {
        "stance": stance, "affected": affected,
        "behaviour_en": MOCK_EN + theme.behaviour,
        "reason_fr": MOCK_FR + fr, "reason_en": MOCK_EN + en,
        "would_participate": round(max(0.02, min(0.95, wp)), 2),
    }
