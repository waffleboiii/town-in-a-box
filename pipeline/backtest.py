"""Backtests against real Paris votations, compared by arrondissement sector.

The simulation is compared with the official 'Pour' share in each votation sector
('Paris Centre' = 1er-4e, then 5e ... 20e). Residents are mapped to sectors through
map.json District.sector.

Fixed choices (decided BEFORE any comparison with sector results, never tuned on the vote
being predicted):
  - "attendees" (the forecast) = eligible residents weighted by raking weight x calibrated
    participation probability (participation.py; turnout target = the official turnout, which
    is a design input for the consultation, not a tuned parameter);
  - metrics: mean absolute error (MAE) and Pearson r across sectors, attendees view vs actual;
  - gap sign test: does sign(simulated voters - simulated everyone) match
    sign(actual vote - pre-vote poll)? (a poll approximates "everyone", the vote "attendees");
  - baselines: (a) uniform poll figure in every sector (if a poll is in votations.json),
    (b) a pre-registered demographic rule with no LLM (coefficients below),
    (c) the bare model with no personas (from the leakage probe, if run),
    (d) the same simulation without the turnout model (everyone view).

Honesty note: the engineer who fixed the coefficients of baseline (b) knew the city-wide
headline results, but not the sector results, and did not adjust them after any comparison.
"""
from __future__ import annotations

import math
import re

from aggregate import view_weights, yes_share
from common import GROUND_TRUTH, read_json

# Pre-registered demographic rules (baseline b). Voters weighted by raking weight x participationBase.
HEURISTICS = {
    "paris_suv_2024": {
        "name": "Demographic rule (no LLM): car-free share",
        "description": "yes = 0.25 + 0.50 × share of voters without a car (imputed) — i.e. car-free voters 75% 'Pour', "
                       "car owners 25%. Coefficients fixed before any comparison.",
        "fn": lambda rs: 0.25 + 0.50 * _share(rs, lambda r: not r["imputed"]["car"]),
    },
    "paris_scooters_2023": {
        "name": "Demographic rule (no LLM): young-voter share",
        "description": "yes = 0.05 + 0.45 × share of voters aged 18–29 — i.e. under-30s split 50/50, older voters 5% "
                       "'Pour'. Coefficients fixed before any comparison.",
        "fn": lambda rs: 0.05 + 0.45 * _share(rs, lambda r: r["age"] < 30),
    },
}


def _share(rs: list[dict], pred) -> float:
    tw = sum(float(r.get("weight", 1.0)) * float(r.get("participationBase", 0.5)) for r in rs)
    if tw <= 0:
        return 0.0
    return sum(float(r.get("weight", 1.0)) * float(r.get("participationBase", 0.5)) for r in rs if pred(r)) / tw


