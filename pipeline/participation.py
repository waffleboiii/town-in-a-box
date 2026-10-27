"""Who would actually take part? A calibrated participation model.

Step 1 — a raw score per resident (all fixed choices, decided before looking at any result):

    raw = sigmoid( logit(participationBase)          # empirical turnout propensity (INSEE gradients), not the LLM
                   + ALPHA * exposure.score          # people more affected by an issue turn out more
                   + BETA  * (wouldParticipateLLM - 0.5)   # the LLM's self-report: a WEAK rank modifier only
                   - DISTANCE_DECAY (public meetings with a site only) )

Step 2 — calibration: one common shift c of the log-odds so that the expected number of
participants equals turnoutTarget x (weighted size of the scope):

    p_i = sigmoid(logit(raw_i) + c),   sum_i w_i * p_i = turnoutTarget * sum_i w_i   (i in scope)

The scope is the eligible Paris electorate for votations, or all residents for public meetings.
p_i is written to ResidentResult.participationScore (0 for residents outside the scope).
All "attendee" aggregates use the weights w_i * p_i (expected participants), not the sample.

Step 3 — the boolean `attendee` used by the map is a seeded weighted random sample (without
replacement) of exactly round(turnoutTarget x N_scope) residents, with a floor of MIN_DISPLAYED
so the view is never empty. It is a picture of one plausible turnout, not the basis of the numbers.
"""
from __future__ import annotations

import math

from llm import seeded_rng

ALPHA = 0.35  # log-odds per exposure point (0..3): a 3-point issue roughly triples the odds of taking part
BETA = 0.5  # log-odds per unit of the LLM self-report (0..1): at most +/-0.25, i.e. a tie-breaker
DISTANCE_DECAY_PER_KM = 0.25  # public meetings only: fewer people travel far to a local evening meeting
DISTANCE_DECAY_FREE_KM = 2.0  # no decay inside this radius
DISTANCE_DECAY_MAX = 2.5  # cap on the decay (log-odds); online contributions keep far residents above zero
MIN_DISPLAYED = 25


def _logit(p: float) -> float:
    p = min(0.995, max(0.005, p))
    return math.log(p / (1 - p))


def _sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z))


def in_scope(r: dict, sdef) -> bool:
    return bool(r.get("eligibleParis")) if sdef.voterScope == "paris_eligible" else True


def base_propensity(r: dict, sdef) -> float:
    """Votations use participationBase (0 for people who cannot vote). Open meetings and online
    consultations are open to everyone, so they use participationPropensity (the same INSEE-based
    propensity without the non-voter zero) when the population file provides it."""
    if sdef.channel != "votation" and r.get("_propensity") is not None:
        return float(r["_propensity"])
    return float(r.get("participationBase", 0.5))


def raw_score(r: dict, exposure_score: int, would_llm: float, sdef) -> float:
    z = _logit(base_propensity(r, sdef))
    z += ALPHA * exposure_score + BETA * (float(would_llm) - 0.5)
    if sdef.channel == "public_meeting" and sdef.site:
        d_km = math.hypot(r["home"][0] + 0.5 - sdef.site["x"], r["home"][1] + 0.5 - sdef.site["y"]) * 0.1
        z -= min(DISTANCE_DECAY_MAX, max(0.0, d_km - DISTANCE_DECAY_FREE_KM) * DISTANCE_DECAY_PER_KM)
    return _sigmoid(z)


def calibrate(raw: list[float], weights: list[float], target: float) -> tuple[list[float], float]:
    """Find the common log-odds shift c (bisection) so the weighted mean probability equals target."""
    if not raw:
        return [], 0.0
    total_w = sum(weights)
    logits = [_logit(x) for x in raw]

    def mean_p(c):
        return sum(w * _sigmoid(z + c) for z, w in zip(logits, weights)) / total_w

    lo, hi = -20.0, 20.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if mean_p(mid) < target:
            lo = mid
        else:
            hi = mid
    c = (lo + hi) / 2
    return [_sigmoid(z + c) for z in logits], c


def weighted_sample(ids: list[int], probs: list[float], k: int, seed_parts) -> set[int]:
    """Efraimidis-Spirakis weighted sampling without replacement (seeded, reproducible)."""
    rng = seeded_rng("attendees", *seed_parts)
    keys = []
    for i, p in zip(ids, probs):
        u = rng.random()
        keys.append((u ** (1.0 / max(p, 1e-9)), i))
    keys.sort(reverse=True)
    return {i for _, i in keys[:k]}


def run_participation(residents: list[dict], exposures: dict[int, dict], reactions: dict[int, dict], sdef) -> dict:
    """Return {id: {'eligible', 'participationScore', 'attendee'}} plus calibration info."""
    scope = [r for r in residents if in_scope(r, sdef)]
    raw = [raw_score(r, exposures[r["id"]]["score"], reactions[r["id"]]["wouldParticipateLLM"], sdef) for r in scope]
    weights = [float(r.get("weight", 1.0)) for r in scope]
    probs, shift = calibrate(raw, weights, sdef.turnoutTarget)
    k_exact = round(sdef.turnoutTarget * len(scope))
    k = min(len(scope), max(MIN_DISPLAYED, k_exact))
    chosen = weighted_sample([r["id"] for r in scope], [p * w for p, w in zip(probs, weights)], k, (sdef.id,))
    out = {r["id"]: {"eligible": False, "participationScore": 0.0, "attendee": False} for r in residents}
    for r, p in zip(scope, probs):
        out[r["id"]] = {"eligible": True, "participationScore": round(p, 4), "attendee": r["id"] in chosen}
    info = {
        "scopeSize": len(scope), "displayedAttendees": k, "exactTurnoutCount": k_exact,
        "logitShift": round(shift, 3), "alpha": ALPHA, "beta": BETA,
        "expectedParticipantsWeighted": round(sum(p * w for p, w in zip(probs, weights)), 2),
    }
    return {"byId": out, "info": info}


def method_note(info: dict, sdef) -> str:
    extra = ""
    if sdef.channel == "public_meeting" and sdef.site:
        extra = (f" For this public meeting, attendance also decays with distance from the site "
                 f"(-{DISTANCE_DECAY_PER_KM} log-odds per km beyond {DISTANCE_DECAY_FREE_KM:.0f} km, capped at -{DISTANCE_DECAY_MAX}).")
    floor = ""
    if info["displayedAttendees"] > info["exactTurnoutCount"]:
        floor = (f" The map shows {info['displayedAttendees']} sampled attendees (a floor of {MIN_DISPLAYED}; the turnout "
                 f"alone would give {info['exactTurnoutCount']}).")
    return (f"Participation: logit(p) = logit(participationBase or participationPropensity) + {ALPHA}·exposure + {BETA}·(LLM self-report − 0.5) + c, "
            f"with c = {info['logitShift']} calibrated so expected participants = {sdef.turnoutTarget:.2%} of the "
            f"{info['scopeSize']} residents in scope. The LLM self-report is only a weak rank modifier.{extra} "
            f"The highlighted attendees on the map are one seeded random draw; all attendee numbers use the "
            f"probability weights.{floor}")
