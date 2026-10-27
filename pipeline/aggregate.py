"""Aggregates: what everyone thinks vs what a consultation would hear, and who to go and talk to.

Views (all weighted by the raking weight w):
  everyone   all simulated residents of the study area
  eligible   residents in the scenario's scope (Paris electorate for votations, everyone for meetings)
  attendees  eligible residents weighted by w x p (p = calibrated participation probability)

Groups come from population.json, plus a few scenario-specific groups defined by computed exposure
or geography (scenario_groups below, e.g. "renters within 2 km of the site"). representationRatio =
(group share among attendees) / (group share in the whole population); below 1 means under-heard.

Consultation recommendations compare STAKE with VOICE: impactShare = the group's share of all
computed exposure (weight x exposure score), voiceShare = its share of the likely participants
(weight x participation probability). Groups are ranked by impactShare - voiceShare (they carry
more of the impact than they would have voices in the room); the proposal's own groups (up to
MAX_SCENARIO_RECS, e.g. renters near the site) are listed first. Groups need at least MIN_GROUP_N
residents. Each recommendation gets outreach channels from a fixed rule table based on who the
members are, plus hypotheses to test drawn from the group's most over-represented simulated themes.
"""
from __future__ import annotations

from collections import defaultdict

MIN_GROUP_N = 12
MAX_RECS = 6
MAX_SCENARIO_RECS = 2  # at most this many of the proposal's own groups (listed first)


def view_agg(pairs: list[tuple[int, float]], yes_range: tuple[float, float] | None = None) -> dict:
    """pairs = [(stance, weight)] -> ViewAgg."""
    tw = sum(w for _, w in pairs)
    if tw <= 0:
        agg = {"n": 0, "support": 0.0, "oppose": 0.0, "neutral": 0.0, "yesShare": 0.5, "meanStance": 0.0}
    else:
        sup = sum(w for s, w in pairs if s >= 1) / tw
        opp = sum(w for s, w in pairs if s <= -1) / tw
        agg = {"n": int(round(tw)), "support": round(sup, 4), "oppose": round(opp, 4),
               "neutral": round(max(0.0, 1 - sup - opp), 4),
               "yesShare": round(sup / (sup + opp), 4) if sup + opp > 0 else 0.5,
               "meanStance": round(sum(s * w for s, w in pairs) / tw, 3)}
    if yes_range is not None:
        agg["yesRange"] = [round(yes_range[0], 4), round(yes_range[1], 4)]
    return agg


def yes_share(pairs) -> float:
    return view_agg(pairs)["yesShare"]


def view_weights(r: dict, part: dict) -> dict[str, float]:
    w = float(r.get("weight", 1.0))
    pr = part[r["id"]]
    return {"everyone": w, "eligible": w if pr["eligible"] else 0.0,
            "attendees": w * pr["participationScore"] if pr["eligible"] else 0.0}


def compute_views(residents, stances: dict[int, int], part, yes_ranges: dict | None = None) -> dict:
    out = {}
    for view in ("everyone", "eligible", "attendees"):
        pairs = [(stances[r["id"]], view_weights(r, part)[view]) for r in residents]
        out[view] = view_agg([p for p in pairs if p[1] > 0], (yes_ranges or {}).get(view))
    return out


def uncertainty_ranges(residents, run_stances: dict[int, list[int]], main_stances: dict[int, int], part, full_views) -> dict:
    """yesRange per view: full-sample yes share shifted by the min/max deviation of each run from
    the main run, measured on the uncertainty subsample (same residents, same weights)."""
    sub = [r for r in residents if r["id"] in run_stances]
    if not sub:
        return {}
    n_runs = min(len(v) for v in run_stances.values())
    out = {}
    for view in ("everyone", "eligible", "attendees"):
        ws = {r["id"]: view_weights(r, part)[view] for r in sub}
        base_pairs = [(main_stances[i], w) for i, w in ws.items() if w > 0]
        if not base_pairs:
            continue
        base = yes_share(base_pairs)
        deltas = [0.0]
        for k in range(n_runs):
            deltas.append(yes_share([(run_stances[i][k], w) for i, w in ws.items() if w > 0]) - base)
        full = full_views[view]["yesShare"]
        out[view] = (max(0.0, full + min(deltas)), min(1.0, full + max(deltas)))
    return out