def pearson(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return 0.0
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def _sector_key(s: str):
    m = re.match(r"(\d+)", s)
    return (0, 0) if s == "Paris Centre" else (1, int(m.group(1)) if m else 99)


def sectors_from_map(ctx) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for idx, d in ctx.districts.items():
        if d.get("dept") == "75" and d.get("sector"):
            out.setdefault(d["sector"], []).append(idx)
    return dict(sorted(out.items(), key=lambda kv: _sector_key(kv[0])))


def _mae(sim: list[float], act: list[float]) -> float:
    return sum(abs(a - b) for a, b in zip(sim, act)) / len(sim) if sim else 0.0


def sector_table(residents, stances, part, ctx, gt_sectors: dict, overall_actual: float) -> list[dict]:
    rows = []
    for sector, idxs in sectors_from_map(ctx).items():
        rs = [r for r in residents if r["districtIdx"] in idxs]
        ev = [(stances[r["id"]], float(r.get("weight", 1.0))) for r in rs]
        at = [(stances[r["id"]], view_weights(r, part)["attendees"]) for r in rs]
        at = [p for p in at if p[1] > 0]
        g = gt_sectors.get(sector)
        row = {"sector": sector, "districtIdxs": sorted(idxs),
               "actualYes": round(g["yes"] if g else overall_actual, 4),
               "simEveryoneYes": round(yes_share(ev), 4) if ev else 0.5,
               "simAttendeesYes": round(yes_share(at), 4) if at else (round(yes_share(ev), 4) if ev else 0.5)}
        if g and g.get("turnout") is not None:
            row["actualTurnout"] = round(g["turnout"], 4)
        row["_hasActual"] = bool(g)
        row["_n"] = len(rs)
        rows.append(row)
    return rows


def _usable(rows) -> list[dict]:
    """Sectors with an official result; if none has one yet, every sector (compared with the city-wide result)."""
    have = any(r["_hasActual"] for r in rows)
    return [r for r in rows if r["_n"] > 0 and (r["_hasActual"] or not have)]


def _metrics(rows, sim_key="simAttendeesYes") -> dict:
    use = _usable(rows)
    sim = [r[sim_key] for r in use]
    act = [r["actualYes"] for r in use]
    return {"sectorMae": round(_mae(sim, act), 4), "sectorCorrelation": round(pearson(sim, act), 3)}


def _paris_views(residents, stances, part, ctx) -> dict:
    paris = [r for r in residents if ctx.is_paris(r["districtIdx"])]
    ev = [(stances[r["id"]], float(r.get("weight", 1.0))) for r in paris]
    el = [(stances[r["id"]], view_weights(r, part)["eligible"]) for r in residents]
    at = [(stances[r["id"]], view_weights(r, part)["attendees"]) for r in residents]
    return {"everyoneYes": round(yes_share(ev), 4),
            "eligibleYes": round(yes_share([p for p in el if p[1] > 0]), 4),
            "attendeesYes": round(yes_share([p for p in at if p[1] > 0]), 4)}


def _public_rows(rows):
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]


def compute_backtest(sdef, residents, stances, part, ctx, leakage: dict | None, fallback: dict) -> tuple[dict, list[str]]:
    """Return (Backtest dict, notes)."""
    gt = sdef.backtest or {}
    notes = []
    actual_yes = gt.get("yes") if gt.get("yes") is not None else fallback["yes"]
    actual_turnout = gt.get("turnout") if gt.get("turnout") is not None else fallback["turnout"]
    gt_sectors = gt.get("bySector") or {}
    if not gt_sectors:
        notes.append("Official sector results not available yet: every sector shows the city-wide result, so the 'sector' "
                     "MAE is the distance from the city-wide result and the correlation is 0. Not a real sector test.")
    if gt.get("fixture"):
        notes.append("DEV FIXTURE ground truth: sector results are invented for code testing — do not interpret the metrics.")
    rows = sector_table(residents, stances, part, ctx, gt_sectors, actual_yes)
    sim = _paris_views(residents, stances, part, ctx)
    metrics = _metrics(rows)
    poll = gt.get("poll")
    usable_poll = _comparable_poll(gt)
    if usable_poll:
        metrics["gapSignCorrect"] = bool((sim["attendeesYes"] - sim["everyoneYes"] >= 0) == (actual_yes - poll["yesShare"] >= 0))
    elif poll and poll.get("yesShare") is not None:
        notes.append(f"The {poll['org']} poll did not ask the ballot question, so it is shown for context only: no "
                     "gap-sign test and no 'uniform poll' baseline for this vote.")
    baselines = []
    use = _usable(rows)
    if usable_poll:
        baselines.append({"name": f"Uniform poll ({poll['org']})",
                          "description": "The pre-vote poll figure applied to every sector.",
                          "yesShare": round(poll["yesShare"], 4),
                          "sectorMae": round(_mae([poll["yesShare"]] * len(use), [r["actualYes"] for r in use]), 4)})
    h = HEURISTICS.get(sdef.id)
    if h:
        voters = [r for r in residents if part[r["id"]]["eligible"]]
        overall = max(0.0, min(1.0, h["fn"](voters)))
        per = []
        for r in use:
            rs = [x for x in voters if x["districtIdx"] in r["districtIdxs"]]
            per.append(max(0.0, min(1.0, h["fn"](rs))) if rs else overall)
        baselines.append({"name": h["name"], "description": h["description"], "yesShare": round(overall, 4),
                          "sectorMae": round(_mae(per, [r["actualYes"] for r in use]), 4)})
    leak = (leakage or {}).get("votes", {}).get(sdef.id) if leakage and leakage.get("probed") else None
    if leak and leak.get("bareModel") and leak["bareModel"].get("yesShare") is not None:
        y = leak["bareModel"]["yesShare"]
        baselines.append({"name": f"Bare model, no personas ({leak['bareModel'].get('model', '')})",
                          "description": "The reaction model asked to estimate the result directly (disguised question, no persona).",
                          "yesShare": round(y, 4),
                          "sectorMae": round(_mae([y] * len(use), [r["actualYes"] for r in use]), 4)})
    baselines.append({"name": "Same simulation, no turnout model (everyone in Paris)",
                      "description": "All simulated Paris residents counted equally, ignoring who would actually vote.",
                      "yesShare": sim["everyoneYes"], "sectorMae": _metrics(rows, "simEveryoneYes")["sectorMae"]})
    if leak:
        leakage_block = {"probed": True, "bareModelAnswer": leak.get("bareModelAnswer", ""),
                         "verdict": leak.get("verdict", ""), "notes": leak.get("notes", "")}
    else:
        leakage_block = {"probed": False, "notes": "Leakage probe pending API key (run pipeline/leakage_probe.py). "
                                                   + cutoff_note(sdef)}
    sources = gt.get("sources") or []
    if not sources:
        sources = [{"name": "Ville de Paris — résultats des votations citoyennes", "url": "https://www.paris.fr"}]
    bt = {
        "voteName": gt.get("voteName") or fallback["voteName"],
        "date": gt.get("date") or sdef.date,
        "question": gt.get("question") or "",
        "sources": sources,
        "actual": {"yesShare": round(actual_yes, 4), "turnout": round(actual_turnout, 4)},
        "simulated": sim,
        "bySector": _public_rows(rows),
        "metrics": metrics,
        "baselines": baselines,
        "leakage": leakage_block,
    }
    if poll and poll.get("yesShare") is not None:
        bt["poll"] = {k: v for k, v in poll.items() if v is not None and k != "comparable"}
    return bt, notes