def scenario_groups(sdef, residents, exposures, ctx) -> list[dict]:
    """Groups that only make sense for this proposal, from COMPUTED exposure and geography (never the AI).
    The city-wide population groups dilute the people a local project really touches, so 'who to
    consult' also looks at these. Returns ScenarioGroup dicts (GroupDef + memberIds)."""
    groups = []

    def add(gid, label, description, members):
        if len(members) >= MIN_GROUP_N:
            groups.append({"id": gid, "label": label, "description": description,
                           "memberIds": sorted(r["id"] for r in members)})

    site = getattr(sdef, "site", None)
    if not site:  # with a site, the "near the site" groups below say the same thing more concretely
        add("most_affected", "Most affected residents (computed)",
            "Computed exposure 2 or 3 out of 3 for this proposal: from where they live and work and their imputed "
            "situation, not from the AI.",
            [r for r in residents if exposures[r["id"]]["score"] >= 2])
    if site:
        radius = max(site.get("ringsTiles") or [20])  # tiles (100 m each)
        km = radius * 0.1
        near = [r for r in residents
                if ((r["home"][0] + 0.5 - site["x"]) ** 2 + (r["home"][1] + 0.5 - site["y"]) ** 2) ** 0.5 <= radius]
        add("near_site", f"Neighbours within {km:g} km of the site",
            f"Home within {km:g} km of the site (computed from the map).", near)
        add("near_site_renters", f"Renters within {km:g} km of the site",
            f"Home within {km:g} km of the site and renting (tenure imputed from INSEE statistics).",
            [r for r in near if r["imputed"]["tenure"] != "owner"])
    if sdef.id == "paris_suv_2024":
        add("suburb_drivers_paris", "Suburban drivers who work in Paris",
            "Live outside Paris and drive to work in Paris (car and commute imputed): they park at visitor rates "
            "but cannot vote in a Paris votation.",
            [r for r in residents if not ctx.is_paris(r["districtIdx"]) and r["commuteMode"] == "car"
             and r.get("workDistrictIdx") and ctx.is_paris(r["workDistrictIdx"])])
    return groups


def with_scenario_groups(residents, groups) -> list[dict]:
    """Copies of the residents whose groupIds also list the scenario groups they belong to."""
    extra = defaultdict(list)
    for g in groups:
        for i in g["memberIds"]:
            extra[i].append(g["id"])
    return [{**r, "groupIds": list(r.get("groupIds") or []) + extra[r["id"]]} if r["id"] in extra else r
            for r in residents]


def by_district(residents, stances, part, exposures) -> list[dict]:
    groups: dict[int, list[dict]] = defaultdict(list)
    for r in residents:
        groups[r["districtIdx"]].append(r)
    out = []
    for idx in sorted(groups):
        rs = groups[idx]
        if idx == 0:
            continue
        ev = [(stances[r["id"]], float(r.get("weight", 1.0))) for r in rs]
        at = [(stances[r["id"]], view_weights(r, part)["attendees"]) for r in rs]
        tw = sum(w for _, w in ev) or 1
        out.append({
            "districtIdx": idx, "n": len(rs),
            "everyone": view_agg(ev),
            "attendees": view_agg([p for p in at if p[1] > 0]),
            "meanExposure": round(sum(exposures[r["id"]]["score"] * float(r.get("weight", 1.0)) for r in rs) / tw, 3),
        })
    return out


def by_group(residents, stances, part, exposures, group_defs) -> list[dict]:
    tot_w = sum(float(r.get("weight", 1.0)) for r in residents) or 1
    tot_att = sum(view_weights(r, part)["attendees"] for r in residents) or 1
    out = []
    for g in group_defs:
        rs = [r for r in residents if g["id"] in (r.get("groupIds") or [])]
        if not rs:
            continue
        gw = sum(float(r.get("weight", 1.0)) for r in rs)
        g_att = sum(view_weights(r, part)["attendees"] for r in rs)
        pop_share = gw / tot_w
        att_share = g_att / tot_att
        out.append({
            "groupId": g["id"], "label": g["label"], "n": len(rs),
            "everyone": view_agg([(stances[r["id"]], float(r.get("weight", 1.0))) for r in rs]),
            "representationRatio": round(att_share / pop_share, 3) if pop_share > 0 else 0.0,
            "meanExposure": round(sum(exposures[r["id"]]["score"] * float(r.get("weight", 1.0)) for r in rs) / gw, 3),
        })
    return out


# ---------------------------------------------------------------------------
# Outreach channels: a fixed rule table on who the group's members are
# ---------------------------------------------------------------------------

def _profile(rs: list[dict], part: dict, ctx) -> dict:
    n = len(rs) or 1
    return {
        "service": sum(r["occupationGroup"] in ("employes", "ouvriers") for r in rs) / n,
        "young": sum(r["age"] < 35 for r in rs) / n,
        "renter": sum(r["imputed"]["tenure"] != "owner" for r in rs) / n,
        "senior": sum(r["age"] >= 65 for r in rs) / n,
        "ineligible": sum(not part[r["id"]]["eligible"] for r in rs) / n,
        "non_eu": sum(r["imputed"]["nationality"] == "non_eu" for r in rs) / n,
        "kids": sum(r["household"] in ("couple_kids", "single_parent") for r in rs) / n,
        "social": sum(r["imputed"]["tenure"] == "social_renter" for r in rs) / n,
        "suburb": sum(not ctx.is_paris(r["districtIdx"]) for r in rs) / n,
        "car": sum(r["imputed"]["car"] for r in rs) / n,
        "cadres": sum(r["occupationGroup"] == "cadres" for r in rs) / n,
    }


CHANNEL_RULES = [
    # (test on the member profile, suggested channel)
    (lambda p: p["ineligible"] >= 0.5 and p["suburb"] >= 0.5,
     "Open the consultation beyond the voter roll: a joint session with the neighbouring towns / Métropole du Grand Paris"),
    (lambda p: p["non_eu"] >= 0.3,
     "Translated materials (Arabic, Chinese, Portuguese, English…) distributed through local associations and community centres"),
    (lambda p: p["service"] >= 0.5,
     "Pop-up stands at transit stations early morning (6–8 am) and evening (6–8 pm), when shift and service workers pass"),
    (lambda p: p["young"] >= 0.5 and p["renter"] >= 0.5,
     "Online consultation plus evening sessions after 7 pm, promoted on social media and through student/young-worker networks"),
    (lambda p: p["senior"] >= 0.5,
     "Daytime sessions at community and senior centres, with printed letters to the home"),
    (lambda p: p["kids"] >= 0.5,
     "School-gate stands and weekend sessions with childcare"),
    (lambda p: p["social"] >= 0.4,
     "Work with tenant associations and social landlords (bailleurs sociaux): stands in building lobbies"),
    (lambda p: p["suburb"] >= 0.5,
     "Stands at RER/metro interchanges used by commuters from the suburbs"),
    (lambda p: p["car"] >= 0.6,
     "Notices at car parks and on residents' parking permits, with a short online form"),
]
FALLBACK_CHANNEL = "A short quota-sampled online survey targeted at this group"


def channels_for(profile: dict) -> list[str]:
    out = [c for test, c in CHANNEL_RULES if test(profile)]
    return (out or [FALLBACK_CHANNEL])[:3]