def _comparable_poll(gt: dict) -> bool:
    poll = gt.get("poll")
    return bool(poll and poll.get("yesShare") is not None and poll.get("comparable", True) is not False)


def cutoff_note(sdef) -> str:
    """Training cutoffs from the model cards (pipeline/data/ground_truth/leakage_notes.json) vs the vote date."""
    p = GROUND_TRUTH / "leakage_notes.json"
    fallback = ("Nemotron 3 pretraining reportedly ends around June 2025, after this vote, so the models may have seen the result.")
    if not p.exists():
        return fallback
    try:
        ln = read_json(p)
        cut = ", ".join(f"{m['family']} {m['pretrainingCutoff']}" for m in ln.get("models", []))
        summary = (ln.get("votes", {}).get(sdef.id) or {}).get("summary", "")
        return f"Model-card pretraining cutoffs: {cut}; vote date {sdef.date}. {summary}".strip()
    except (KeyError, TypeError, ValueError):
        return fallback


def compute_backtest_after_talk(sdef, residents, stances_after, part, ctx, fallback: dict) -> dict:
    gt = sdef.backtest or {}
    actual_yes = gt.get("yes") if gt.get("yes") is not None else fallback["yes"]
    rows = sector_table(residents, stances_after, part, ctx, gt.get("bySector") or {}, actual_yes)
    sim = _paris_views(residents, stances_after, part, ctx)
    metrics = _metrics(rows)
    if _comparable_poll(gt) and gt.get("yes") is not None:
        metrics["gapSignCorrect"] = bool((sim["attendeesYes"] - sim["everyoneYes"] >= 0) == (gt["yes"] - gt["poll"]["yesShare"] >= 0))
    return {"simulated": sim, "bySector": _public_rows(rows), "metrics": metrics}