def consult_recs(residents, stances, part, exposures, group_aggs, group_defs, assigned_themes: dict[int, str],
                 themes: list[dict], ctx, scenario_group_ids: set[str] | frozenset = frozenset()) -> list[dict]:
    theme_label = {t["id"]: t["label"] for t in themes}
    tot_w = sum(float(r.get("weight", 1.0)) for r in residents) or 1
    overall_theme = defaultdict(float)
    for r in residents:
        tid = assigned_themes.get(r["id"])
        if tid:
            overall_theme[tid] += float(r.get("weight", 1.0)) / tot_w
    defs = {g["id"]: g for g in group_defs}
    # Stake vs voice (see the module docstring).
    tot_exp = sum(exposures[r["id"]]["score"] * float(r.get("weight", 1.0)) for r in residents)
    tot_voice = sum(view_weights(r, part)["attendees"] for r in residents)
    members = {g["groupId"]: [r for r in residents if g["groupId"] in (r.get("groupIds") or [])] for g in group_aggs}
    shares = {}
    ranked = []
    for g in group_aggs:
        if g["n"] < MIN_GROUP_N or g["meanExposure"] <= 0:
            continue
        rs = members[g["groupId"]]
        impact = sum(exposures[r["id"]]["score"] * float(r.get("weight", 1.0)) for r in rs) / tot_exp if tot_exp > 0 else 0.0
        voice = sum(view_weights(r, part)["attendees"] for r in rs) / tot_voice if tot_voice > 0 else 0.0
        shares[g["groupId"]] = (impact, voice)
        priority = impact - voice if tot_exp > 0 else g["meanExposure"] * (1 - min(g["representationRatio"], 1.0))
        ranked.append((priority, g))
    ranked = [x for x in ranked if x[0] > 0.005]
    ranked.sort(key=lambda x: -x[0])
    # The proposal's own groups (e.g. renters near the site) come first: city-wide groups are bigger,
    # so they would otherwise always win on the absolute stake-voice gap.
    own = [x for x in ranked if x[1]["groupId"] in scenario_group_ids][:MAX_SCENARIO_RECS]
    ranked = own + [x for x in ranked if x[1]["groupId"] not in scenario_group_ids]
    recs = []
    for priority, g in ranked[:MAX_RECS]:
        rs = members[g["groupId"]]
        impact, voice = shares[g["groupId"]]
        prof = _profile(rs, part, ctx)
        # Districts where the group's IMPACT concentrates (top 3 by weight x exposure; a tiny share of the
        # plain weight breaks ties, so untouched districts come last).
        dc = defaultdict(float)
        for r in rs:
            w = float(r.get("weight", 1.0))
            dc[r["districtIdx"]] += w * exposures[r["id"]]["score"] + 0.01 * w
        districts = [d for d, _ in sorted(dc.items(), key=lambda x: -x[1])[:3]]
        # Hypotheses: the group's themes that are most over-represented vs everyone.
        gw = sum(float(r.get("weight", 1.0)) for r in rs) or 1
        gt = defaultdict(float)
        for r in rs:
            tid = assigned_themes.get(r["id"])
            if tid:
                gt[tid] += float(r.get("weight", 1.0)) / gw
        top = sorted(gt.items(), key=lambda x: -(x[1] - 0.5 * overall_theme.get(x[0], 0)))[:2]
        hyps = [f"Test whether “{theme_label.get(tid, tid)}” is a deciding concern: raised by {share:.0%} of this "
                f"group's simulated voices vs {overall_theme.get(tid, 0):.0%} overall." for tid, share in top if share > 0]
        names = [ctx.districts.get(d, {}).get("name", str(d)) for d in districts]
        ratio = g["representationRatio"]
        if ratio == 0:
            heard = ("would not be heard at all (outside the voter scope)" if prof["ineligible"] >= 0.99
                     else "would not be heard at all: none of them are among the likely participants")
        else:
            heard = f"would be {ratio:.2f}× as present among likely participants as in the population"
        why = (f"Carries {impact:.0%} of the computed impact but would be {voice:.0%} of likely participants. "
               f"Mean computed exposure {g['meanExposure']:.1f}/3 (everyone: "
               f"{sum(exposures[r['id']]['score'] * float(r.get('weight', 1.0)) for r in residents) / tot_w:.1f}); "
               f"this group {heard}. Simulated support {g['everyone']['yesShare']:.0%}. Concentrated in {', '.join(names)}. "
               f"Hypothesis from simulated voices, not evidence of public opinion.")
        recs.append({
            "groupId": g["groupId"], "label": defs.get(g["groupId"], {}).get("label", g["label"]), "why": why,
            "meanExposure": g["meanExposure"], "representationRatio": ratio,
            "impactShare": round(impact, 3), "voiceShare": round(voice, 3), "districts": districts,
            "channels": channels_for(prof), "hypotheses": hyps,
        })
    return recs
